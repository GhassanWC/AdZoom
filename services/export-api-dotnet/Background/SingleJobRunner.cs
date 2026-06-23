using ExportApi.Models;
using ExportApi.Services;

namespace ExportApi.Background;

/// <summary>
/// One-shot runner for Google Cloud Batch. Each Batch task is a fresh container
/// dedicated to a SINGLE export (EXPORT_JOB_ID + EXPORT_JOB_UID). It claims that
/// job, runs the full pipeline (download → render → upload → settle/fail), then
/// stops the host so the container EXITS — 0 on success, non-zero on failure.
/// There is no poll loop and no in-process reconciler: idle compute cost is zero
/// because nothing runs between exports. Stale jobs (a container that was OOM-killed
/// or preempted mid-render) are swept by the existing /api/cron/reconcile-exports
/// Cloud Scheduler, and Batch's own task retries re-claim them via forceReclaim.
/// </summary>
public sealed class SingleJobRunner(
    FirestoreService fs,
    JobPipeline pipeline,
    ExportOptions opts,
    IHostApplicationLifetime lifetime,
    ILogger<SingleJobRunner> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        // Startup watchdog: if we don't claim the job (→ rendering) within the
        // startup window, the container is wedged — fail the job + hard-exit so it
        // can't run (and bill) forever. Canceled the moment we claim, so it never
        // fires for a healthy render (which may legitimately take much longer).
        using var watchdogCts = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        var watchdog = StartStartupWatchdog(watchdogCts.Token);

        int exitCode;
        try
        {
            exitCode = await RunOnceAsync(stopping, watchdogCts);
        }
        catch (OperationCanceledException)
        {
            // SIGTERM (Batch task timeout / preemption) before we finished — leave
            // the job for re-claim and signal failure so Batch can retry the task.
            log.LogWarning("[batch:single-job] canceled before completion job={JobId}", opts.JobId);
            BatchLog.Line($"canceled before completion job={opts.JobId}");
            exitCode = 1;
        }
        catch (Exception ex)
        {
            log.LogError(ex, "[batch:single-job] fatal job={JobId}", opts.JobId);
            BatchLog.Error($"fatal job={opts.JobId}: {ex.Message}");
            // A crash BEFORE we claimed (e.g. credentials / Firestore error) leaves
            // the job pre-render. Fail it now (clear error + minute refund) instead of
            // waiting on the 10-min reconciler. No-op if a worker already claimed it.
            await TryFailIfNotStartedAsync("render_failed",
                "The export worker hit an error before rendering could start. Please try again.");
            exitCode = 1;
        }
        finally
        {
            // Run finished one way or another — stand the watchdog down.
            watchdogCts.Cancel();
            try { await watchdog; } catch { /* watchdog faults/cancels are non-fatal */ }
        }

        // Set the PROCESS exit code, then stop the host so app.Run() returns. The
        // exported MP4 / Firestore status was already written by the pipeline; this
        // code is purely Batch's success/failure signal for the task.
        Environment.ExitCode = exitCode;
        BatchLog.Line($"exit code={exitCode}");
        log.LogInformation("[batch:single-job] finished job={JobId} exitCode={Code} — stopping container", opts.JobId, exitCode);
        lifetime.StopApplication();
    }

    private async Task<int> RunOnceAsync(CancellationToken stopping, CancellationTokenSource watchdogCts)
    {
        var uid = opts.JobUid;
        var jobId = opts.JobId;
        if (string.IsNullOrWhiteSpace(uid) || string.IsNullOrWhiteSpace(jobId))
        {
            log.LogError("[batch:single-job] missing EXPORT_JOB_UID/EXPORT_JOB_ID — nothing to render");
            BatchLog.Error("missing EXPORT_JOB_UID/EXPORT_JOB_ID — nothing to render");
            return 1;
        }

        log.LogInformation("[batch:single-job] start uid={Uid} jobId={JobId} build={Build} chunked={Chunked}",
            uid, jobId, opts.BuildVersion, opts.ChunkedRenderEnabled);
        BatchLog.Line($"claiming Firestore job uid={uid} jobId={jobId}");

        // forceReclaim: this container is the SOLE designated worker for this job.
        // On a Batch retry the previous container is already dead, so re-claiming
        // even a fresh lease is safe and lets crash-recovery actually re-run.
        var (result, snap) = await fs.TryClaimAsync(uid, jobId, forceReclaim: true);
        BatchLog.Line($"claim result={result} job={jobId}");
        switch (result)
        {
            case FirestoreService.ClaimResult.Claimed when snap is not null:
                // Claimed → status is now "rendering"; stand the startup watchdog down.
                watchdogCts.Cancel();
                await pipeline.ProcessAsync(uid, jobId, snap, stopping);
                return await ResolveExitCodeAsync(uid, jobId);

            case FirestoreService.ClaimResult.Terminal:
                // Already finished (a duplicate Batch task, or the user retried into
                // a new job). Nothing to do — not a failure.
                log.LogInformation("[batch:single-job] job already terminal — nothing to do job={JobId}", jobId);
                return 0;

            case FirestoreService.ClaimResult.Leased:
                log.LogWarning("[batch:single-job] job is leased by another worker — exiting job={JobId}", jobId);
                return 0;

            default: // Missing
                log.LogError("[batch:single-job] job doc not found uid={Uid} job={JobId}", uid, jobId);
                BatchLog.Error($"job doc not found uid={uid} job={jobId}");
                return 1;
        }
    }

    /// <summary>
    /// Background watchdog that waits <see cref="ExportOptions.StartupTimeoutSeconds"/>
    /// then, if the job is STILL pre-render (never claimed), fails it with a clear
    /// error and hard-exits the process so a wedged container stops billing. It is
    /// canceled the instant the job is claimed, so a healthy (possibly long) render
    /// is never touched. Standing down on a claim that won a narrow race is explicit.
    /// </summary>
    private Task StartStartupWatchdog(CancellationToken ct)
    {
        var uid = opts.JobUid;
        var jobId = opts.JobId;
        var timeout = Math.Max(10, opts.StartupTimeoutSeconds);
        return Task.Run(async () =>
        {
            try { await Task.Delay(TimeSpan.FromSeconds(timeout), ct); }
            catch (OperationCanceledException) { return; } // claimed/finished in time

            if (string.IsNullOrWhiteSpace(uid) || string.IsNullOrWhiteSpace(jobId)) return;

            log.LogError("[batch:single-job] startup timeout — no render within {Timeout}s job={JobId}", timeout, jobId);
            BatchLog.Error($"startup-watchdog: no claim within {timeout}s — failing job + exiting");

            // CRITICAL: bound the remediation. The likeliest reason we're here is that
            // Firestore/credentials are unreachable — which is exactly what would also
            // HANG these remediation reads/writes. WaitAsync caps them so we ALWAYS
            // reach Environment.Exit and the Batch VM stops (instead of billing to the
            // BATCH_MAX_RUN_SECONDS ceiling). standDown is true ONLY when we positively
            // confirmed the render already started (so a healthy late claim isn't killed).
            var standDown = false;
            try
            {
                standDown = await RemediateStartupTimeoutAsync(uid!, jobId!)
                    .WaitAsync(TimeSpan.FromSeconds(Math.Min(30, timeout)));
            }
            catch (TimeoutException)
            {
                BatchLog.Error("startup-watchdog: remediation timed out (Firestore unreachable?) — exiting anyway");
            }
            catch (Exception ex)
            {
                BatchLog.Error($"startup-watchdog: remediation error: {ex.Message} — exiting anyway");
            }

            if (standDown)
            {
                BatchLog.Line("startup-watchdog: render already started — standing down");
                return;
            }

            BatchLog.Error("startup-watchdog: hard-exit(1) so the Batch VM stops billing");
            Environment.Exit(1);
        });
    }

    /// <summary>
    /// Watchdog remediation. Returns TRUE only when the render has positively already
    /// started (claimed → rendering/uploading) or the job is already terminal — i.e.
    /// the watchdog should STAND DOWN. Otherwise it atomically fails the still-pre-render
    /// job and returns FALSE so the caller hard-exits. A claim that won the race between
    /// the status read and the fail txn returns TRUE (FailIfNotStartedAsync no-ops), so
    /// a healthy late claim is never killed. Every Firestore call here is bounded by the
    /// caller's WaitAsync, so a wedged Firestore can't keep the container (and bill) alive.
    /// </summary>
    private async Task<bool> RemediateStartupTimeoutAsync(string uid, string jobId)
    {
        var status = await fs.GetJobStatusAsync(uid, jobId);
        if (status is JobFields.Rendering or JobFields.Uploading or JobFields.Ready
                   or JobFields.Failed or JobFields.Canceled)
            return true; // a worker claimed it / it finished — leave it alone
        if (status is null)
            return false; // doc gone but claim apparently hung → exit to stop the VM

        // Still pre-render on read. Fail ONLY if still pre-render at commit; if the
        // claim landed in between, FailIfNotStartedAsync returns false → stand down.
        var failed = await fs.FailIfNotStartedAsync(uid, jobId, JobFields.ErrStartupTimeout,
            "The export couldn't start in time (the render worker didn't begin within the startup window). Please try again.");
        return !failed;
    }

    /// <summary>Best-effort "fail the job if it never got claimed" — used by the
    /// fatal catch so a crash before render still finalizes the job (instead of
    /// leaving it pre-render for the reconciler). Guards uid/jobId; swallows errors.</summary>
    private async Task TryFailIfNotStartedAsync(string code, string message)
    {
        var uid = opts.JobUid;
        var jobId = opts.JobId;
        if (string.IsNullOrWhiteSpace(uid) || string.IsNullOrWhiteSpace(jobId)) return;
        try { await fs.FailIfNotStartedAsync(uid!, jobId!, code, message); }
        catch (Exception ex) { BatchLog.Error($"fail-if-not-started threw: {ex.Message}"); }
    }

    /// <summary>Map the terminal Firestore status the pipeline wrote into a process
    /// exit code. ProcessAsync swallows its own errors (it fails the job in
    /// Firestore), so we read the result back rather than catching here.</summary>
    private async Task<int> ResolveExitCodeAsync(string uid, string jobId)
    {
        var status = await fs.GetJobStatusAsync(uid, jobId);
        return status switch
        {
            JobFields.Ready => 0,
            JobFields.Canceled => 0, // user-initiated, not a system failure
            // failed, or still non-terminal (shutdown mid-render) → non-zero so the
            // Batch task is marked failed / eligible for a retry.
            _ => 1,
        };
    }
}
