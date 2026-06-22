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
        var durationSeconds = Dbl(claim, "durationSeconds");
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
        var normalizingStarted = false;
        var normalizeReadyLogged = false;
        string? audioStatus = null;

        void OnEvent(RenderEvent ev)
        {
            switch (ev.Type)
            {
                case "preflight":
                    audioStatus = ev.AudioStatus ?? audioStatus;
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
                        FireForget(fs.PatchAsync(uid, jobId, new()
                        {
                            [JobFields.Stage] = ev.Name,
                            ["progressStage"] = ToProgressStage(ev.Name!),
                        }));
                        if (ev.Name == "normalizing")
                        {
                            normalizingStarted = true;
                            log.LogInformation("[{Tag}:normalize-start] job={JobId}", opts.WorkerTag, jobId);
                        }
                        else if (normalizingStarted && !normalizeReadyLogged)
                        {
                            // First stage AFTER normalizing (decoding/rendering) ⇒ the
                            // normalized-source.mp4 is ready and the render is starting.
                            normalizeReadyLogged = true;
                            log.LogInformation("[{Tag}:normalize-ready] job={JobId}", opts.WorkerTag, jobId);
                        }
                        if (ev.Name == "rendering")
                            log.LogInformation("[{Tag}:render-start] job={JobId}", opts.WorkerTag, jobId);
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
                                log.LogInformation("[{Tag}:progress] job={JobId} pct={Pct}", opts.WorkerTag, jobId, pct);
                            }
                        }
                    }
                    break;
                case "version":
                    // Proof the VM is running the latest render core (a stale image
                    // logs an old value or never emits this event at all).
                    log.LogInformation("[{Tag}:cli-version] job={JobId} cliVersion={V} build={B} node={N}",
                        opts.WorkerTag, jobId, ev.CliVersion, ev.Build, ev.Node);
                    break;
                case "render-input":
                    // Required pre-render contract: exactly what the renderer reads.
                    log.LogInformation("[{Tag}:render-input] job={JobId} input={In} normalizedFile={Norm} wasNormalizationRun={Ran} renderSource={Src}",
                        opts.WorkerTag, jobId, ev.InputFile, ev.NormalizedFile, ev.WasNormalizationRun, ev.RenderSource);
                    break;
                case "first-frame":
                    log.LogInformation("[export:first-frame] job={JobId} afterMs={Ms}", jobId, ev.Ms);
                    break;
                case "audio-verify":
                    // Pre-upload audio integrity (ffprobe on the final mp4). A
                    // `outputHasAudio=false` while `audioStatus=preserved` is the
                    // signal the CLI fails on as audio_missing_after_render.
                    log.LogInformation(
                        "[{Tag}:audio-verify] job={JobId} audioStatus={St} sourceAudio={SA} sourceCodec={SC} normalizedAudio={NA} outputAudio={OA} outputCodec={OC} outDur={OD} vidDur={VD} diff={Diff}",
                        opts.WorkerTag, jobId, ev.AudioStatus, ev.SourceHasAudio, ev.SourceAudioCodec,
                        ev.NormalizedHasAudio, ev.OutputHasAudio, ev.OutputAudioCodec,
                        ev.OutputDurationSec, ev.VideoDurationSec, ev.DurationDiffSec);
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
            await fs.PatchAsync(uid, jobId, new() { [JobFields.Stage] = "downloading", ["progressStage"] = "preparing", [JobFields.Progress] = 0.02 });
            var dl = DateTime.UtcNow;
            log.LogInformation("[export:download] job={JobId} src={Src}", jobId, sourcePath);
            await storage.DownloadAsync(sourcePath, srcFile, cancelCts.Token);
            log.LogInformation("[export:download] job={JobId} done ms={Ms}", jobId, (int)(DateTime.UtcNow - dl).TotalMilliseconds);

            // ── Chunked render (long videos) — OFF unless EXPORT_CHUNKED_RENDER ──
            // For videos longer than the threshold, render in independent chunks
            // (retried per-chunk) and concat. On success it uploads + settles and
            // RETURNS, so the monolithic block below stays the untouched default
            // path. It FALLS BACK to that block when chunking can't apply (too
            // short, or the timeline has cuts/speed → chunk_unsupported_timeline).
            if (opts.ChunkedRenderEnabled && durationSeconds > opts.ChunkMinDurationSeconds)
            {
                var chunkResult = await RunChunkedAsync(
                    uid, jobId, month, estimate, projectId, recipe, srcFile, outFile, outputPath,
                    workDir, durationSeconds, warnings, cancelCts);
                if (chunkResult != ChunkOutcome.FallBack) return; // done / failed / canceled — finalized inside
                log.LogInformation("[{Tag}:chunk-fallback] job={JobId} — rendering whole video in one pass", opts.WorkerTag, jobId);
            }

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
                log.LogInformation("[{Tag}:lease-released] job={JobId} (cancel or shutdown)", opts.WorkerTag, jobId);
                return;
            }

            // ── Failure ──────────────────────────────────────────────────────
            if (outcome.ExitCode != 0 || outcome.Done is null)
            {
                var code = outcome.Error?.Code ?? "render_failed";
                var msg = outcome.Error?.Message ?? "Something went wrong while exporting your video. Please try again.";
                await fs.FailAndReleaseAsync(uid, jobId, month, estimate, code, msg);
                log.LogError("[{Tag}:failed] job={JobId} code={Code}", opts.WorkerTag, jobId, code);
                return;
            }

            // ── Backstop: never finalize an export that skipped normalization ──
            // The CLI already guards (normalize_not_executed), but if a job somehow
            // reports done with normalized=false while normalization was enabled,
            // fail it rather than ship an export rendered from the raw source.
            if (opts.NormalizeEnabled && outcome.Done.Normalized == false)
            {
                await fs.FailAndReleaseAsync(uid, jobId, month, estimate, "normalize_not_executed",
                    "The export could not be prepared (normalization did not run). Please try again.");
                log.LogError("[{Tag}:failed] job={JobId} code=normalize_not_executed (done.normalized=false)", opts.WorkerTag, jobId);
                return;
            }

            // ── Upload + settle ──────────────────────────────────────────────
            await fs.PatchAsync(uid, jobId, new() { [JobFields.Stage] = "uploading", ["progressStage"] = "uploading", [JobFields.Progress] = 0.98 });
            log.LogInformation("[{Tag}:upload-start] job={JobId} uid={Uid} project={Pid} output={Out}", opts.WorkerTag, jobId, uid, projectId, outputPath);
            var downloadUrl = await storage.UploadMp4Async(outFile, outputPath, cancelCts.Token);

            // Reflect the post-normalization audio outcome on the stored preflight
            // (observability — `audio_removed_unsupported` already rides warnings[]).
            audioStatus = outcome.Done.AudioStatus ?? audioStatus;
            if (preflight is not null)
            {
                if (outcome.Done.Normalized is { } didNorm) preflight["normalized"] = didNorm;
                if (!string.IsNullOrEmpty(audioStatus)) preflight["audioStatus"] = audioStatus!;
            }

            var doneWarnings = outcome.Done.Warnings is { Length: > 0 } w
                ? w.Concat(warnings).Distinct().ToList()
                : warnings.Distinct().ToList();
            var settled = await fs.SettleSuccessAsync(uid, jobId, month, estimate, downloadUrl, doneWarnings, preflight);
            if (settled)
            {
                // Best-effort mirror onto the project (matches the Node worker).
                try { await fs.MirrorProjectExportUrlAsync(uid, projectId, downloadUrl); }
                catch (Exception ex) { log.LogWarning(ex, "[export] project exportUrl mirror failed job={JobId}", jobId); }
                log.LogInformation("[{Tag}:complete] job={JobId} minutes={Min} audio={Audio}", opts.WorkerTag, jobId, estimate, audioStatus ?? "(n/a)");
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
            log.LogInformation("[{Tag}:lease-released] job={JobId} (operation canceled)", opts.WorkerTag, jobId);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "[{Tag}:failed] job={JobId} unexpected", opts.WorkerTag, jobId);
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

    // ── Chunked render (flagged) ───────────────────────────────────────────────
    private enum ChunkOutcome { Done, Failed, Canceled, FallBack }

    /// <summary>
    /// Render a long video as independent OUTPUT-time chunks, retry each chunk on
    /// failure, concat into the final MP4, then upload + settle. Returns FallBack
    /// (doing nothing) when chunking can't apply — too few chunks, or the first
    /// chunk reports `chunk_unsupported_timeline` (cuts/speed) — so the caller runs
    /// the normal whole-video render instead. Done/Failed/Canceled are fully
    /// finalized here (status + ledger written), mirroring the monolithic path.
    /// </summary>
    private async Task<ChunkOutcome> RunChunkedAsync(
        string uid, string jobId, string month, int estimate, string projectId,
        Dictionary<string, object> recipe, string srcFile, string outFile, string outputPath,
        string workDir, double durationSeconds, List<string> warnings,
        CancellationTokenSource cancelCts)
    {
        var chunkLen = Math.Max(1, opts.ChunkSeconds);
        var chunkCount = (int)Math.Ceiling(durationSeconds / chunkLen);
        if (chunkCount <= 1) return ChunkOutcome.FallBack; // nothing to gain — render whole

        var normalizedPath = Path.Combine(workDir, "normalized-source.mp4");
        var chunkFiles = new List<string>();
        Dictionary<string, object?>? preflight = null;
        string? audioStatus = null;
        var normalizedRan = false;

        log.LogInformation("[{Tag}:chunk-start] job={JobId} duration={Dur}s chunks={N} chunkLen={Len}s",
            opts.WorkerTag, jobId, (int)durationSeconds, chunkCount, chunkLen);

        for (var i = 0; i < chunkCount; i++)
        {
            var startSec = i * chunkLen;
            var endSec = Math.Min((i + 1) * chunkLen, durationSeconds);
            var chunkOut = Path.Combine(workDir, $"chunk_{i:D3}.mp4");
            var first = i == 0;

            await fs.PatchAsync(uid, jobId, new()
            {
                [JobFields.Stage] = "rendering_chunks",
                ["progressStage"] = "rendering",
                ["chunkIndex"] = i + 1,
                ["chunkTotal"] = chunkCount,
                [JobFields.Progress] = (double)i / chunkCount,
            });

            var spec = new Dictionary<string, object?>
            {
                // Chunk 0 reads the original (and normalizes once → normalized-source.mp4);
                // later chunks read that normalized file. If normalization is globally
                // off, there is no normalized file, so every chunk reads the original.
                ["sourcePath"] = first || !opts.NormalizeEnabled ? srcFile : normalizedPath,
                ["outputPath"] = chunkOut,
                ["serializedRecipe"] = recipe,
                ["crf"] = opts.X264Crf,
                ["preset"] = opts.X264Preset,
                ["normalizeCrf"] = opts.NormalizeCrf,
                ["normalizePreset"] = opts.NormalizePreset,
                // Normalize ONCE (chunk 0) → normalized-source.mp4; later chunks
                // render straight from it (skip the expensive re-transcode).
                ["normalizeEnabled"] = first && opts.NormalizeEnabled,
                ["chunk"] = new Dictionary<string, object?> { ["startSec"] = startSec, ["endSec"] = endSec },
            };

            var lastOverallPct = -1;
            void OnChunkEvent(RenderEvent ev)
            {
                switch (ev.Type)
                {
                    case "preflight" when first:
                        audioStatus = ev.AudioStatus ?? audioStatus;
                        preflight = new Dictionary<string, object?>
                        {
                            ["videoCodec"] = ev.VideoCodec ?? "",
                            ["audioCodec"] = ev.AudioCodec ?? "",
                            ["risky"] = ev.Risky ?? false,
                            ["normalized"] = ev.Normalized ?? false,
                        };
                        break;
                    case "progress" when ev.Value is { } v:
                        // Map chunk-local 0..1 onto the overall job progress.
                        var overall = (i + Math.Clamp(v, 0, 1)) / chunkCount;
                        var pct = (int)Math.Round(overall * 100);
                        if (pct != lastOverallPct)
                        {
                            lastOverallPct = pct;
                            FireForget(fs.PatchAsync(uid, jobId, new() { [JobFields.Progress] = overall }));
                        }
                        break;
                    case "warning" when !string.IsNullOrEmpty(ev.Message) && !warnings.Contains(ev.Message!):
                        warnings.Add(ev.Message!);
                        break;
                }
            }

            RenderOutcome? outcome = null;
            var ok = false;
            for (var attempt = 0; attempt <= Math.Max(0, opts.ChunkMaxRetries); attempt++)
            {
                if (attempt > 0)
                    log.LogWarning("[{Tag}:chunk-retry] job={JobId} chunk={Idx}/{N} attempt={Att}",
                        opts.WorkerTag, jobId, i + 1, chunkCount, attempt + 1);

                outcome = await render.RunAsync(jobId, spec, workDir, OnChunkEvent, cancelCts.Token,
                    specName: $"spec-chunk-{i}.json");

                if (cancelCts.IsCancellationRequested || outcome.Canceled || outcome.ExitCode == 2)
                {
                    log.LogInformation("[export:canceled] job={JobId} (chunk {Idx})", jobId, i + 1);
                    return ChunkOutcome.Canceled;
                }
                // First chunk says this timeline can't be chunked → abandon chunking.
                if (first && outcome.Error?.Code == "chunk_unsupported_timeline")
                {
                    log.LogInformation("[{Tag}:chunk-unsupported] job={JobId} — timeline has cuts/speed", opts.WorkerTag, jobId);
                    return ChunkOutcome.FallBack;
                }
                if (outcome.ExitCode == 0 && outcome.Done is not null) { ok = true; break; }
                log.LogWarning("[{Tag}:chunk-fail] job={JobId} chunk={Idx}/{N} code={Code}",
                    opts.WorkerTag, jobId, i + 1, chunkCount, outcome.Error?.Code ?? "render_failed");
            }

            if (!ok)
            {
                var code = outcome?.Error?.Code ?? "render_failed";
                var msg = outcome?.Error?.Message ?? "Something went wrong while exporting your video. Please try again.";
                await fs.FailAndReleaseAsync(uid, jobId, month, estimate, code, msg);
                log.LogError("[{Tag}:failed] job={JobId} chunk={Idx}/{N} code={Code}", opts.WorkerTag, jobId, i + 1, chunkCount, code);
                return ChunkOutcome.Failed;
            }

            // Backstop on chunk 0 — never finalize an export that skipped normalization.
            if (first)
            {
                normalizedRan = outcome!.Done!.Normalized ?? false;
                audioStatus = outcome.Done.AudioStatus ?? audioStatus;
                if (opts.NormalizeEnabled && outcome.Done.Normalized == false)
                {
                    await fs.FailAndReleaseAsync(uid, jobId, month, estimate, "normalize_not_executed",
                        "The export could not be prepared (normalization did not run). Please try again.");
                    log.LogError("[{Tag}:failed] job={JobId} code=normalize_not_executed (chunk0)", opts.WorkerTag, jobId);
                    return ChunkOutcome.Failed;
                }
            }
            if (outcome!.Done!.Warnings is { Length: > 0 } cw)
                foreach (var w in cw) if (!warnings.Contains(w)) warnings.Add(w);

            chunkFiles.Add(chunkOut);
            log.LogInformation("[{Tag}:chunk-done] job={JobId} chunk={Idx}/{N}", opts.WorkerTag, jobId, i + 1, chunkCount);
        }

        // ── Merge ────────────────────────────────────────────────────────────
        await fs.PatchAsync(uid, jobId, new()
        {
            [JobFields.Stage] = "merging",
            ["progressStage"] = "merging",
            [JobFields.Progress] = 0.97,
        });
        log.LogInformation("[{Tag}:merge-start] job={JobId} chunks={N}", opts.WorkerTag, jobId, chunkFiles.Count);
        var concatSpec = new Dictionary<string, object?>
        {
            ["mode"] = "concat",
            ["inputs"] = chunkFiles,
            ["outputPath"] = outFile,
        };
        var concat = await render.RunAsync(jobId, concatSpec, workDir, _ => { }, cancelCts.Token, specName: "spec-concat.json");
        if (cancelCts.IsCancellationRequested || concat.Canceled || concat.ExitCode == 2)
            return ChunkOutcome.Canceled;
        if (concat.ExitCode != 0 || concat.Done is null)
        {
            var code = concat.Error?.Code ?? "concat_failed";
            await fs.FailAndReleaseAsync(uid, jobId, month, estimate, code,
                "Couldn't assemble the exported video. Please try again.");
            log.LogError("[{Tag}:failed] job={JobId} code={Code} (merge)", opts.WorkerTag, jobId, code);
            return ChunkOutcome.Failed;
        }

        // ── Upload + settle ──────────────────────────────────────────────────
        await fs.PatchAsync(uid, jobId, new() { [JobFields.Stage] = "uploading", ["progressStage"] = "uploading", [JobFields.Progress] = 0.98 });
        log.LogInformation("[{Tag}:upload-start] job={JobId} uid={Uid} project={Pid} output={Out} (chunked)", opts.WorkerTag, jobId, uid, projectId, outputPath);
        var downloadUrl = await storage.UploadMp4Async(outFile, outputPath, cancelCts.Token);

        if (preflight is not null)
        {
            preflight["normalized"] = normalizedRan;
            if (!string.IsNullOrEmpty(audioStatus)) preflight["audioStatus"] = audioStatus!;
        }
        var settled = await fs.SettleSuccessAsync(uid, jobId, month, estimate, downloadUrl, warnings.Distinct().ToList(), preflight);
        if (settled)
        {
            try { await fs.MirrorProjectExportUrlAsync(uid, projectId, downloadUrl); }
            catch (Exception ex) { log.LogWarning(ex, "[export] project exportUrl mirror failed job={JobId}", jobId); }
            log.LogInformation("[{Tag}:complete] job={JobId} minutes={Min} chunks={N} audio={Audio}",
                opts.WorkerTag, jobId, estimate, chunkFiles.Count, audioStatus ?? "(n/a)");
        }
        else
        {
            log.LogInformation("[export:complete] job={JobId} already finalized (skipped settle)", jobId);
        }
        return ChunkOutcome.Done;
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

    /// <summary>Map the raw worker stage to the friendly UI stage the dialog shows
    /// (download + normalize read as "preparing" so the bar is never frozen).</summary>
    private static string ToProgressStage(string stage) => stage switch
    {
        "queued" => "queued",
        "downloading" or "normalizing" => "preparing",
        "uploading" => "uploading",
        _ => "rendering", // decoding / rendering / encoding
    };

    private static string? Str(DocumentSnapshot s, string f) =>
        s.ContainsField(f) ? s.GetValue<object>(f)?.ToString() : null;

    private static long Long(DocumentSnapshot s, string f) =>
        s.ContainsField(f) ? s.GetValue<object>(f) switch { long l => l, int i => i, double d => (long)d, _ => 0 } : 0;

    private static double Dbl(DocumentSnapshot s, string f) =>
        s.ContainsField(f) ? s.GetValue<object>(f) switch { double d => d, long l => l, int i => i, _ => 0 } : 0;
}
