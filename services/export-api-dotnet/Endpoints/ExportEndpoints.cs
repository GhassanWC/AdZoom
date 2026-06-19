using ExportApi.Models;
using ExportApi.Services;

namespace ExportApi.Endpoints;

public static class ExportEndpoints
{
    public static void MapExportEndpoints(this WebApplication app)
    {
        // Liveness — cheap, no Firestore. Cloud Run health-check target.
        app.MapGet("/health", () => Results.Text("ok"));

        // Create + reserve a job, return immediately. NEVER renders in-request.
        app.MapPost("/exports/enqueue", async (EnqueueRequest req, FirestoreService fs, JobSignal signal, ILoggerFactory lf) =>
        {
            // SIGNAL mode — the job was already created by Next.js (which owns
            // plan + minutes + creation). Verify it exists and wake the runner;
            // the poller is the fallback if this is never called.
            if (!string.IsNullOrEmpty(req.JobId))
            {
                if (string.IsNullOrEmpty(req.Uid))
                    return Results.Json(new ApiError { Error = "uid required" }, statusCode: StatusCodes.Status400BadRequest);
                var snap = await fs.GetJobAsync(req.Uid!, req.JobId!);
                if (snap is null)
                    return Results.NotFound(new ApiError { Error = "job not found" });
                signal.Notify(req.Uid!, req.JobId!);
                return Results.Ok(new { ok = true, jobId = req.JobId, mode = "signal" });
            }

            // CREATE mode — standalone ownership (C# reserves + creates).
            if (string.IsNullOrEmpty(req.Uid) || string.IsNullOrEmpty(req.ProjectId) ||
                string.IsNullOrEmpty(req.SourceStoragePath) || req.DurationSeconds <= 0 ||
                (req.Fps != 30 && req.Fps != 60) ||
                req.SerializedRecipe.ValueKind != System.Text.Json.JsonValueKind.Object)
            {
                return Results.Json(new ApiError
                {
                    Error = "Body must include { uid, projectId, sourceStoragePath, fps:30|60, durationSeconds>0, serializedRecipe:{} }",
                }, statusCode: StatusCodes.Status400BadRequest);
            }

            try
            {
                var resp = await fs.EnqueueAsync(req);
                signal.Notify(req.Uid!, resp.JobId); // wake the runner now (poll is the fallback)
                return Results.Ok(resp);
            }
            catch (PlanNotAllowedException e)
            {
                return Results.Json(new ApiError
                {
                    Error = "Cloud MP4 export requires a Pro or Creator plan.",
                    Kind = "cloud_export_requires_paid",
                    Actual = e.Actual,
                }, statusCode: StatusCodes.Status402PaymentRequired);
            }
            catch (TierRequiresProException e)
            {
                return Results.Json(new ApiError
                {
                    Error = "4K and 60fps exports require a Pro or Creator plan.",
                    Kind = "tier_requires_pro",
                    Actual = e.Actual,
                }, statusCode: StatusCodes.Status402PaymentRequired);
            }
            catch (MinutesExhaustedException e)
            {
                return Results.Json(new ApiError
                {
                    Error = $"Not enough cloud export minutes left this month (need {e.Requested}, have {e.Remaining}).",
                    Kind = "cloud_minutes_exhausted",
                    Remaining = e.Remaining,
                    Requested = e.Requested,
                    Actual = e.Plan,
                }, statusCode: StatusCodes.Status429TooManyRequests);
            }
            catch (Exception ex)
            {
                // Unexpected (e.g. Firestore unavailable) — return the typed contract, not a raw 500 body.
                lf.CreateLogger("export.enqueue").LogError(ex, "enqueue failed uid={Uid}", req.Uid);
                return Results.Json(new ApiError { Error = "Couldn't queue the export. Please try again." },
                    statusCode: StatusCodes.Status500InternalServerError);
            }
        });

        // Authoritative cancel: release minutes + set canceled (idempotent).
        app.MapPost("/exports/{jobId}/cancel", async (string jobId, CancelRequest body, FirestoreService fs) =>
        {
            if (string.IsNullOrEmpty(body.Uid))
                return Results.Json(new ApiError { Error = "uid required" }, statusCode: StatusCodes.Status400BadRequest);
            var state = await fs.CancelAsync(body.Uid!, jobId);
            return state == "missing"
                ? Results.NotFound(new ApiError { Error = "job not found" })
                : Results.Ok(new { ok = true, state });
        });

        // Job status (diagnostics; the browser uses the Firestore subscription).
        app.MapGet("/exports/{jobId}", async (string jobId, string? uid, FirestoreService fs) =>
        {
            if (string.IsNullOrEmpty(uid))
                return Results.Json(new ApiError { Error = "uid query param required" }, statusCode: StatusCodes.Status400BadRequest);
            var snap = await fs.GetJobAsync(uid, jobId);
            return snap is null
                ? Results.NotFound(new ApiError { Error = "job not found" })
                : Results.Ok(fs.ToView(snap));
        });

        // Recent diagnostic log lines for the job (in-memory ring; Cloud Logging is durable).
        app.MapGet("/exports/{jobId}/logs", (string jobId, LogBuffer logs) =>
            Results.Ok(new { jobId, logs = logs.Get(jobId) }));
    }
}
