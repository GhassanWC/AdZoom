using System.Text.Json;
using System.Text.Json.Serialization;

namespace ExportApi.Models;

/// <summary>
/// Body of POST /exports/enqueue. Sent server-to-server by the Next.js front
/// door (which verified the Firebase token and computed the recipe). `uid` is
/// trusted because the call is authenticated by the shared secret.
/// `serializedRecipe` is OPAQUE to C# — stored + forwarded to the render CLI.
/// </summary>
public sealed class EnqueueRequest
{
    public string? Uid { get; set; }
    /// <summary>SIGNAL mode: when set, the job was already created upstream (Next.js
    /// owns plan/minutes/creation) — just wake the runner for this jobId. When absent,
    /// the full fields below drive CREATE mode (C# reserves + creates the job).</summary>
    public string? JobId { get; set; }
    public string? ProjectId { get; set; }
    public string? ProjectTitle { get; set; }
    public string? SourceStoragePath { get; set; }
    public int OutputWidth { get; set; }
    public int OutputHeight { get; set; }
    public int Fps { get; set; }
    public string? Resolution { get; set; } // "1080p" | "4K"
    public double DurationSeconds { get; set; }
    [JsonPropertyName("serializedRecipe")] public JsonElement SerializedRecipe { get; set; }
}

/// <summary>Body of POST /exports/{jobId}/cancel — the trusted uid from the front door.</summary>
public sealed class CancelRequest
{
    public string? Uid { get; set; }
}

public sealed class EnqueueResponse
{
    public bool Ok { get; set; } = true;
    public string JobId { get; set; } = "";
    public int EstimatedExportMinutes { get; set; }
    public string Plan { get; set; } = "";
    public string Priority { get; set; } = "";
    public int Limit { get; set; }
}

public sealed class ApiError
{
    public string Error { get; set; } = "";
    public string? Kind { get; set; }
    public string? Actual { get; set; }
    public int? Remaining { get; set; }
    public int? Requested { get; set; }
}

/// <summary>UI/diagnostics view of a job — everything except renderRecipe, timestamps as epoch ms.</summary>
public sealed class JobView
{
    public string Id { get; set; } = "";
    public string? UserId { get; set; }
    public string? ProjectId { get; set; }
    public string? Status { get; set; }
    public string? Stage { get; set; }
    public double Progress { get; set; }
    public string? DownloadUrl { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
    public bool? CancelRequested { get; set; }
    public string[]? Warnings { get; set; }
    public Dictionary<string, object>? Preflight { get; set; }
    public int OutputWidth { get; set; }
    public int OutputHeight { get; set; }
    public int Fps { get; set; }
    public double DurationSeconds { get; set; }
    public int EstimatedExportMinutes { get; set; }
    public int? ConsumedExportMinutes { get; set; }
    public long? CreatedAt { get; set; }
    public long? UpdatedAt { get; set; }
    public long? StartedAt { get; set; }
    public long? CompletedAt { get; set; }
    public long? CanceledAt { get; set; }
}
