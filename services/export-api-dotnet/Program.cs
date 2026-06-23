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
BatchLog.Line($"EXPORT_JOB_ID={EnvOr("(unset)", "EXPORT_JOB_ID")}");
BatchLog.Line($"EXPORT_JOB_UID={EnvOr("(unset)", "EXPORT_JOB_UID")}");
BatchLog.Line($"FIREBASE_PROJECT_ID={EnvOr("(unset)", "FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT")}");
BatchLog.Line($"FIREBASE_STORAGE_BUCKET={EnvOr("(unset)", "FIREBASE_STORAGE_BUCKET", "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET")}");

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
builder.Services.AddSingleton(opts);
BatchLog.Line($"config loaded singleJob={opts.SingleJob} mode={opts.WorkerMode} project={opts.ProjectId ?? "(ADC default)"} bucket={opts.StorageBucket ?? "(MISSING)"} heartbeat={opts.HeartbeatSeconds}s startupTimeout={opts.StartupTimeoutSeconds}s");

// Google clients via ADC (Cloud Run) or GOOGLE_APPLICATION_CREDENTIALS (local).
builder.Services.AddSingleton(_ => new FirestoreDbBuilder { ProjectId = opts.ProjectId }.Build());
builder.Services.AddSingleton(_ => StorageClient.Create());

// Services + runner.
builder.Services.AddSingleton<FirestoreService>();
builder.Services.AddSingleton<StorageService>();
builder.Services.AddSingleton<RenderSubprocess>();
builder.Services.AddSingleton<JobPipeline>();
builder.Services.AddSingleton<JobSignal>();
builder.Services.AddSingleton<LogBuffer>();
// Execution role:
//   • Single-job (Google Cloud Batch): EXPORT_JOB_ID set ⇒ claim that ONE job,
//     render it, and EXIT (0 success / non-zero failure). No poll loop, no
//     reconciler — zero idle cost. Stale jobs are swept by the
//     /api/cron/reconcile-exports Cloud Scheduler.
//   • Firestore-poll (GCE VM): long-lived poll/claim/render loop + reconciler.
//   • disabled (Cloud Run control plane): HTTP endpoints only, never claims a job.
// The HTTP endpoints (health/enqueue-signal/cancel/status) stay available in all
// modes; the SingleJobRunner stops the host as soon as its one job is done.
if (opts.SingleJob)
{
    builder.Services.AddHostedService<SingleJobRunner>();
}
else if (opts.RunWorker)
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

// In single-job (Batch) mode, eagerly construct the Google clients so credential
// (ADC) init happens NOW, with a clear log on both sides. A missing/denied SA is
// the most common Batch misconfig; failing here surfaces it as an explicit
// startup error instead of a silent hang deep inside the first Firestore call.
if (opts.SingleJob)
{
    BatchLog.Line("initializing Firebase/Google credentials (ADC)");
    try
    {
        app.Services.GetRequiredService<FirestoreDb>();
        app.Services.GetRequiredService<StorageClient>();
        BatchLog.Line("Firebase/Google credentials ready");
    }
    catch (Exception ex)
    {
        BatchLog.Error($"FATAL: Google credential/client init failed: {ex.Message}");
        // Non-zero exit so the Batch task is marked failed and the VM is torn
        // down (no idle billing). The stale-job reconciler refunds the minutes.
        Environment.Exit(1);
    }
}

app.UseMiddleware<InternalSecretMiddleware>();
app.MapExportEndpoints();

app.Run();

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
}

// Exposed for completeness (top-level statements generate an internal Program).
public partial class Program { }
