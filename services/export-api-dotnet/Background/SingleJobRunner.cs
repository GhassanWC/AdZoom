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
        int exitCode;
        try
        {
            exitCode = await RunOnceAsync(stopping);
        }
        catch (OperationCanceledException)
        {
            // SIGTERM (Batch task timeout / preemption) before we finished — leave
            // the job for re-claim and signal failure so Batch can retry the task.
            log.LogWarning("[batch:single-job] canceled before completion job={JobId}", opts.JobId);
            exitCode = 1;
        }
        catch (Exception ex)
        {
            log.LogError(ex, "[batch:single-job] fatal job={JobId}", opts.JobId);
            exitCode = 1;
        }

        // Set the PROCESS exit code, then stop the host so app.Run() returns. The
        // exported MP4 / Firestore status was already written by the pipeline; this
        // code is purely Batch's success/failure signal for the task.
        Environment.ExitCode = exitCode;
        log.LogInformation("[batch:single-job] finished job={JobId} exitCode={Code} — stopping container", opts.JobId, exitCode);
        lifetime.StopApplication();
    }

    private async Task<int> RunOnceAsync(CancellationToken stopping)
    {
        var uid = opts.JobUid;
        var jobId = opts.JobId;
        if (string.IsNullOrWhiteSpace(uid) || string.IsNullOrWhiteSpace(jobId))
        {
            log.LogError("[batch:single-job] missing EXPORT_JOB_UID/EXPORT_JOB_ID — nothing to render");
            return 1;
        }

        log.LogInformation("[batch:single-job] start uid={Uid} jobId={JobId} build={Build} chunked={Chunked}",
            uid, jobId, opts.BuildVersion, opts.ChunkedRenderEnabled);

        // forceReclaim: this container is the SOLE designated worker for this job.
        // On a Batch retry the previous container is already dead, so re-claiming
        // even a fresh lease is safe and lets crash-recovery actually re-run.
        var (result, snap) = await fs.TryClaimAsync(uid, jobId, forceReclaim: true);
        switch (result)
        {
            case FirestoreService.ClaimResult.Claimed when snap is not null:
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
                return 1;
        }
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
