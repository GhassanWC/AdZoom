using ExportApi.Models;
using ExportApi.Services;

namespace ExportApi.Background;

/// <summary>
/// In-process export runner — discovers claimable jobs by POLLING Firestore (no
/// Cloud Tasks) plus an in-memory signal from enqueue for low latency, claims
/// them with the heartbeat-lease transaction, and renders. `WorkerConcurrency`
/// worker loops read the signal channel; the poller re-notifies queued/stale
/// jobs on an interval. Rendering happens HERE (background), never in a request.
///
/// On Cloud Run this requires `--no-cpu-throttling` (CPU between requests) and
/// `--min-instances=1` (keep the loop alive). Multiple instances are safe — the
/// claim transaction makes at most one win each job.
/// </summary>
public sealed class ExportRunner(
    JobSignal signal,
    FirestoreService fs,
    JobPipeline pipeline,
    ExportOptions opts,
    ILogger<ExportRunner> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        var workerCount = Math.Max(1, opts.WorkerConcurrency);
        log.LogInformation("[export:runner] starting workers={Workers} pollEvery={Poll}s", workerCount, opts.PollIntervalSeconds);

        var workers = Enumerable.Range(0, workerCount).Select(i => WorkerLoop(i, stopping)).ToArray();
        var poller = PollLoop(stopping);
        await Task.WhenAll(workers.Append(poller));
    }

    private async Task WorkerLoop(int index, CancellationToken stopping)
    {
        try
        {
            await foreach (var (uid, jobId) in signal.ReadAllAsync(stopping))
            {
                if (stopping.IsCancellationRequested) break;
                try { await ProcessOne(uid, jobId, stopping); }
                catch (OperationCanceledException) { /* shutdown */ }
                catch (Exception ex) { log.LogError(ex, "[export:runner] worker {Index} job {JobId} threw", index, jobId); }
            }
        }
        catch (OperationCanceledException) { /* shutdown */ }
    }

    private async Task PollLoop(CancellationToken stopping)
    {
        while (!stopping.IsCancellationRequested)
        {
            try
            {
                var jobs = await fs.FindClaimableAsync(limit: 20);
                if (jobs.Count > 0)
                    log.LogInformation("[{Tag}:poll] claimable={N}", opts.WorkerTag, jobs.Count);
                else
                    log.LogDebug("[{Tag}:poll] idle", opts.WorkerTag);
                foreach (var (uid, jobId) in jobs) signal.Notify(uid, jobId);
            }
            catch (Exception ex) { log.LogWarning(ex, "[{Tag}:poll] failed", opts.WorkerTag); }

            try { await Task.Delay(TimeSpan.FromSeconds(Math.Max(1, opts.PollIntervalSeconds)), stopping); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task ProcessOne(string uid, string jobId, CancellationToken stopping)
    {
        var (result, snap) = await fs.TryClaimAsync(uid, jobId);
        if (result == FirestoreService.ClaimResult.Claimed && snap is not null)
        {
            log.LogInformation("[{Tag}:claim] uid={Uid} jobId={JobId}", opts.WorkerTag, uid, jobId);
            await pipeline.ProcessAsync(uid, jobId, snap, stopping);
        }
        else
        {
            log.LogDebug("[export:skip] uid={Uid} jobId={JobId} reason={Reason}", uid, jobId, result);
        }
    }
}
