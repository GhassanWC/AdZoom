using ExportApi.Models;
using Google.Cloud.Firestore;

namespace ExportApi.Services;

/// <summary>
/// The fan-in step of a chunked export, run by the single merge LEADER (the chunk
/// task that recorded the last chunk, or a retried task that re-won a stale lease).
/// Downloads every chunk MP4, concats them (ffmpeg -f concat -c copy — fast, audio
/// sync preserved), validates, uploads the final MP4, and settles the job SUCCESS
/// (terminal-guarded → exactly once). The caller's heartbeat + cancel-poll stay
/// live for the duration, so a cancel mid-merge aborts and the reconciler skips it.
/// </summary>
public sealed class MergeStep(
    FirestoreService fs,
    StorageService storage,
    RenderSubprocess render,
    ExportOptions opts,
    ILogger<MergeStep> log)
{
    public async Task<int> RunAsync(string uid, string jobId, int chunkRenderSeconds, CancellationToken ct)
    {
        var claim = await fs.TryClaimMergeAsync(uid, jobId);
        if (claim != FirestoreService.MergeClaim.Won)
        {
            BatchLog.Line($"merge: not leader (claim={claim}) — exiting job={jobId}");
            return 0; // another worker merges, or job is terminal/not ready
        }
        BatchLog.Line($"merge leader elected job={jobId}");
        var mergeStart = DateTime.UtcNow;

        var snap = await fs.GetJobAsync(uid, jobId);
        if (snap is null)
        {
            BatchLog.Error($"merge: job doc vanished job={jobId}");
            return 1;
        }
        var projectId = Str(snap, "projectId") ?? "";
        var outputPath = Str(snap, JobFields.OutputPath) ?? "";
        var month = Str(snap, JobFields.MonthlyBucket) ?? FirestoreService.CurrentMonthKey();
        var estimate = (int)Long(snap, JobFields.EstimatedExportMinutes);
        var durationSeconds = Dbl(snap, "durationSeconds");
        var chunkCount = (int)Long(snap, JobFields.ChunkCount);
        if (chunkCount <= 0) chunkCount = Math.Max(1, opts.ChunkCount);

        var workDir = Path.Combine(opts.WorkDir, jobId, "merge");
        Directory.CreateDirectory(workDir);
        var outFile = Path.Combine(workDir, jobId + ".mp4");

        try
        {
            // Confirm every chunk is present (markers + objects) and learn whether the
            // source had audio (per-chunk audio was already verified by the render CLI).
            var markers = await fs.GetChunkMarkersAsync(uid, jobId);
            var sourceHasAudio = markers.Values.Any(m =>
                m.ContainsField("sourceHasAudio") && m.GetValue<bool>("sourceHasAudio"));

            var inputs = new List<string>(chunkCount);
            for (var i = 0; i < chunkCount; i++)
            {
                if (!markers.TryGetValue(i, out var mk) || Str(mk, "status") != "done")
                    return await FailMerge(uid, jobId, $"chunk {i} missing/not done");
                var objectPath = Str(mk, "outputPath")
                    ?? $"users/{uid}/projects/{projectId}/exports/{jobId}/chunks/chunk-{i}.mp4";
                var local = Path.Combine(workDir, $"chunk-{i}.mp4");
                await storage.DownloadAsync(objectPath, local, ct);
                if (!File.Exists(local) || new FileInfo(local).Length == 0)
                    return await FailMerge(uid, jobId, $"chunk {i} downloaded empty");
                inputs.Add(local);
            }

            BatchLog.Line($"merging {inputs.Count} chunks job={jobId}");
            var concatSpec = new Dictionary<string, object?>
            {
                ["mode"] = "concat",
                ["inputs"] = inputs,
                ["outputPath"] = outFile,
            };
            var concat = await render.RunAsync(jobId, concatSpec, workDir, _ => { }, ct, specName: "spec-concat.json");
            if (ct.IsCancellationRequested || concat.Canceled || concat.ExitCode == 2)
            {
                BatchLog.Line($"merge canceled job={jobId}");
                return 0; // cancel is authoritative elsewhere
            }
            if (concat.ExitCode != 0 || concat.Done is null)
                return await FailMerge(uid, jobId, $"concat failed: {concat.Error?.Code ?? "concat_failed"}");

            // Validate: final exists + non-zero. (Duration == sum of exact chunk
            // windows by construction; per-chunk audio already verified by the CLI.)
            if (!File.Exists(outFile) || new FileInfo(outFile).Length == 0)
                return await FailMerge(uid, jobId, "merged file missing/empty");

            BatchLog.Line($"uploading final MP4 job={jobId} → {outputPath}");
            var downloadUrl = await storage.UploadMp4Async(outFile, outputPath, ct);

            var preflight = new Dictionary<string, object?>
            {
                ["videoCodec"] = "h264",
                ["audioCodec"] = sourceHasAudio ? "aac" : "(none)",
                ["risky"] = false,
                ["normalized"] = true,
                ["audioStatus"] = sourceHasAudio ? "preserved" : "none",
            };
            var warnings = concat.Done.Warnings?.Distinct().ToList() ?? new List<string>();
            var settled = await fs.SettleSuccessAsync(uid, jobId, month, estimate, downloadUrl, warnings, preflight);

            var mergeSeconds = (int)(DateTime.UtcNow - mergeStart).TotalSeconds;
            // Diagnostics + merge timestamps (best-effort; additive after settle).
            try
            {
                await fs.PatchAsync(uid, jobId, new Dictionary<string, object?>
                {
                    [JobFields.ChunkedCompletedAt] = FieldValue.ServerTimestamp,
                    [JobFields.MergeCompletedAt] = FieldValue.ServerTimestamp,
                    [JobFields.MergeSeconds] = mergeSeconds,
                    [JobFields.ChunkRenderSeconds] = chunkRenderSeconds,
                    [JobFields.WorkerImage] = opts.BuildVersion,
                    [JobFields.MachineType] = Environment.GetEnvironmentVariable("BATCH_MACHINE_TYPE") ?? "(unknown)",
                });
            }
            catch (Exception ex) { log.LogWarning(ex, "[export] merge diagnostics patch failed job={JobId}", jobId); }

            if (settled)
            {
                try { await fs.MirrorProjectExportUrlAsync(uid, projectId, downloadUrl); }
                catch (Exception ex) { log.LogWarning(ex, "[export] project exportUrl mirror failed job={JobId}", jobId); }
                BatchLog.Line($"job settle SUCCESS (chunked) job={jobId} minutes={estimate} merge={mergeSeconds}s");
            }
            else
            {
                BatchLog.Line($"merge: job already finalized (skipped settle) job={jobId}");
            }

            // Best-effort cleanup of intermediate chunk objects (keep markers for diagnostics).
            for (var i = 0; i < chunkCount; i++)
            {
                var objectPath = $"users/{uid}/projects/{projectId}/exports/{jobId}/chunks/chunk-{i}.mp4";
                await storage.DeleteAsync(objectPath, CancellationToken.None);
            }
            return 0;
        }
        catch (OperationCanceledException)
        {
            BatchLog.Line($"merge canceled (operation) job={jobId}");
            return 0;
        }
        catch (Exception ex)
        {
            log.LogError(ex, "[{Tag}:merge] unexpected job={JobId}", opts.WorkerTag, jobId);
            return await FailMerge(uid, jobId, ex.Message);
        }
        finally
        {
            try { Directory.Delete(workDir, recursive: true); } catch { /* best effort */ }
        }
    }

    private async Task<int> FailMerge(string uid, string jobId, string detail)
    {
        BatchLog.Error($"merge FAILED job={jobId}: {detail}");
        await fs.FailJobFromChunkAsync(uid, jobId, JobFields.ErrMergeFailed,
            "Couldn't assemble the exported video. Please try again.");
        return 1;
    }

    private static string? Str(DocumentSnapshot s, string f) =>
        s.ContainsField(f) ? s.GetValue<object>(f)?.ToString() : null;
    private static long Long(DocumentSnapshot s, string f) =>
        s.ContainsField(f) ? s.GetValue<object>(f) switch { long l => l, int i => i, double d => (long)d, _ => 0 } : 0;
    private static double Dbl(DocumentSnapshot s, string f) =>
        s.ContainsField(f) ? s.GetValue<object>(f) switch { double d => d, long l => l, int i => i, _ => 0 } : 0;
}
