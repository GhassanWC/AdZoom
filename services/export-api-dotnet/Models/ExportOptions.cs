namespace ExportApi.Models;

/// <summary>
/// Effective runtime config, bound from environment variables (Cloud Run) with
/// appsettings.json fallbacks. Defaults mirror services/export-worker/src/config.ts.
/// </summary>
public sealed class ExportOptions
{
    /// <summary>GCP project id (Firestore + Storage). ADC supplies creds on Cloud Run.</summary>
    public string? ProjectId { get; set; }

    /// <summary>Firebase/GCS bucket for source + output objects (REQUIRED).</summary>
    public string? StorageBucket { get; set; }

    /// <summary>Shared secret the Next.js front door sends as `X-Internal-Secret`
    /// (REQUIRED). From `EXPORT_API_INTERNAL_SECRET` (or legacy `INTERNAL_SECRET`).</summary>
    public string? InternalSecret { get; set; }

    /// <summary>Render jobs processed concurrently per instance. 1 first.</summary>
    public int WorkerConcurrency { get; set; } = 1;

    /// <summary>How often the runner polls Firestore for claimable jobs (fallback to the signal).</summary>
    public int PollIntervalSeconds { get; set; } = 5;

    /// <summary>Heartbeat cadence — bump job.updatedAt while rendering.</summary>
    public int HeartbeatSeconds { get; set; } = 60;

    /// <summary>A non-terminal job whose updatedAt is older than this is re-claimable (crashed owner).</summary>
    public int HeartbeatStaleSeconds { get; set; } = 180;

    /// <summary>Reconciler: fail + release non-terminal jobs idle longer than this. MUST exceed HeartbeatStaleSeconds.</summary>
    public int ReconcileStaleSeconds { get; set; } = 600;

    /// <summary>How often the in-process reconciler sweeps.</summary>
    public int ReconcileIntervalSeconds { get; set; } = 120;

    /// <summary>How often the per-job cancel poll reads cancelRequested.</summary>
    public int CancelPollSeconds { get; set; } = 1;

    /// <summary>Single-job (Batch) startup watchdog: if the worker hasn't advanced
    /// the job out of queued/batch_submitted (i.e. claimed → rendering) within this
    /// many seconds of the container starting, it FAILS the job with a clear error
    /// and hard-exits so a wedged container can't run (and bill) forever. From
    /// BATCH_STARTUP_TIMEOUT_SECONDS / STARTUP_TIMEOUT_SECONDS; default 120s.</summary>
    public int StartupTimeoutSeconds { get; set; } = 120;

    // ── Render CLI (Node subprocess) ─────────────────────────────────────────
    /// <summary>Path to the node binary (set in the image).</summary>
    public string RenderCliNode { get; set; } = "node";

    /// <summary>Path to the bundled render CLI (services/export-worker/dist/cli.js, copied into the image).</summary>
    public string RenderCliEntry { get; set; } = "/app/render-cli/cli.js";

    // ── Encode knobs forwarded to the CLI ────────────────────────────────────
    public int X264Crf { get; set; } = 19;
    public string X264Preset { get; set; } = "veryfast";
    public bool NormalizeEnabled { get; set; } = true;
    public int NormalizeCrf { get; set; } = 18;
    public string NormalizePreset { get; set; } = "veryfast";

    // ── Deployment role (GCE VM worker vs Cloud Run control plane) ───────────
    /// <summary>"firestore-poll" → this instance runs the background poll/claim/
    /// render loop (the GCE VM worker). "disabled" → HTTP control plane only,
    /// never claims a job (set on Cloud Run so it can't grab a job and die
    /// mid-render). From EXPORT_WORKER_MODE; default "firestore-poll" (back-compat
    /// with the current Cloud Run deploy, which renders in-process today).</summary>
    public string WorkerMode { get; set; } = "firestore-poll";

    /// <summary>Whether to register the ExportRunner + Reconciler background
    /// services. False when WorkerMode=="disabled" or EXPORT_RUN_WORKER=false.</summary>
    public bool RunWorker { get; set; } = true;

    /// <summary>Log-tag prefix for lifecycle milestones — "vm-worker" in VM poll
    /// mode, "batch" in one-shot Batch mode, else "export". Used as a structured
    /// {Tag} field in log templates so each deploy emits greppable lifecycle lines.</summary>
    public string WorkerTag =>
        WorkerMode.Equals("firestore-poll", StringComparison.OrdinalIgnoreCase) ? "vm-worker"
        : WorkerMode.Equals("single-job", StringComparison.OrdinalIgnoreCase) ? "batch"
        : "export";

    // ── Single-job (Google Cloud Batch) mode ─────────────────────────────────
    /// <summary>When set (EXPORT_JOB_ID), the process claims EXACTLY this job,
    /// renders it, writes the terminal status, and EXITS (0 success / non-zero
    /// failure). This is the Cloud Batch execution model: one container per export,
    /// near-zero idle cost. No poll loop, no in-process reconciler — the existing
    /// /api/cron/reconcile-exports Cloud Scheduler sweeps stale jobs instead.</summary>
    public string? JobId { get; set; }

    /// <summary>Owning user id for the single job (EXPORT_JOB_UID). Required in
    /// single-job mode because jobs live at users/{uid}/exportJobs/{jobId}.</summary>
    public string? JobUid { get; set; }

    /// <summary>True when running as a one-shot Batch task (EXPORT_JOB_ID present or
    /// EXPORT_WORKER_MODE=single-job).</summary>
    public bool SingleJob { get; set; }

    // ── Parallel chunked render (one Batch job, N parallel chunk tasks) ───────
    /// <summary>"chunked" ⇒ this is one of N parallel chunk tasks (leader-merge);
    /// anything else ⇒ the proven single render. From EXPORT_RENDER_MODE.</summary>
    public string RenderMode { get; set; } = "single";

    /// <summary>This task's chunk index within the task group (Batch injects
    /// BATCH_TASK_INDEX). 0-based.</summary>
    public int TaskIndex { get; set; }

    /// <summary>Total tasks in the group (Batch injects BATCH_TASK_COUNT). With
    /// sharding this == WorkerCount.</summary>
    public int TaskCount { get; set; } = 1;

    /// <summary>Authoritative TOTAL chunk count from the submitter (EXPORT_CHUNK_COUNT)
    /// — do NOT recompute in the worker (must match the app's window math). This is
    /// the number of output chunks, NOT the task count.</summary>
    public int ChunkCount { get; set; }

    /// <summary>Number of SHARD WORKERS = Batch taskCount (EXPORT_WORKER_COUNT). Each
    /// worker renders chunks [workerIndex, workerIndex+WorkerCount, …]. Falls back to
    /// TaskCount when unset (older submitters).</summary>
    public int WorkerCount { get; set; }

    /// <summary>Merge-leader lease window: a merge claim older than this is
    /// re-claimable by a Batch-retried task (so a dead leader's merge can be
    /// re-driven). From EXPORT_MERGE_LEASE_SECONDS. MUST sit BETWEEN the worst-case
    /// merge time and the stale-reconcile window (~300s &lt; 600s cron) so a dead
    /// leader is re-claimed BEFORE the reconciler fails the whole job as stale.</summary>
    public int MergeLeaseSeconds { get; set; } = 300;

    /// <summary>Optional symmetric boundary padding (seconds) rendered on each side
    /// of a chunk window. Default 0 — boundaries are frame-deterministic +
    /// keyframe-aligned, so exact windows concat cleanly. From
    /// EXPORT_CHUNK_BOUNDARY_PADDING_SECONDS.</summary>
    public double ChunkBoundaryPaddingSeconds { get; set; }

    /// <summary>True when this process is a parallel chunk task (not the single path).</summary>
    public bool IsChunkedTask =>
        SingleJob && RenderMode.Equals("chunked", StringComparison.OrdinalIgnoreCase);

    // ── Chunked rendering (FLAGGED OFF until render-parity is verified) ───────
    /// <summary>Split long videos into independently-rendered chunks merged with
    /// ffmpeg. OFF by default (EXPORT_CHUNKED_RENDER) — it touches the parity-gated
    /// render core. When off, the whole video renders in one pass (today's path).</summary>
    public bool ChunkedRenderEnabled { get; set; } = false;

    /// <summary>Target chunk length in seconds (60–90 recommended).</summary>
    public int ChunkSeconds { get; set; } = 75;

    /// <summary>Only chunk videos longer than this many OUTPUT seconds. Shorter
    /// videos always render in a single pass.</summary>
    public int ChunkMinDurationSeconds { get; set; } = 180;

    /// <summary>Per-chunk render retries before the whole job fails.</summary>
    public int ChunkMaxRetries { get; set; } = 2;

    /// <summary>Local scratch dir for downloads + render output.</summary>
    public string WorkDir { get; set; } = Path.Combine(Path.GetTempPath(), "export-api");

    /// <summary>Build/version stamp baked into the image (git sha or tag), from
    /// BUILD_VERSION. Logged at startup + per job so a STALE VM image is obvious.</summary>
    public string BuildVersion { get; set; } = "unknown";

    /// <summary>Stable id of THIS worker, recorded on claimed/failed jobs so the
    /// queue is safe across MULTIPLE VM workers and a failed row can name the exact
    /// container that produced it. From EXPORT_WORKER_ID; falls back to
    /// hostname#pid (in Docker the hostname is the container id, so this uniquely
    /// identifies the VM/container + process).</summary>
    public string WorkerId { get; set; } = $"{Environment.MachineName}#{Environment.ProcessId}";

    /// <summary>Resolve from env with appsettings fallback; env wins (Cloud Run sets env).</summary>
    public static ExportOptions Load(IConfiguration config)
    {
        string? Env(params string[] keys) =>
            keys.Select(Environment.GetEnvironmentVariable).FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));
        int EnvInt(string key, int fallback) =>
            int.TryParse(Environment.GetEnvironmentVariable(key), out var v) ? v : fallback;
        bool EnvBool(string key, bool fallback) =>
            Environment.GetEnvironmentVariable(key) is { } s ? s == "1" || s.Equals("true", StringComparison.OrdinalIgnoreCase) : fallback;

        var o = new ExportOptions();
        config.GetSection("Export").Bind(o);

        o.ProjectId = Env("GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "NEXT_PUBLIC_FIREBASE_PROJECT_ID") ?? o.ProjectId;
        o.StorageBucket = Env("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET") ?? o.StorageBucket;
        o.InternalSecret = Env("EXPORT_API_INTERNAL_SECRET", "INTERNAL_SECRET") ?? o.InternalSecret;
        o.WorkerConcurrency = EnvInt("WORKER_CONCURRENCY", o.WorkerConcurrency);
        o.PollIntervalSeconds = EnvInt("POLL_INTERVAL_SECONDS", o.PollIntervalSeconds);
        o.HeartbeatSeconds = EnvInt("HEARTBEAT_SECONDS", o.HeartbeatSeconds);
        o.StartupTimeoutSeconds = EnvInt("BATCH_STARTUP_TIMEOUT_SECONDS",
            EnvInt("STARTUP_TIMEOUT_SECONDS", o.StartupTimeoutSeconds));
        o.HeartbeatStaleSeconds = EnvInt("HEARTBEAT_STALE_SECONDS", o.HeartbeatStaleSeconds);
        o.ReconcileStaleSeconds = EnvInt("RECONCILE_STALE_SECONDS", o.ReconcileStaleSeconds);
        o.ReconcileIntervalSeconds = EnvInt("RECONCILE_INTERVAL_SECONDS", o.ReconcileIntervalSeconds);
        o.RenderCliNode = Env("RENDER_CLI_NODE") ?? o.RenderCliNode;
        o.RenderCliEntry = Env("RENDER_CLI_ENTRY") ?? o.RenderCliEntry;
        o.X264Crf = EnvInt("WORKER_X264_CRF", o.X264Crf);
        o.X264Preset = Env("WORKER_X264_PRESET") ?? o.X264Preset;
        o.NormalizeEnabled = EnvBool("WORKER_NORMALIZE_ENABLED", o.NormalizeEnabled);
        o.NormalizeCrf = EnvInt("WORKER_NORMALIZE_CRF", o.NormalizeCrf);
        o.NormalizePreset = Env("WORKER_NORMALIZE_PRESET") ?? o.NormalizePreset;
        o.BuildVersion = Env("BUILD_VERSION") ?? o.BuildVersion;
        o.WorkerId = Env("EXPORT_WORKER_ID") ?? o.WorkerId;
        o.WorkerMode = (Env("EXPORT_WORKER_MODE") ?? o.WorkerMode).Trim().ToLowerInvariant();

        // ── Single-job (Batch) mode ──────────────────────────────────────────
        o.JobId = Env("EXPORT_JOB_ID");
        o.JobUid = Env("EXPORT_JOB_UID");
        o.SingleJob = !string.IsNullOrWhiteSpace(o.JobId)
                      || o.WorkerMode.Equals("single-job", StringComparison.OrdinalIgnoreCase);
        if (o.SingleJob)
        {
            o.WorkerMode = "single-job";
            // Batch tasks are short-lived; heartbeat every 30s (requirement) so a
            // wedged container is flagged stale sooner. An explicit HEARTBEAT_SECONDS
            // still wins.
            o.HeartbeatSeconds = EnvInt("HEARTBEAT_SECONDS", 30);
        }

        // ── Chunked render flag (off by default) ─────────────────────────────
        o.ChunkedRenderEnabled = EnvBool("EXPORT_CHUNKED_RENDER", o.ChunkedRenderEnabled);
        o.ChunkSeconds = EnvInt("EXPORT_CHUNK_SECONDS", o.ChunkSeconds);
        o.ChunkMinDurationSeconds = EnvInt("EXPORT_CHUNK_MIN_SECONDS", o.ChunkMinDurationSeconds);
        o.ChunkMaxRetries = EnvInt("EXPORT_CHUNK_MAX_RETRIES", o.ChunkMaxRetries);

        // ── Parallel chunked render (one Batch job, N parallel tasks) ─────────
        o.RenderMode = (Env("EXPORT_RENDER_MODE") ?? o.RenderMode).Trim().ToLowerInvariant();
        o.TaskIndex = EnvInt("BATCH_TASK_INDEX", o.TaskIndex);
        o.TaskCount = EnvInt("BATCH_TASK_COUNT", o.TaskCount);
        o.ChunkCount = EnvInt("EXPORT_CHUNK_COUNT", o.ChunkCount);
        o.WorkerCount = EnvInt("EXPORT_WORKER_COUNT", o.WorkerCount);
        o.MergeLeaseSeconds = EnvInt("EXPORT_MERGE_LEASE_SECONDS", o.MergeLeaseSeconds);
        if (double.TryParse(Environment.GetEnvironmentVariable("EXPORT_CHUNK_BOUNDARY_PADDING_SECONDS"),
                System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var pad))
            o.ChunkBoundaryPaddingSeconds = Math.Max(0, pad);

        // Don't run the poll loop / reconciler when in single-job mode, when
        // explicitly disabled (Cloud Run control plane), or EXPORT_RUN_WORKER=false.
        o.RunWorker = !o.SingleJob
                      && !o.WorkerMode.Equals("disabled", StringComparison.OrdinalIgnoreCase)
                      && EnvBool("EXPORT_RUN_WORKER", true);
        return o;
    }
}
