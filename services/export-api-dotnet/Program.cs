using ExportApi.Auth;
using ExportApi.Background;
using ExportApi.Endpoints;
using ExportApi.Models;
using ExportApi.Services;
using Google.Cloud.Firestore;
using Google.Cloud.Storage.V1;

// ── Earliest-possible diagnostics ─────────────────────────────────────────────
// Prove the container started and dump the run-defining env BEFORE any DI,
// Firebase/Firestore client, or Google ADC initialization. These are raw,
// auto-flushed stdout writes (a Cloud Logging `textPayload`, not the structured
// `jsonPayload` the ILogger provider emits) so they appear within seconds of a
// Batch task entering RUNNING even if the logger/credentials never come up.
static string EnvOr(string fallbackLabel, params string[] keys) =>
    keys.Select(Environment.GetEnvironmentVariable).FirstOrDefault(v => !string.IsNullOrWhiteSpace(v)) ?? fallbackLabel;

BatchLog.Line("container started");
BatchLog.Line($"build={EnvOr("(unset)", "BUILD_VERSION")}");
BatchLog.Line($"EXPORT_WORKER_MODE={EnvOr("(unset)", "EXPORT_WORKER_MODE")}");
BatchLog.Line($"EXPORT_RENDER_MODE={EnvOr("(unset)", "EXPORT_RENDER_MODE")}");
BatchLog.Line($"EXPORT_JOB_ID={EnvOr("(unset)", "EXPORT_JOB_ID")}");
BatchLog.Line($"EXPORT_JOB_UID={EnvOr("(unset)", "EXPORT_JOB_UID")}");
BatchLog.Line($"BATCH_TASK_INDEX={EnvOr("(unset)", "BATCH_TASK_INDEX")} BATCH_TASK_COUNT={EnvOr("(unset)", "BATCH_TASK_COUNT")}");
BatchLog.Line($"EXPORT_CHUNK_COUNT={EnvOr("(unset)", "EXPORT_CHUNK_COUNT")} EXPORT_WORKER_COUNT={EnvOr("(unset)", "EXPORT_WORKER_COUNT")}");
BatchLog.Line($"FIREBASE_PROJECT_ID={EnvOr("(unset)", "FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT")}");
BatchLog.Line($"FIREBASE_STORAGE_BUCKET={EnvOr("(unset)", "FIREBASE_STORAGE_BUCKET", "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET")}");

// ── Run-mode detection (mirrors ExportOptions.Load) ───────────────────────────
// single-job  ⇐ EXPORT_JOB_ID present OR EXPORT_WORKER_MODE=single-job. This is
// the one-shot Google Cloud Batch task: it must enter the shard/render path
// IMMEDIATELY and must NOT stand up Kestrel or a poll loop. We decide here, BEFORE
// constructing any host, so a misconfigured single-job task can fail fast and a
// healthy one never binds a port it doesn't use.
var workerModeRaw = (Environment.GetEnvironmentVariable("EXPORT_WORKER_MODE") ?? "").Trim().ToLowerInvariant();
var renderModeRaw = (Environment.GetEnvironmentVariable("EXPORT_RENDER_MODE") ?? "single").Trim().ToLowerInvariant();
var isSingleJob = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("EXPORT_JOB_ID"))
                  || workerModeRaw == "single-job";
var effectiveMode = isSingleJob ? "single-job" : (workerModeRaw.Length == 0 ? "firestore-poll" : workerModeRaw);
// req: a single, greppable line that names the path this container is taking,
// emitted before any heavy work (DI / credentials / render).
BatchLog.Line($"env detected mode={effectiveMode} renderMode={renderModeRaw}");

if (isSingleJob)
{
    // One-shot Google Cloud Batch task. NO web server, NO poll loop, NO reconciler:
    // a headless generic Host runs ONLY the SingleJobRunner, which claims/renders
    // its shard and stops the host so the container EXITS (0 success / non-zero
    // failure). Idle compute cost is zero — nothing runs between exports.
    await RunSingleJobAsync(args);
    return;
}

// ── Long-lived deployments (GCE VM poll / Cloud Run control plane) ─────────────
// These genuinely need the HTTP front door (health / enqueue-signal / cancel /
// status), so they run the full web host. Single-job mode never reaches here.
var builder = WebApplication.CreateBuilder(args);

// Structured JSON logs for Cloud Logging. NOTE: this emits each entry as a
// `jsonPayload` — the at-a-glance lifecycle milestones are ALSO mirrored to plain
// stdout via BatchLog (a `textPayload`) so they're greppable in single-job mode.
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(o => o.IncludeScopes = false);
builder.Logging.SetMinimumLevel(LogLevel.Information);

BatchLog.Line("loading config");

// Listen on Cloud Run's $PORT (default 8080).
var port = Environment.GetEnvironmentVariable("PORT") ?? "8080";
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

// Effective config (env wins, appsettings fallback).
var opts = ExportOptions.Load(builder.Configuration);
AddExportCore(builder.Services, opts);
BatchLog.Line($"config loaded singleJob={opts.SingleJob} mode={opts.WorkerMode} project={opts.ProjectId ?? "(ADC default)"} bucket={opts.StorageBucket ?? "(MISSING)"} heartbeat={opts.HeartbeatSeconds}s startupTimeout={opts.StartupTimeoutSeconds}s");

// Execution role (web host only):
//   • Firestore-poll (GCE VM): long-lived poll/claim/render loop + reconciler.
//   • disabled (Cloud Run control plane): HTTP endpoints only, never claims a job.
// (Single-job / Batch is handled by RunSingleJobAsync above — it never gets here.)
if (opts.RunWorker)
{
    builder.Services.AddHostedService<ExportRunner>();
    builder.Services.AddHostedService<Reconciler>();
}

// Give in-flight Firestore writes time to flush on SIGTERM — but NOT enough to
// wait out a render (a killed render's job stays "rendering" and is re-claimed).
builder.Services.Configure<HostOptions>(h => h.ShutdownTimeout = TimeSpan.FromSeconds(25));

var app = builder.Build();

// Startup config block + loud warnings (mirrors the Node worker's [worker:startup]).
LogStartup(app.Services.GetRequiredService<ILogger<Program>>(), opts);

app.UseMiddleware<InternalSecretMiddleware>();
app.MapExportEndpoints();

app.Run();

// ── Single-job (Google Cloud Batch) headless host ─────────────────────────────
// A generic Host (NO Kestrel) that runs ONLY the SingleJobRunner. The HTTP
// endpoints are intentionally absent: a Batch task has no ingress, polls its own
// `cancelRequested`, and writes status straight to Firestore — so a web server
// would only bind an unused port and muddy the "what is this container doing"
// signal. The runner stops the host the moment its one job is done → the process
// exits with the render's success/failure code.
static async Task RunSingleJobAsync(string[] args)
{
    var builder = Host.CreateApplicationBuilder(args);
    builder.Logging.ClearProviders();
    builder.Logging.AddJsonConsole(o => o.IncludeScopes = false);
    builder.Logging.SetMinimumLevel(LogLevel.Information);

    BatchLog.Line("loading config");
    var opts = ExportOptions.Load(builder.Configuration);
    BatchLog.Line($"config loaded singleJob={opts.SingleJob} mode={opts.WorkerMode} renderMode={opts.RenderMode} chunkedTask={opts.IsChunkedTask} chunkCount={opts.ChunkCount} workerCount={opts.WorkerCount} taskIndex={opts.TaskIndex} taskCount={opts.TaskCount} project={opts.ProjectId ?? "(ADC default)"} bucket={opts.StorageBucket ?? "(MISSING)"} heartbeat={opts.HeartbeatSeconds}s startupTimeout={opts.StartupTimeoutSeconds}s");

    // Fail fast on a misconfigured task. Missing required env is DETERMINISTIC —
    // a Batch retry on a fresh VM would fail identically — so we exit
    // ExitCodes.Fatal (42), which the job spec's lifecyclePolicy maps to FAIL_TASK
    // (no retry VM, no wasted billing). This runs BEFORE DI / credentials / render.
    var missing = MissingSingleJobEnv(opts);
    if (missing.Count > 0)
    {
        BatchLog.Error($"FATAL: single-job mode is missing required env: {string.Join(", ", missing)}. " +
                       $"Not entering the render path. Exiting {ExitCodes.Fatal}.");
        Environment.Exit(ExitCodes.Fatal); // [DoesNotReturn] — the lines below never run
    }

    AddExportCore(builder.Services, opts);
    builder.Services.AddHostedService<SingleJobRunner>();
    builder.Services.Configure<HostOptions>(h => h.ShutdownTimeout = TimeSpan.FromSeconds(25));

    var host = builder.Build();

    // Startup config block + loud warnings (mirrors the Node worker's [worker:startup]).
    LogStartup(host.Services.GetRequiredService<ILogger<Program>>(), opts);

    // Eagerly construct the Google clients so credential (ADC) init happens NOW,
    // with a clear log on both sides. A missing/denied SA is the most common Batch
    // misconfig; failing here surfaces it as an explicit startup error instead of a
    // silent hang deep inside the first Firestore call.
    BatchLog.Line("initializing Firebase/Google credentials (ADC)");
    try
    {
        host.Services.GetRequiredService<FirestoreDb>();
        host.Services.GetRequiredService<StorageClient>();
        BatchLog.Line("Firebase/Google credentials ready");
    }
    catch (Exception ex)
    {
        BatchLog.Error($"FATAL: Google credential/client init failed: {ex.Message}");
        // Non-zero exit so the Batch task is marked failed and the VM is torn down
        // (no idle billing). The stale-job reconciler refunds the minutes.
        Environment.Exit(1); // [DoesNotReturn]
    }

    await host.RunAsync();
}

// Shared service graph registered for BOTH hosts (web + single-job) so the render
// pipeline resolves and behaves identically regardless of how the process started.
static void AddExportCore(IServiceCollection services, ExportOptions opts)
{
    services.AddSingleton(opts);
    // Google clients via ADC (Cloud Run / Batch VM) or GOOGLE_APPLICATION_CREDENTIALS (local).
    services.AddSingleton(_ => new FirestoreDbBuilder { ProjectId = opts.ProjectId }.Build());
    services.AddSingleton(_ => StorageClient.Create());
    // Services + runners.
    services.AddSingleton<FirestoreService>();
    services.AddSingleton<StorageService>();
    services.AddSingleton<RenderSubprocess>();
    services.AddSingleton<JobPipeline>();
    services.AddSingleton<MergeStep>();
    services.AddSingleton<ChunkTaskRunner>();
    services.AddSingleton<JobSignal>();
    services.AddSingleton<LogBuffer>();
}

// Which submitter/runtime-injected env vars are REQUIRED for this single-job task
// but missing. Returns the names (not values) so the fail-fast log is actionable.
// Always required: EXPORT_JOB_ID + EXPORT_JOB_UID (the job lives at
// users/{uid}/exportJobs/{jobId}). A chunked shard task ALSO needs the fan-out the
// submitter injects (EXPORT_CHUNK_COUNT / EXPORT_WORKER_COUNT) and the per-task
// index Batch injects (BATCH_TASK_INDEX / BATCH_TASK_COUNT) — without the latter
// every shard would silently default to worker 0 and render the SAME chunks.
static List<string> MissingSingleJobEnv(ExportOptions o)
{
    var missing = new List<string>();
    if (string.IsNullOrWhiteSpace(o.JobId)) missing.Add("EXPORT_JOB_ID");
    if (string.IsNullOrWhiteSpace(o.JobUid)) missing.Add("EXPORT_JOB_UID");

    if (o.RenderMode.Equals("chunked", StringComparison.OrdinalIgnoreCase))
    {
        if (o.ChunkCount <= 0) missing.Add("EXPORT_CHUNK_COUNT(>0)");
        if (o.WorkerCount <= 0) missing.Add("EXPORT_WORKER_COUNT(>0)");
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("BATCH_TASK_INDEX")))
            missing.Add("BATCH_TASK_INDEX");
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("BATCH_TASK_COUNT")))
            missing.Add("BATCH_TASK_COUNT");
    }
    return missing;
}

static void LogStartup(ILogger logger, ExportOptions o)
{
    logger.LogInformation(
        "[export:startup] revision={Rev} bucket={Bucket} projectId={Project} normalizeEnabled={Norm} concurrency={Conc} heartbeat={Hb}s heartbeatStale={Hbs}s reconcileStale={Rs}s renderCli={Cli}",
        Environment.GetEnvironmentVariable("K_REVISION") ?? "(local)",
        o.StorageBucket ?? "(MISSING)",
        o.ProjectId ?? "(ADC default)",
        o.NormalizeEnabled, o.WorkerConcurrency, o.HeartbeatSeconds, o.HeartbeatStaleSeconds, o.ReconcileStaleSeconds,
        o.RenderCliEntry);

    // Deployment-role banner. On the GCE VM this is the [vm-worker:startup] line
    // the runbook tails to confirm the worker came up with ADC from the attached
    // service account (no key file).
    logger.LogInformation(
        "[{Tag}:startup] build={Build} mode={Mode} runWorker={Run} concurrency={Conc} pollEvery={Poll}s normalize={Norm} bucket={Bucket} project={Project} creds=ADC(metadata SA)",
        o.WorkerTag, o.BuildVersion, o.WorkerMode, o.RunWorker, o.WorkerConcurrency, o.PollIntervalSeconds, o.NormalizeEnabled,
        o.StorageBucket ?? "(MISSING)", o.ProjectId ?? "(ADC default)");

    if (string.IsNullOrWhiteSpace(o.InternalSecret))
        logger.LogWarning("[export:startup] ⚠ EXPORT_API_INTERNAL_SECRET is not set — ALL /exports/* requests will be rejected (401).");
    if (string.IsNullOrWhiteSpace(o.StorageBucket))
        logger.LogWarning("[export:startup] ⚠ NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set — downloads/uploads will fail.");
    if (o.ReconcileStaleSeconds <= o.HeartbeatStaleSeconds)
        logger.LogWarning("[export:startup] ⚠ ReconcileStaleSeconds ({R}) should exceed HeartbeatStaleSeconds ({H}).",
            o.ReconcileStaleSeconds, o.HeartbeatStaleSeconds);
    // Chunked-export invariant: the merge lease must expire BEFORE the stale-reconcile
    // window (the cron's 600s), so a dead merge leader's merge is re-claimed by a
    // Batch-retried task before the reconciler fails the whole job as stale.
    if (o.SingleJob && o.MergeLeaseSeconds >= o.ReconcileStaleSeconds)
        logger.LogWarning("[export:startup] ⚠ EXPORT_MERGE_LEASE_SECONDS ({M}) should be < the stale-reconcile window ({R}s) so a dead merge leader is re-claimable before the job is failed as stale.",
            o.MergeLeaseSeconds, o.ReconcileStaleSeconds);
}

// Exposed for completeness (top-level statements generate an internal Program).
public partial class Program { }
