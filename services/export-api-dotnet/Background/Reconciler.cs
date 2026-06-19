using ExportApi.Models;
using ExportApi.Services;

namespace ExportApi.Background;

/// <summary>
/// In-process stale-job reconciler (replaces the Cloud Scheduler cron). On an
/// interval it fails + releases minutes for non-terminal jobs whose `updatedAt`
/// is older than ReconcileStaleSeconds (a crashed owner that no retry re-claimed).
/// ReconcileStaleSeconds (10m) MUST stay above HeartbeatStaleSeconds (3m) so a
/// retry gets first chance to RESUME a crashed render before it's failed.
/// </summary>
public sealed class Reconciler(FirestoreService fs, ExportOptions opts, ILogger<Reconciler> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        if (opts.ReconcileStaleSeconds <= opts.HeartbeatStaleSeconds)
            log.LogWarning("[export:reconcile] misconfig: ReconcileStaleSeconds ({R}) should exceed HeartbeatStaleSeconds ({H})",
                opts.ReconcileStaleSeconds, opts.HeartbeatStaleSeconds);

        var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(30, opts.ReconcileIntervalSeconds)));
        try
        {
            // First sweep shortly after startup (recover jobs orphaned while down).
            do
            {
                try { await fs.ReconcileStaleAsync(batch: 200); }
                catch (Exception ex) { log.LogError(ex, "[export:reconcile] sweep failed"); }
            }
            while (await timer.WaitForNextTickAsync(stopping));
        }
        catch (OperationCanceledException) { /* shutdown */ }
    }
}
