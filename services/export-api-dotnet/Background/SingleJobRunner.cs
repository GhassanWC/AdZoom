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

            // Past the window without a claim. Either the worker is wedged
            // (credentials / Firestore / network) or — narrow race — the claim
            // just landed. Read the status to tell which.
            string? status = null;
            try { status = await fs.GetJobStatusAsync(uid!, jobId!); }
            catch (Exception ex) { BatchLog.Error($"startup-watchdog: status read threw: {ex.Message}"); }

            if (status is JobFields.Rendering or JobFields.Uploading or JobFields.Ready
                       or JobFields.Failed or JobFields.Canceled)
            {
                BatchLog.Line($"startup-watchdog: already progressed (status={status}) — standing down");
                return;
            }

            BatchLog.Error($"startup-watchdog: no render within {timeout}s (status={status ?? "unknown"}) — failing job + exiting");
            log.LogError("[batch:single-job] startup timeout — job never started rendering job={JobId} status={Status}", jobId, status ?? "unknown");

            var failed = false;
            try
            {
                failed = await fs.FailIfNotStartedAsync(uid!, jobId!, JobFields.ErrStartupTimeout,
                    "The export couldn't start in time (the render worker didn't begin within the startup window). Please try again.");
            }
            catch (Exception ex) { BatchLog.Error($"startup-watchdog: fail-write threw: {ex.Message}"); }

            // Hard-exit when we actually failed it, or when Firestore was unreachable
            // (status unknown) — either way the VM must stop. If the claim won the
            // race (status was pre-render but the fail txn found it rendering), leave
            // the live render alone.
            if (failed || status is null)
                Environment.Exit(1);
            else
                BatchLog.Line("startup-watchdog: claim won the race — standing down");
        });
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
