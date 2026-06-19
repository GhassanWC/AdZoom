using ExportApi.Models;
using Google.Cloud.Firestore;

namespace ExportApi.Services;

/// <summary>
/// Runs ONE claimed job end to end — the C# port of services/export-worker/src/
/// handler.ts:processJob, with the actual render delegated to the Node CLI.
/// Owns: download, heartbeat, cancel polling, NDJSON → Firestore patches,
/// upload, and the settle/fail transactions. Never renders in an HTTP request.
/// </summary>
public sealed class JobPipeline(
    FirestoreService fs,
    StorageService storage,
    RenderSubprocess render,
    LogBuffer logs,
    ExportOptions opts,
    ILogger<JobPipeline> log)
{
    /// <summary>Process a job the caller already CLAIMED (status flipped to rendering).</summary>
    public async Task ProcessAsync(string uid, string jobId, DocumentSnapshot claim, CancellationToken stopping)
    {
        var month = Str(claim, JobFields.MonthlyBucket) ?? FirestoreService.CurrentMonthKey();
        var estimate = (int)Long(claim, JobFields.EstimatedExportMinutes);
        var projectId = Str(claim, "projectId") ?? "";
        var sourcePath = Str(claim, JobFields.SourceStoragePath) ?? "";
        var outputPath = Str(claim, JobFields.OutputPath) ?? "";
        // Opaque recipe — read defensively (a null/non-map value would otherwise
        // throw; the render then fails cleanly via the CLI's preflight instead).
        Dictionary<string, object> recipe;
        try
        {
            recipe = claim.ContainsField("renderRecipe")
                ? claim.GetValue<Dictionary<string, object>>("renderRecipe")
                : new Dictionary<string, object>();
        }
        catch
        {
            recipe = new Dictionary<string, object>();
        }

        var workDir = Path.Combine(opts.WorkDir, jobId);
        Directory.CreateDirectory(workDir);
        var srcExt = Path.GetExtension(sourcePath);
        if (string.IsNullOrEmpty(srcExt)) srcExt = ".mp4";
        var srcFile = Path.Combine(workDir, "source" + srcExt);
        var outFile = Path.Combine(workDir, jobId + ".mp4");

        // Cancellation: user-cancel (cancelRequested/status) OR host shutdown.
        using var cancelCts = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        using var heartbeat = StartHeartbeat(uid, jobId, cancelCts.Token);
        using var cancelPoll = StartCancelPoll(uid, jobId, cancelCts);

        // Render outcome state (mutated by the NDJSON event handler).
        var warnings = new List<string>();
        Dictionary<string, object?>? preflight = null;
        var lastStage = "";
        var lastPct = -1;
        var lastLoggedPct = -1;
        var renderStart = DateTime.UtcNow;

        void OnEvent(RenderEvent ev)
        {
            switch (ev.Type)
            {
                case "preflight":
                    preflight = new Dictionary<string, object?>
                    {
                        ["videoCodec"] = ev.VideoCodec ?? "",
                        ["audioCodec"] = ev.AudioCodec ?? "",
                        ["risky"] = ev.Risky ?? false,
                        ["normalized"] = ev.Normalized ?? false,
                    };
                    log.LogInformation("[export:preflight] job={JobId} video={V} audio={A} risky={R} videoDecodable={VD} audioDecodable={AD} needsAudioDrop={ND}",
                        jobId, ev.VideoCodec, ev.AudioCodec, ev.Risky, ev.VideoDecodable, ev.AudioDecodable, ev.NeedsAudioDrop);
                    break;
                case "stage":
                    if (!string.IsNullOrEmpty(ev.Name) && ev.Name != lastStage)
                    {
                        lastStage = ev.Name!;
                        FireForget(fs.PatchAsync(uid, jobId, new() { [JobFields.Stage] = ev.Name }));
                        if (ev.Name == "rendering")
                            log.LogInformation("[export:render-start] job={JobId}", jobId);
                    }
                    break;
                case "progress":
                    if (ev.Value is { } v)
                    {
                        var pct = (int)Math.Round(v * 100);
                        if (pct != lastPct)
                        {
                            lastPct = pct;
                            FireForget(fs.PatchAsync(uid, jobId, new() { [JobFields.Progress] = v }));
                            if (pct - lastLoggedPct >= 25)
                            {
                                lastLoggedPct = pct;
                                log.LogInformation("[export:progress] job={JobId} pct={Pct}", jobId, pct);
                            }
                        }
                    }
                    break;
                case "first-frame":
                    log.LogInformation("[export:first-frame] job={JobId} afterMs={Ms}", jobId, ev.Ms);
                    break;
                case "warning":
                    if (!string.IsNullOrEmpty(ev.Message) && !warnings.Contains(ev.Message!))
                        warnings.Add(ev.Message!);
                    break;
            }
        }

        try
        {
            // ── Download ─────────────────────────────────────────────────────
            await fs.PatchAsync(uid, jobId, new() { [JobFields.Stage] = "downloading", [JobFields.Progress] = 0.02 });
            var dl = DateTime.UtcNow;
            log.LogInformation("[export:download] job={JobId} src={Src}", jobId, sourcePath);
            await storage.DownloadAsync(sourcePath, srcFile, cancelCts.Token);
            log.LogInformation("[export:download] job={JobId} done ms={Ms}", jobId, (int)(DateTime.UtcNow - dl).TotalMilliseconds);

            // ── Render (Node CLI subprocess) ─────────────────────────────────
            var spec = new Dictionary<string, object?>
            {
                ["sourcePath"] = srcFile,
                ["outputPath"] = outFile,
                ["serializedRecipe"] = recipe,
                ["crf"] = opts.X264Crf,
                ["preset"] = opts.X264Preset,
                ["normalizeCrf"] = opts.NormalizeCrf,
                ["normalizePreset"] = opts.NormalizePreset,
                ["normalizeEnabled"] = opts.NormalizeEnabled,
            };
            var outcome = await render.RunAsync(jobId, spec, workDir, OnEvent, cancelCts.Token);

            // ── Cancellation (user cancel or shutdown) — do NOT finalize ─────
            if (cancelCts.IsCancellationRequested || outcome.Canceled || outcome.ExitCode == 2)
            {
                // User cancel already set status=canceled + released minutes (the
                // cancel endpoint is authoritative). Shutdown leaves status
                // "rendering" → the heartbeat lease lets another instance
                // re-claim. Either way the runner must NOT touch the ledger.
                log.LogInformation("[export:canceled] job={JobId} (cancel or shutdown)", jobId);
                return;
            }

            // ── Failure ──────────────────────────────────────────────────────
            if (outcome.ExitCode != 0 || outcome.Done is null)
            {
                var code = outcome.Error?.Code ?? "render_failed";
                var msg = outcome.Error?.Message ?? "Something went wrong while exporting your video. Please try again.";
                await fs.FailAndReleaseAsync(uid, jobId, month, estimate, code, msg);
                log.LogError("[export:failed] job={JobId} code={Code}", jobId, code);
                return;
            }

            // ── Upload + settle ──────────────────────────────────────────────
            await fs.PatchAsync(uid, jobId, new() { [JobFields.Stage] = "uploading", [JobFields.Progress] = 0.98 });
            var downloadUrl = await storage.UploadMp4Async(outFile, outputPath, cancelCts.Token);

            var doneWarnings = outcome.Done.Warnings is { Length: > 0 } w
                ? w.Concat(warnings).Distinct().ToList()
                : warnings.Distinct().ToList();
            var settled = await fs.SettleSuccessAsync(uid, jobId, month, estimate, downloadUrl, doneWarnings, preflight);
            if (settled)
            {
                // Best-effort mirror onto the project (matches the Node worker).
                try { await fs.MirrorProjectExportUrlAsync(uid, projectId, downloadUrl); }
                catch (Exception ex) { log.LogWarning(ex, "[export] project exportUrl mirror failed job={JobId}", jobId); }
                log.LogInformation("[export:complete] job={JobId} minutes={Min}", jobId, estimate);
            }
            else
            {
                log.LogInformation("[export:complete] job={JobId} already finalized (skipped settle)", jobId);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutdown/cancel mid-download or mid-upload — leave for re-claim / cancel route.
            log.LogInformation("[export:canceled] job={JobId} (operation canceled)", jobId);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "[export:failed] job={JobId} unexpected", jobId);
            try
            {
                await fs.FailAndReleaseAsync(uid, jobId, month, estimate, "render_failed",
                    "Something went wrong while exporting your video. Please try again.");
            }
            catch (Exception inner) { log.LogError(inner, "[export] fail-finalize threw job={JobId}", jobId); }
        }
        finally
        {
            try { Directory.Delete(workDir, recursive: true); } catch { /* best effort */ }
        }
    }

    private IDisposable StartHeartbeat(string uid, string jobId, CancellationToken ct)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _ = Task.Run(async () =>
        {
            var timer = new PeriodicTimer(TimeSpan.FromSeconds(opts.HeartbeatSeconds));
            try
            {
                while (await timer.WaitForNextTickAsync(cts.Token))
                {
                    try { await fs.HeartbeatAsync(uid, jobId); }
                    catch (Exception ex) { log.LogWarning(ex, "[export] heartbeat failed job={JobId}", jobId); }
                }
            }
            catch (OperationCanceledException) { }
        });
        return cts;
    }

    private IDisposable StartCancelPoll(string uid, string jobId, CancellationTokenSource cancelCts)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(cancelCts.Token);
        _ = Task.Run(async () =>
        {
            var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(1, opts.CancelPollSeconds)));
            try
            {
                while (await timer.WaitForNextTickAsync(cts.Token))
                {
                    try
                    {
                        if (await fs.IsCancelRequestedAsync(uid, jobId))
                        {
                            log.LogInformation("[export:cancel] job={JobId} cancel requested", jobId);
                            cancelCts.Cancel();
                            return;
                        }
                    }
                    catch (Exception ex) { log.LogWarning(ex, "[export] cancel poll failed job={JobId}", jobId); }
                }
            }
            catch (OperationCanceledException) { }
        });
        return cts;
    }

    private void FireForget(Task t) =>
        t.ContinueWith(x => log.LogWarning(x.Exception, "[export] patch failed"),
            TaskContinuationOptions.OnlyOnFaulted);

    private static string? Str(DocumentSnapshot s, string f) =>
        s.ContainsField(f) ? s.GetValue<object>(f)?.ToString() : null;

    private static long Long(DocumentSnapshot s, string f) =>
        s.ContainsField(f) ? s.GetValue<object>(f) switch { long l => l, int i => i, double d => (long)d, _ => 0 } : 0;
}
