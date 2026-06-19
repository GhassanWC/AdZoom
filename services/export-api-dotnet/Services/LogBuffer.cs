using System.Collections.Concurrent;

namespace ExportApi.Services;

/// <summary>
/// Per-job ring buffer of recent diagnostic lines (the render CLI's stderr +
/// pipeline milestones), served by GET /exports/{jobId}/logs. Best-effort and
/// in-memory only (empty if the job was processed by another instance — Cloud
/// Logging holds the durable copy). Bounded so a long render can't grow memory.
/// </summary>
public sealed class LogBuffer
{
    private const int MaxLinesPerJob = 400;
    private const int MaxJobs = 200;
    private readonly ConcurrentDictionary<string, Queue<string>> _byJob = new();
    private readonly ConcurrentQueue<string> _order = new();

    public void Append(string jobId, string line)
    {
        var q = _byJob.GetOrAdd(jobId, id =>
        {
            _order.Enqueue(id);
            // Evict the oldest job buffers to bound total memory.
            while (_order.Count > MaxJobs && _order.TryDequeue(out var old))
                _byJob.TryRemove(old, out _);
            return new Queue<string>();
        });
        lock (q)
        {
            q.Enqueue($"{DateTime.UtcNow:O} {line}");
            while (q.Count > MaxLinesPerJob) q.Dequeue();
        }
    }

    public IReadOnlyList<string> Get(string jobId) =>
        _byJob.TryGetValue(jobId, out var q) ? q.ToArray() : Array.Empty<string>();
}
