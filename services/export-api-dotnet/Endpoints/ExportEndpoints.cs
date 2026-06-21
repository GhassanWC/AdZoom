using System.Text.Json;
using ExportApi.Models;
using ExportApi.Services;

namespace ExportApi.Endpoints;

public static class ExportEndpoints
{
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);

    /// <summary>Structured 4xx body the Next.js front door can log: { code, reason, uid, jobId }.</summary>
    private static IResult Fail(int status, string code, string reason, string? uid, string? jobId) =>
        Results.Json(new { code, reason, uid, jobId }, statusCode: status);

    /// <summary>Read a string property by its EXACT key (Next.js sends camelCase uid/jobId).</summary>
    private static string? Str(JsonElement el, string prop) =>
        el.ValueKind == JsonValueKind.Object &&
        el.TryGetProperty(prop, out var v) &&
        v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    public static void MapExportEndpoints(this WebApplication app)
    {
        // Liveness — cheap, no Firestore. Cloud Run health-check target.
        app.MapGet("/health", () => Results.Text("ok"));

        // Create + reserve a job, return immediately. NEVER renders in-request.
        // The body is parsed HERE (not via minimal-API model binding) so no
        // binding quirk can swallow uid/jobId, and every 4xx logs the exact
        // reason + mode + uid + jobId and returns { code, reason, uid, jobId }.
        app.MapPost("/exports/enqueue", async (HttpContext ctx, FirestoreService fs, JobSignal signal, ILoggerFactory lf) =>
        {
            var log = lf.CreateLogger("export.enqueue");

            string raw;
            using (var reader = new StreamReader(ctx.Request.Body))
                raw = await reader.ReadToEndAsync();

            JsonElement root;
            try
            {
                using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(raw) ? "{}" : raw);
                root = doc.RootElement.Clone();
            }
            catch (Exception ex)
            {
                log.LogWarning("[export:enqueue] 400 bad_json len={Len} err={Err}", raw.Length, ex.Message);
                return Fail(StatusCodes.Status400BadRequest, "bad_json", "request body is not valid JSON", null, null);
            }

            var uid = Str(root, "uid");
            var jobId = Str(root, "jobId");
            var mode = !string.IsNullOrEmpty(jobId) ? "signal" : "create";
            log.LogInformation("[export:enqueue] mode={Mode} uid={Uid} jobId={JobId}", mode, uid ?? "(null)", jobId ?? "(null)");

            // ── SIGNAL mode — the job was already created by Next.js (which owns
            // plan + minutes + creation). Verify it exists and wake the runner;
            // the poller is the fallback if this is never called. Requires ONLY
            // uid + jobId — none of the create-mode fields.
            if (mode == "signal")
            {
                if (string.IsNullOrEmpty(uid))
                {
                    log.LogWarning("[export:enqueue] 400 bad_signal_payload uid missing jobId={JobId}", jobId);
                    return Fail(StatusCodes.Status400BadRequest, "bad_signal_payload", "uid is required in signal mode", uid, jobId);
                }
                var path = $"users/{uid}/exportJobs/{jobId}";
                var snap = await fs.GetJobAsync(uid!, jobId!);
                if (snap is null)
                {
                    log.LogWarning("[export:enqueue] 404 job_not_found path={Path}", path);
                    return Fail(StatusCodes.Status404NotFound, "job_not_found", $"no job at {path}", uid, jobId);
                }
                signal.Notify(uid!, jobId!);
                log.LogInformation("[export:enqueue] signaled ok path={Path}", path);
                return Results.Ok(new { ok = true, jobId, mode = "signal" });
            }

            // ── CREATE mode — standalone ownership (C# reserves + creates).
            EnqueueRequest req;
            try
            {
                req = root.Deserialize<EnqueueRequest>(WebJson) ?? new EnqueueRequest();
            }
            catch (Exception ex)
            {
                log.LogWarning("[export:enqueue] 400 bad_create_payload parse err={Err}", ex.Message);
                return Fail(StatusCodes.Status400BadRequest, "bad_create_payload", "could not parse create payload: " + ex.Message, uid, jobId);
            }
            var missing = new List<string>();
            if (string.IsNullOrEmpty(req.Uid)) missing.Add("uid");
            if (string.IsNullOrEmpty(req.ProjectId)) missing.Add("projectId");
            if (string.IsNullOrEmpty(req.SourceStoragePath)) missing.Add("sourceStoragePath");
            if (req.DurationSeconds <= 0) missing.Add("durationSeconds>0");
            if (req.Fps != 30 && req.Fps != 60) missing.Add("fps:30|60");
            if (req.SerializedRecipe.ValueKind != JsonValueKind.Object) missing.Add("serializedRecipe:{}");
            if (missing.Count > 0)
            {
                var reason = "missing/invalid create fields: " + string.Join(", ", missing) +
                    " (send { uid, jobId } for signal mode, or the full create body)";
                log.LogWarning("[export:enqueue] 400 bad_create_payload missing={Missing} uid={Uid}", string.Join(",", missing), req.Uid);
                return Fail(StatusCodes.Status400BadRequest, "bad_create_payload", reason, req.Uid, null);
            }

            try
            {
                var resp = await fs.EnqueueAsync(req);
                signal.Notify(req.Uid!, resp.JobId); // wake the runner now (poll is the fallback)
                log.LogInformation("[export:enqueue] {Verb} job={JobId} uid={Uid} deduped={Deduped}",
                    resp.Deduped ? "deduped" : "created", resp.JobId, req.Uid, resp.Deduped);
                return Results.Ok(resp);
            }
            catch (ExportAlreadyRunningException)
            {
                return Results.Json(new ApiError
                {
                    Error = "You already have an export running. Wait for it to finish or cancel it.",
                    Kind = "export_already_running",
                }, statusCode: StatusCodes.Status409Conflict);
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
