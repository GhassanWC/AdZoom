namespace ExportApi.Services;

/// <summary>
/// Raw, auto-flushed stdout logging tagged <c>[batch-worker]</c> for the one-shot
/// Google Cloud Batch lifecycle.
///
/// Why not just ILogger? The structured <c>AddJsonConsole</c> provider emits each
/// line as JSON, which Cloud Logging ingests as a <c>jsonPayload</c> — so a query
/// like <c>textPayload:"batch:single-job"</c> matches NOTHING, which is exactly
/// why the Batch worker "had no useful logs". These writes go straight to
/// <see cref="Console.Out"/> as plain text (a <c>textPayload</c> entry) and flush
/// immediately, so the container's progress is visible in Cloud Logging within
/// seconds of the task entering RUNNING — even if DI, the logger, or Google ADC
/// never finish initializing.
/// </summary>
public static class BatchLog
{
    /// <summary>Write one auto-flushed <c>[batch-worker] {message}</c> line to stdout.</summary>
    public static void Line(string message)
    {
        Console.WriteLine($"[batch-worker] {message}");
        Console.Out.Flush();
    }

    /// <summary>Write one auto-flushed <c>[batch-worker] {message}</c> line to stderr
    /// (for failures, so they surface at ERROR severity in Cloud Logging).</summary>
    public static void Error(string message)
    {
        Console.Error.WriteLine($"[batch-worker] {message}");
        Console.Error.Flush();
    }
}
