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
    /// <summary>Epoch-ms heartbeat the single-job (Batch) worker bumps every 30s
    /// (mirrors <see cref="LastHeartbeatAt"/>; kept as a distinct field for the
    /// Batch liveness contract).</summary>
    public const string HeartbeatAt = "heartbeatAt";
    public const string ExportPath = "exportPath";
    public const string SettingsHash = "settingsHash";

    // ── Sharded chunked render (one Batch job, workerCount shard tasks) ───────
    public const string RenderMode = "renderMode";
    /// <summary>TOTAL output chunks (NOT the task count).</summary>
    public const string ChunkCount = "chunkCount";
    public const string ChunkSeconds = "chunkSeconds";
    /// <summary>Shard worker count = Batch taskCount = parallelism.</summary>
    public const string WorkerCount = "workerCount";
    public const string ChunkParallelism = "chunkParallelism"; // deprecated alias of WorkerCount
    public const string ChunksCompleted = "chunksCompleted";
    public const string ChunksFailed = "chunksFailed";
    // ── Progress summary (worker writes after every completed chunk) ──────────
    public const string TotalChunks = "totalChunks";
    public const string CompletedChunks = "completedChunks";
    public const string FailedChunks = "failedChunks";
    public const string ActiveChunks = "activeChunks";
    public const string FramesRendered = "framesRendered";
    public const string FramesExpected = "framesExpected";
    public const string ProgressPercent = "progressPercent";
    public const string Phase = "phase";
    public const string ChunkedStartedAt = "chunkedStartedAt";
    public const string ChunkedCompletedAt = "chunkedCompletedAt";
    public const string MergeWorkerId = "mergeWorkerId";
    public const string MergeClaimedAt = "mergeClaimedAt";
    public const string MergeStartedAt = "mergeStartedAt";
    public const string MergeCompletedAt = "mergeCompletedAt";
    // Diagnostics
    public const string ColdStartSeconds = "coldStartSeconds";
    public const string ChunkRenderSeconds = "chunkRenderSeconds";
    public const string MergeSeconds = "mergeSeconds";
    public const string TotalSeconds = "totalSeconds";
    public const string MachineType = "machineType";
    public const string WorkerImage = "workerImage";
    /// <summary>Per-chunk completion marker subcollection under the job doc.</summary>
    public const string ChunksCollection = "chunks";

    // Usage ledger fields
    public const string CloudMinutesReserved = "cloudMinutesReserved";
    public const string CloudMinutesConsumed = "cloudMinutesConsumed";
    public const string LastCloudExportAt = "lastCloudExportAt";

    // ── Aligned error codes (shared with the Node CLI's errors.ts) ───────────
    public const string ErrStale = "stale";
    public const string ErrStartupTimeout = "startup_timeout";
    public const string ErrChunkFailed = "chunk_failed";
    public const string ErrMergeFailed = "merge_failed";
    public const string ErrAudioDecodeFailed = "audio_decode_failed";
    public const string ErrNormalizeFailed = "normalize_failed";
    public const string ErrRenderFailed = "render_failed";
    public const string ErrUploadFailed = "upload_failed";
    public const string ErrAudioMissingAfterRender = "audio_missing_after_render";
}
