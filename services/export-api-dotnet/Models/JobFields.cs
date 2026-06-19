namespace ExportApi.Models;

/// <summary>Firestore field names + status/stage constants for `users/{uid}/exportJobs/{jobId}`
/// and `users/{uid}/usage/{YYYY-MM}`. Centralized to avoid typos across the transactions.</summary>
public static class JobFields
{
    // Status
    public const string Queued = "queued";
    public const string Rendering = "rendering";
    public const string Uploading = "uploading";
    public const string Ready = "ready";
    public const string Failed = "failed";
    public const string Canceled = "canceled";

    public static readonly string[] ActiveStatuses = { Queued, Rendering, Uploading };
    public static bool IsTerminal(string? status) => status is Ready or Failed or Canceled;

    // Job doc fields
    public const string Status = "status";
    public const string Stage = "stage";
    public const string Progress = "progress";
    public const string StartedAt = "startedAt";
    public const string UpdatedAt = "updatedAt";
    public const string CompletedAt = "completedAt";
    public const string CanceledAt = "canceledAt";
    public const string DownloadUrl = "downloadUrl";
    public const string ConsumedExportMinutes = "consumedExportMinutes";
    public const string EstimatedExportMinutes = "estimatedExportMinutes";
    public const string Warnings = "warnings";
    public const string Preflight = "preflight";
    public const string ErrorCode = "errorCode";
    public const string ErrorMessage = "errorMessage";
    public const string CancelRequested = "cancelRequested";
    public const string MonthlyBucket = "monthlyBucket";
    public const string SourceStoragePath = "sourceStoragePath";
    public const string OutputPath = "outputPath";

    // Usage ledger fields
    public const string CloudMinutesReserved = "cloudMinutesReserved";
    public const string CloudMinutesConsumed = "cloudMinutesConsumed";
    public const string LastCloudExportAt = "lastCloudExportAt";
}
