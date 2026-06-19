using System.Threading.Channels;

namespace ExportApi.Services;

/// <summary>
/// Low-latency wake-up from enqueue/cancel to the runner: an unbounded channel
/// of (uid, jobId). The runner also POLLS Firestore on an interval, so a missed
/// or cross-instance signal is still picked up — the signal is just an
/// optimization to avoid poll latency on same-instance enqueues.
/// </summary>
public sealed class JobSignal
{
    // Multi-reader: one reader per worker (WORKER_CONCURRENCY); each item goes to one worker.
    private readonly Channel<(string Uid, string JobId)> _ch =
        Channel.CreateUnbounded<(string, string)>(new UnboundedChannelOptions { SingleReader = false });

    public void Notify(string uid, string jobId) => _ch.Writer.TryWrite((uid, jobId));

    public IAsyncEnumerable<(string Uid, string JobId)> ReadAllAsync(CancellationToken ct) =>
        _ch.Reader.ReadAllAsync(ct);
}
