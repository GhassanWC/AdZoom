namespace ExportApi.Models;

/// <summary>Firestore field names + status/stage constants for `users/{uid}/exportJobs/{jobId}`
/// and `users/{uid}/usage/{YYYY-MM}`. Centralized to avoid typos across the transactions.</summary>
public static class JobFields
{
    // Status
    public const string Queued = "queued";
    public const string BatchSubmitted = "batch_submitted";
    public const string Rendering = "rendering";
    public const string Uploading = "uploading";
    public const string Ready = "ready";
    public const string Failed = "failed";
    public const string Canceled = "canceled";

    public static readonly string[] ActiveStatuses = { Queued, BatchSubmitted, Rendering, Uploading };
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
    public const string ProgressStage = "progressStage";
    public const string FailedAt = "failedAt";

    // Multi-VM attribution / liveness / dedup (mirrors the Node worker + Next.js create)
    public const string WorkerId = "workerId";
    public const string BuildVersion = "buildVersion";
    public const string ClaimedAt = "claimedAt";
    public const string LastHeartbeatAt = "lastHeartbeatAt";
    public const string ExportPath = "exportPath";
    public const string SettingsHash = "settingsHash";

    // Usage ledger fields
    public const string CloudMinutesReserved = "cloudMinutesReserved";
    public const string CloudMinutesConsumed = "cloudMinutesConsumed";
    public const string LastCloudExportAt = "lastCloudExportAt";

    // ── Aligned error codes (shared with the Node CLI's errors.ts) ───────────
    public const string ErrStale = "stale";
    public const string ErrAudioDecodeFailed = "audio_decode_failed";
    public const string ErrNormalizeFailed = "normalize_failed";
    public const string ErrRenderFailed = "render_failed";
    public const string ErrUploadFailed = "upload_failed";
    public const string ErrAudioMissingAfterRender = "audio_missing_after_render";
}
