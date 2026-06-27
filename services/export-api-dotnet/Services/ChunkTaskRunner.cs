using ExportApi.Models;
using Google.Cloud.Firestore;

namespace ExportApi.Services;

/// <summary>
/// One PARALLEL chunk task of a chunked cloud export. Each Batch task in the group
/// runs this with a distinct BATCH_TASK_INDEX: it renders ONLY its output-time
/// window, uploads the chunk MP4 to GCS, and atomically records completion. The
/// task whose completion makes chunksCompleted == chunkCount becomes the merge
/// leader (delegates to <see cref="MergeStep"/>); every other task exits 0.
///
/// No exclusive job lease is taken (N tasks share one job). Coordination is the
/// per-chunk markers + the terminal status flip in <see cref="FirestoreService"/>.
/// Always returns a process exit code so the container exits.
/// </summary>
public sealed class ChunkTaskRunner(
    FirestoreService fs,
    StorageService storage,
    RenderSubprocess render,
    MergeStep merge,
    ExportOptions opts,
    ILogger<ChunkTaskRunner> log)
{
    public async Task<int> RunAsync(string uid, string jobId, CancellationToken stopping)
    {
        var index = opts.TaskIndex;
        BatchLog.Line($"chunk task start job={jobId} index={index}/{opts.TaskCount}");

        var snap = await fs.GetJobAsync(uid, jobId);
        if (snap is null)
        {
            BatchLog.Error($"chunk task: job doc not found job={jobId} index={index}");
            return 1;
        }
        if (JobFields.IsTerminal(Str(snap, JobFields.Status)))
        {
            BatchLog.Line($"chunk task: job already terminal — exiting job={jobId} index={index}");
            return 0;
        }

        var projectId = Str(snap, "projectId") ?? "";
        var sourcePath = Str(snap, JobFields.SourceStoragePath) ?? "";
        var durationSeconds = Dbl(snap, "durationSeconds");
        var fps = Dbl(snap, "fps");
        if (fps <= 0) fps = 30;
        var chunkSeconds = (int)Long(snap, JobFields.ChunkSeconds);
        if (chunkSeconds <= 0) chunkSeconds = Math.Max(1, opts.ChunkSeconds);
        var chunkCount = (int)Long(snap, JobFields.ChunkCount);
        if (chunkCount <= 0) chunkCount = Math.Max(1, opts.ChunkCount);

        if (index < 0 || index >= chunkCount)
        {
            BatchLog.Error($"chunk task: index {index} out of range (count={chunkCount}) — failing job={jobId}");
            await fs.FailJobFromChunkAsync(uid, jobId, JobFields.ErrChunkFailed,
                "Export setup error (bad chunk index). Please try again.");
            return 1;
        }

        // Timeline-aware OUTPUT window (integer-frame tiling so seams concat cleanly).
        // The worker maps each output frame to source time via the recipe timeline
        // map, so cuts/speed are handled. RENDER window = trim (emit) window grown by
        // boundary padding (decode warm-up only); EMIT window is the exact span this
        // chunk contributes and begins on an IDR keyframe.
        var win = ChunkWindows.Derive(
            index, chunkCount, chunkSeconds, fps, durationSeconds, opts.ChunkBoundaryPaddingSeconds);
        if (!(win.TrimEndFrame > win.TrimStartFrame))
        {
            BatchLog.Error($"chunk task: empty window trim=[{win.TrimStartFrame},{win.TrimEndFrame}] index={index} — failing job={jobId}");
            await fs.FailJobFromChunkAsync(uid, jobId, JobFields.ErrChunkFailed,
                "Export setup error (empty chunk window). Please try again.");
            return 1;
        }

        Dictionary<string, object> recipe;
        try
        {
            recipe = snap.ContainsField("renderRecipe")
                ? snap.GetValue<Dictionary<string, object>>("renderRecipe")
                : new Dictionary<string, object>();
        }
        catch { recipe = new Dictionary<string, object>(); }

        // First task to arrive flips the job to rendering (idempotent for the rest).
        await fs.EnsureChunkedRenderingAsync(uid, jobId);

        var workDir = Path.Combine(opts.WorkDir, jobId, $"task-{index}");
        Directory.CreateDirectory(workDir);
        var srcExt = Path.GetExtension(sourcePath);
        if (string.IsNullOrEmpty(srcExt)) srcExt = ".mp4";
        var srcFile = Path.Combine(workDir, "source" + srcExt);
        var chunkFile = Path.Combine(workDir, $"chunk-{index}.mp4");
        var chunkObjectPath = $"users/{uid}/projects/{projectId}/exports/{jobId}/chunks/chunk-{index}.mp4";

        using var cancelCts = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        using var heartbeat = StartHeartbeat(uid, jobId, cancelCts.Token);
        using var cancelPoll = StartCancelPoll(uid, jobId, cancelCts);

        var sourceHasAudio = false;
        void OnEvent(RenderEvent ev)
        {
            if (ev.Type == "audio-verify" && ev.SourceHasAudio is { } sa) sourceHasAudio = sa;
            else if (ev.Type == "preflight" && !string.IsNullOrEmpty(ev.AudioCodec) && ev.AudioCodec != "(none)")
                sourceHasAudio = true;
        }

        try
        {
            var renderStart = DateTime.UtcNow;
            log.LogInformation("[export:download] job={JobId} chunk={Idx} src={Src}", jobId, index, sourcePath);
            BatchLog.Line($"downloading source job={jobId} index={index}");
            await storage.DownloadAsync(sourcePath, srcFile, cancelCts.Token);

            var spec = new Dictionary<string, object?>
            {
                ["sourcePath"] = srcFile,
                ["outputPath"] = chunkFile,
                ["serializedRecipe"] = recipe,
                ["crf"] = opts.X264Crf,
                ["preset"] = opts.X264Preset,
                ["normalizeCrf"] = opts.NormalizeCrf,
                ["normalizePreset"] = opts.NormalizePreset,
                ["normalizeEnabled"] = opts.NormalizeEnabled,
                ["chunk"] = new Dictionary<string, object?>
                {
                    ["index"] = index,
                    ["renderStartSec"] = win.RenderStartSec,
                    ["renderEndSec"] = win.RenderEndSec,
                    ["trimStartSec"] = win.TrimStartSec,
                    ["trimEndSec"] = win.TrimEndSec,
                },
            };

            BatchLog.Line($"rendering chunk job={jobId} index={index} trim=[{win.TrimStartSec:F1},{win.TrimEndSec:F1}] render=[{win.RenderStartSec:F1},{win.RenderEndSec:F1}]");
            RenderOutcome? outcome = null;
            var ok = false;
            for (var attempt = 0; attempt <= Math.Max(0, opts.ChunkMaxRetries); attempt++)
            {
                if (attempt > 0)
                    log.LogWarning("[{Tag}:chunk-retry] job={JobId} chunk={Idx} attempt={Att}", opts.WorkerTag, jobId, index, attempt + 1);
                outcome = await render.RunAsync(jobId, spec, workDir, OnEvent, cancelCts.Token, specName: $"spec-chunk-{index}.json");
                if (cancelCts.IsCancellationRequested || outcome.Canceled || outcome.ExitCode == 2)
                {
                    BatchLog.Line($"chunk task canceled job={jobId} index={index}");
                    return 0; // job canceled/failed elsewhere — not this task's failure
                }
                if (outcome.ExitCode == 0 && outcome.Done is not null) { ok = true; break; }
                log.LogWarning("[{Tag}:chunk-fail] job={JobId} chunk={Idx} code={Code}", opts.WorkerTag, jobId, index, outcome.Error?.Code ?? "render_failed");
            }

            if (!ok)
            {
                var code = outcome?.Error?.Code ?? JobFields.ErrChunkFailed;
                var msg = outcome?.Error?.Message ?? "Something went wrong while exporting your video. Please try again.";
                // The app's eligibility gate mirrors the CLI allowlist, so this should
                // never happen — but if a timeline with a chunk-incompatible effect
                // type ever reaches a chunk task, fail with a clear reason.
                if (code == "chunk_unsupported_effects")
                    msg = "This export can't be split into chunks (it uses an effect that isn't chunk-compatible). Please try again.";
                await fs.FailJobFromChunkAsync(uid, jobId, code, msg);
                BatchLog.Error($"chunk render FAILED job={jobId} index={index} code={code} — job failed");
                return 1;
            }

            // Backstop: never ship a chunk that skipped normalization while it was enabled.
            if (opts.NormalizeEnabled && outcome!.Done!.Normalized == false)
            {
                await fs.FailJobFromChunkAsync(uid, jobId, "normalize_not_executed",
                    "The export could not be prepared (normalization did not run). Please try again.");
                return 1;
            }

            var chunkSizeBytes = File.Exists(chunkFile) ? new FileInfo(chunkFile).Length : 0;
            BatchLog.Line($"upload start job={jobId} index={index} size={chunkSizeBytes}B → {chunkObjectPath}");
            var uploadStart = DateTime.UtcNow;
            await storage.UploadMp4Async(chunkFile, chunkObjectPath, cancelCts.Token);
            BatchLog.Line($"upload complete job={jobId} index={index} size={chunkSizeBytes}B ({(int)(DateTime.UtcNow - uploadStart).TotalSeconds}s)");

            // Persist the normalized source ONCE (deterministic single uploader =
            // index 0) so the merge's GLOBAL audio pass reuses it instead of
            // re-transcoding, and the muxed audio is built from bit-identical source.
            // Best-effort: the merge re-normalizes the original as a fallback if this
            // object is missing. The render CLI wrote it next to the chunk output.
            if (index == 0 && opts.NormalizeEnabled)
            {
                var normFile = Path.Combine(workDir, "normalized-source.mp4");
                if (File.Exists(normFile))
                {
                    var normObjectPath = $"users/{uid}/projects/{projectId}/exports/{jobId}/normalized-source.mp4";
                    try
                    {
                        await storage.UploadMp4Async(normFile, normObjectPath, cancelCts.Token);
                        BatchLog.Line($"persisted normalized source job={jobId} → {normObjectPath}");
                    }
                    catch (Exception ex)
                    {
                        log.LogWarning(ex, "[export] persist normalized source failed job={JobId}", jobId);
                    }
                }
            }

            var chunkRenderSec = (int)(DateTime.UtcNow - renderStart).TotalSeconds;
            var result = await fs.RecordChunkDoneAsync(uid, jobId, index, chunkObjectPath, sourceHasAudio, index);
            BatchLog.Line($"chunk recorded job={jobId} index={index} result={result} ({chunkRenderSec}s)");

            if (result == FirestoreService.ChunkRecordResult.AlreadyTerminal)
                return 0; // job canceled/failed elsewhere — nothing to do

            // Attempt the merge on EVERY successful record (Counted / AlreadyCounted /
            // AllComplete), not just the first AllComplete. merge.RunAsync is fully
            // idempotent via TryClaimMergeAsync: NotReady when chunks aren't all done
            // (→ exits 0 cheaply, read-only), Lost when a live leader holds the lease,
            // Won when this task should merge. This is what lets a Batch-RETRIED task
            // re-drive a merge stalled by a dead leader once its lease expires (the
            // original AllComplete-only path made that recovery unreachable).
            return await merge.RunAsync(uid, jobId, chunkRenderSec, cancelCts.Token);
        }
        catch (OperationCanceledException)
        {
            BatchLog.Line($"chunk task canceled (operation) job={jobId} index={index}");
            return 0;
        }
        catch (Exception ex)
        {
            log.LogError(ex, "[{Tag}:chunk] unexpected job={JobId} index={Idx}", opts.WorkerTag, jobId, index);
            await fs.FailJobFromChunkAsync(uid, jobId, JobFields.ErrChunkFailed,
                "Something went wrong while exporting your video. Please try again.");
            return 1;
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
            var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(5, opts.HeartbeatSeconds)));
            try
            {
                while (await timer.WaitForNextTickAsync(cts.Token))
                {
                    try { await fs.HeartbeatAsync(uid, jobId); }
                    catch (Exception ex) { log.LogWarning(ex, "[export] chunk heartbeat failed job={JobId}", jobId); }
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
                            BatchLog.Line($"chunk task: cancel requested — aborting job={jobId} index={opts.TaskIndex}");
                            cancelCts.Cancel();
                            return;
                        }
                    }
                    catch (Exception ex) { log.LogWarning(ex, "[export] chunk cancel-poll failed job={JobId}", jobId); }
                }
            }
            catch (OperationCanceledException) { }
        });
        return cts;
    }

    private static string? Str(DocumentSnapshot s, string f) =>
        s.ContainsField(f) ? s.GetValue<object>(f)?.ToString() : null;
    private static long Long(DocumentSnapshot s, string f) =>
        s.ContainsField(f) ? s.GetValue<object>(f) switch { long l => l, int i => i, double d => (long)d, _ => 0 } : 0;
    private static double Dbl(DocumentSnapshot s, string f) =>
        s.ContainsField(f) ? s.GetValue<object>(f) switch { double d => d, long l => l, int i => i, _ => 0 } : 0;
}
