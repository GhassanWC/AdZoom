using ExportApi.Models;
using Google.Cloud.Firestore;

namespace ExportApi.Services;

/// <summary>
/// One SHARD WORKER of a sharded chunked cloud export. Each Batch task runs this
/// with a distinct BATCH_TASK_INDEX (its workerIndex) and renders MANY chunks
/// round-robin — chunkIndex = workerIndex; chunkIndex &lt; EXPORT_CHUNK_COUNT;
/// chunkIndex += EXPORT_WORKER_COUNT — so 24 chunks run on 4–6 workers, not 24
/// containers. The source is downloaded + normalized ONCE per worker (later chunks
/// reuse the normalized file). After EACH chunk it uploads + records + updates the
/// progress summary + attempts the merge; the worker that records the LAST chunk
/// (leader election in Firestore) merges. Every other worker exits 0.
///
/// No exclusive job lease is taken (workers share one job). Coordination is the
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
        var workerIndex = opts.TaskIndex;
        var workerCount = opts.WorkerCount > 0 ? opts.WorkerCount : Math.Max(1, opts.TaskCount);
        BatchLog.Line($"worker shard start job={jobId} workerIndex={workerIndex} workerCount={workerCount}");

        var snap = await fs.GetJobAsync(uid, jobId);
        if (snap is null)
        {
            BatchLog.Error($"worker: job doc not found job={jobId} worker={workerIndex}");
            return 1;
        }
        if (JobFields.IsTerminal(Str(snap, JobFields.Status)))
        {
            BatchLog.Line($"worker: job already terminal — exiting job={jobId} worker={workerIndex}");
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

        // The chunks THIS worker owns (CONTIGUOUS shard range):
        //   chunksPerWorker = ceil(chunkCount / workerCount)
        //   start = workerIndex * chunksPerWorker; end = min(chunkCount, start + chunksPerWorker)
        var shard = ChunkWindows.ShardChunks(workerIndex, workerCount, chunkCount);
        var assigned = new List<int>();
        for (var ci = shard.StartChunk; ci < shard.EndChunkExclusive; ci++)
            assigned.Add(ci);
        BatchLog.Line($"assigned chunks job={jobId} worker={workerIndex} count={assigned.Count} range=[{shard.StartChunk},{shard.EndChunkExclusive}) indexes=[{string.Join(",", assigned)}]");

        // First worker to arrive flips the job to rendering (idempotent for the rest).
        await fs.EnsureChunkedRenderingAsync(uid, jobId);

        using var cancelCts = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        using var heartbeat = StartHeartbeat(uid, jobId, cancelCts.Token);
        using var cancelPoll = StartCancelPoll(uid, jobId, cancelCts);

        if (assigned.Count == 0)
        {
            // Spurious worker (more workers than chunks, or a bad index). Nothing to
            // render; still attempt the merge (NotReady/Lost = 0) then exit cleanly.
            BatchLog.Line($"worker has no assigned chunks job={jobId} worker={workerIndex} — merge-only");
            return await merge.RunAsync(uid, jobId, 0, cancelCts.Token);
        }

        Dictionary<string, object> recipe;
        try
        {
            recipe = snap.ContainsField("renderRecipe")
                ? snap.GetValue<Dictionary<string, object>>("renderRecipe")
                : new Dictionary<string, object>();
        }
        catch { recipe = new Dictionary<string, object>(); }

        var workDir = Path.Combine(opts.WorkDir, jobId, $"worker-{workerIndex}");
        Directory.CreateDirectory(workDir);
        var srcExt = Path.GetExtension(sourcePath);
        if (string.IsNullOrEmpty(srcExt)) srcExt = ".mp4";
        var srcFile = Path.Combine(workDir, "source" + srcExt);
        // Written by this worker's FIRST chunk render (normalize once); reused by the rest.
        var normalizedPath = Path.Combine(workDir, "normalized-source.mp4");

        var sourceHasAudio = false;
        void OnEvent(RenderEvent ev)
        {
            if (ev.Type == "audio-verify" && ev.SourceHasAudio is { } sa) sourceHasAudio = sa;
            else if (ev.Type == "preflight" && !string.IsNullOrEmpty(ev.AudioCodec) && ev.AudioCodec != "(none)")
                sourceHasAudio = true;
        }

        try
        {
            // Download/prepare the source ONCE per worker (not once per chunk).
            log.LogInformation("[export:download] job={JobId} worker={Idx} src={Src}", jobId, workerIndex, sourcePath);
            BatchLog.Line($"downloading source job={jobId} worker={workerIndex}");
            await storage.DownloadAsync(sourcePath, srcFile, cancelCts.Token);

            var totalRenderSec = 0;
            var rendered = 0;
            foreach (var ci in assigned)
            {
                if (cancelCts.IsCancellationRequested)
                {
                    BatchLog.Line($"worker canceled job={jobId} worker={workerIndex}");
                    return 0;
                }

                // Timeline-aware OUTPUT window (integer-frame tiling so seams concat
                // cleanly). Output→source mapping handles cuts/speed.
                var win = ChunkWindows.Derive(
                    ci, chunkCount, chunkSeconds, fps, durationSeconds, opts.ChunkBoundaryPaddingSeconds);
                if (!(win.TrimEndFrame > win.TrimStartFrame))
                {
                    BatchLog.Error($"worker: empty window chunk={ci} — failing job={jobId}");
                    await fs.FailJobFromChunkAsync(uid, jobId, JobFields.ErrChunkFailed,
                        "Export setup error (empty chunk window). Please try again.");
                    return 1;
                }

                var chunkFile = Path.Combine(workDir, $"chunk-{ci}.mp4");
                var chunkObjectPath = $"users/{uid}/projects/{projectId}/exports/{jobId}/chunks/chunk-{ci}.mp4";

                // Normalize ONCE per worker (its first rendered chunk). Later chunks
                // read the normalized file → no re-transcode per chunk.
                var firstRender = rendered == 0;
                var normalizeNow = firstRender && opts.NormalizeEnabled;
                var renderSourcePath =
                    firstRender || !opts.NormalizeEnabled || !File.Exists(normalizedPath)
                        ? srcFile
                        : normalizedPath;

                var spec = new Dictionary<string, object?>
                {
                    ["jobId"] = jobId,
                    ["sourcePath"] = renderSourcePath,
                    ["outputPath"] = chunkFile,
                    ["serializedRecipe"] = recipe,
                    ["crf"] = opts.X264Crf,
                    ["preset"] = opts.X264Preset,
                    ["normalizeCrf"] = opts.NormalizeCrf,
                    ["normalizePreset"] = opts.NormalizePreset,
                    ["normalizeEnabled"] = normalizeNow,
                    ["chunk"] = new Dictionary<string, object?>
                    {
                        ["index"] = ci,
                        ["renderStartSec"] = win.RenderStartSec,
                        ["renderEndSec"] = win.RenderEndSec,
                        ["trimStartSec"] = win.TrimStartSec,
                        ["trimEndSec"] = win.TrimEndSec,
                    },
                };

                BatchLog.Line($"chunk render start job={jobId} worker={workerIndex} chunk={ci} ({rendered + 1}/{assigned.Count}) trim=[{win.TrimStartSec:F1},{win.TrimEndSec:F1}]");
                var renderStart = DateTime.UtcNow;
                RenderOutcome? outcome = null;
                var ok = false;
                for (var attempt = 0; attempt <= Math.Max(0, opts.ChunkMaxRetries); attempt++)
                {
                    if (attempt > 0)
                        log.LogWarning("[{Tag}:chunk-retry] job={JobId} chunk={Idx} attempt={Att}", opts.WorkerTag, jobId, ci, attempt + 1);
                    outcome = await render.RunAsync(jobId, spec, workDir, OnEvent, cancelCts.Token, specName: $"spec-chunk-{ci}.json");
                    if (cancelCts.IsCancellationRequested || outcome.Canceled || outcome.ExitCode == 2)
                    {
                        BatchLog.Line($"chunk canceled job={jobId} worker={workerIndex} chunk={ci}");
                        return 0; // job canceled/failed elsewhere — not this worker's failure
                    }
                    if (outcome.ExitCode == 0 && outcome.Done is not null) { ok = true; break; }
                    log.LogWarning("[{Tag}:chunk-fail] job={JobId} chunk={Idx} code={Code}", opts.WorkerTag, jobId, ci, outcome.Error?.Code ?? "render_failed");
                }

                if (!ok)
                {
                    var code = outcome?.Error?.Code ?? JobFields.ErrChunkFailed;
                    var msg = outcome?.Error?.Message ?? "Something went wrong while exporting your video. Please try again.";
                    if (code == "chunk_unsupported_effects")
                        msg = "This export can't be split into chunks (it uses an effect that isn't chunk-compatible). Please try again.";
                    await fs.FailJobFromChunkAsync(uid, jobId, code, msg);
                    BatchLog.Error($"chunk render FAILED job={jobId} worker={workerIndex} chunk={ci} code={code} — job failed");
                    return 1;
                }

                // Backstop: never ship a chunk that skipped normalization while it was
                // expected (only meaningful on the worker's first/normalizing render).
                if (normalizeNow && outcome!.Done!.Normalized == false)
                {
                    await fs.FailJobFromChunkAsync(uid, jobId, "normalize_not_executed",
                        "The export could not be prepared (normalization did not run). Please try again.");
                    return 1;
                }

                var chunkSizeBytes = File.Exists(chunkFile) ? new FileInfo(chunkFile).Length : 0;
                await storage.UploadMp4Async(chunkFile, chunkObjectPath, cancelCts.Token);
                BatchLog.Line($"chunk uploaded job={jobId} worker={workerIndex} chunk={ci} size={chunkSizeBytes}B → {chunkObjectPath}");

                // Persist the normalized source ONCE (global chunk 0 = worker 0's first
                // render) so the merge's GLOBAL audio pass reuses it (no re-transcode).
                if (ci == 0 && opts.NormalizeEnabled && File.Exists(normalizedPath))
                {
                    var normObjectPath = $"users/{uid}/projects/{projectId}/exports/{jobId}/normalized-source.mp4";
                    try
                    {
                        await storage.UploadMp4Async(normalizedPath, normObjectPath, cancelCts.Token);
                        BatchLog.Line($"persisted normalized source job={jobId} → {normObjectPath}");
                    }
                    catch (Exception ex)
                    {
                        log.LogWarning(ex, "[export] persist normalized source failed job={JobId}", jobId);
                    }
                }

                totalRenderSec += (int)(DateTime.UtcNow - renderStart).TotalSeconds;
                rendered++;

                var result = await fs.RecordChunkDoneAsync(uid, jobId, ci, chunkObjectPath, sourceHasAudio, workerIndex);
                BatchLog.Line($"chunk recorded job={jobId} worker={workerIndex} chunk={ci} result={result}");
                if (result == FirestoreService.ChunkRecordResult.AlreadyTerminal)
                    return 0; // job canceled/failed elsewhere — stop this worker
                BatchLog.Line($"progress summary updated job={jobId} worker={workerIndex} chunk={ci}");

                // Try merge after EVERY chunk: NotReady (cheap, read-only) until ALL
                // chunks are recorded, then exactly one worker wins + merges. A
                // non-zero exit means the merge itself FAILED → fail the whole job.
                var mergeExit = await merge.RunAsync(uid, jobId, totalRenderSec, cancelCts.Token);
                if (mergeExit != 0) return mergeExit;
            }

            // All my chunks are done. One final merge attempt covers the case where
            // this worker recorded the GLOBAL-last chunk (idempotent: a re-claimed
            // stale lease re-drives a merge a dead leader left unfinished).
            return await merge.RunAsync(uid, jobId, totalRenderSec, cancelCts.Token);
        }
        catch (OperationCanceledException)
        {
            BatchLog.Line($"worker canceled (operation) job={jobId} worker={workerIndex}");
            return 0;
        }
        catch (Exception ex)
        {
            log.LogError(ex, "[{Tag}:chunk] unexpected job={JobId} worker={Idx}", opts.WorkerTag, jobId, workerIndex);
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
