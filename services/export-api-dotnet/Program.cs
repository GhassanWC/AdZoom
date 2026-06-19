using ExportApi.Auth;
using ExportApi.Background;
using ExportApi.Endpoints;
using ExportApi.Models;
using ExportApi.Services;
using Google.Cloud.Firestore;
using Google.Cloud.Storage.V1;

var builder = WebApplication.CreateBuilder(args);

// Structured JSON logs for Cloud Logging.
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(o => o.IncludeScopes = false);

// Listen on Cloud Run's $PORT (default 8080).
var port = Environment.GetEnvironmentVariable("PORT") ?? "8080";
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

// Effective config (env wins, appsettings fallback).
var opts = ExportOptions.Load(builder.Configuration);
builder.Services.AddSingleton(opts);

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
builder.Services.AddHostedService<ExportRunner>();
builder.Services.AddHostedService<Reconciler>();

// Give in-flight Firestore writes time to flush on SIGTERM — but NOT enough to
// wait out a render (a killed render's job stays "rendering" and is re-claimed).
builder.Services.Configure<HostOptions>(h => h.ShutdownTimeout = TimeSpan.FromSeconds(25));

var app = builder.Build();

// Startup config block + loud warnings (mirrors the Node worker's [worker:startup]).
LogStartup(app.Services.GetRequiredService<ILogger<Program>>(), opts);

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
