using System.Text.Json;
using ExportApi.Models;
using Google.Cloud.Firestore;

namespace ExportApi.Services;

/// <summary>
/// All Firestore reads/writes for the export lifecycle. Ports the transactions
/// from src/app/api/export/cloud/route.ts (reserve+create), cancel/route.ts,
/// services/export-worker/src/handler.ts (claim/heartbeat/settle/release), and
/// src/app/api/cron/reconcile-exports/route.ts. The client can only READ
/// exportJobs (firestore.rules), so every write here uses server credentials.
/// </summary>
public sealed class FirestoreService(FirestoreDb db, ExportOptions opts, ILogger<FirestoreService> log)
{
    private DocumentReference UserRef(string uid) => db.Document($"users/{uid}");
    private DocumentReference UsageRef(string uid, string month) => db.Document($"users/{uid}/usage/{month}");
    private DocumentReference JobRef(string uid, string jobId) => db.Document($"users/{uid}/exportJobs/{jobId}");
    private CollectionReference JobsCol(string uid) => db.Collection($"users/{uid}/exportJobs");

    public static string CurrentMonthKey(DateTime? utcNow = null) =>
        (utcNow ?? DateTime.UtcNow).ToString("yyyy-MM");

    public DocumentReference JobReference(string uid, string jobId) => JobRef(uid, jobId);

    // ── Enqueue: gate + RESERVE + CREATE in one transaction ──────────────────
    public async Task<EnqueueResponse> EnqueueAsync(EnqueueRequest req)
    {
        var uid = req.Uid!;
        var month = CurrentMonthKey();
        var estimate = Plan.EstimateMinutes(req.DurationSeconds);
        var jobRef = JobsCol(uid).Document(); // auto id
        var jobId = jobRef.Id;
        var outputPath = $"users/{uid}/projects/{req.ProjectId}/exports/{jobId}.mp4";
        var recipe = FirestoreJson.Convert(req.SerializedRecipe);
        var wants4kOr60 = req.Resolution == "4K" || req.Fps == 60;
        var settingsHash = SettingsHash.Compute(
            req.ProjectId!, req.SourceStoragePath!, null, req.Resolution, req.Fps, req.SerializedRecipe);

        // ── Dedup + single-flight against the user's active jobs (mirrors
        //    src/lib/export/create-job.ts). Identical active export → return it;
        //    a different active export → 409; stale active → fail + release. ──
        var (dupId, otherActive, staleIds) = await CheckActiveForDedupAsync(uid, req.ProjectId!, settingsHash);
        if (dupId is not null)
        {
            var dupSnap = await JobRef(uid, dupId).GetSnapshotAsync();
            var dupPlan = GetString(dupSnap, "plan") == Plan.Creator ? Plan.Creator : Plan.Pro;
            log.LogInformation("[export:enqueue] dedup — returning existing active job uid={Uid} jobId={JobId} settingsHash={Hash}", uid, dupId, settingsHash);
            return new EnqueueResponse
            {
                JobId = dupId,
                Deduped = true,
                EstimatedExportMinutes = (int)GetLong(dupSnap, JobFields.EstimatedExportMinutes),
                Plan = dupPlan,
                Priority = dupPlan == Plan.Creator ? "priority" : "normal",
                Limit = Plan.Limit(dupPlan),
            };
        }
        foreach (var staleId in staleIds)
        {
            try { await FailStaleAsync(uid, staleId); }
            catch (Exception ex) { log.LogWarning(ex, "[export:enqueue] fail-stale error (continuing) jobId={JobId}", staleId); }
        }
        if (otherActive) throw new ExportAlreadyRunningException();

        var livePlan = await db.RunTransactionAsync(async tx =>
        {
            var userSnap = await tx.GetSnapshotAsync(UserRef(uid));
            var usageSnap = await tx.GetSnapshotAsync(UsageRef(uid, month));

            var plan = Plan.Normalize(userSnap.Exists ? GetString(userSnap, "plan") : null);
            if (!Plan.AllowsCloudExport(plan)) throw new PlanNotAllowedException(plan);
            if (wants4kOr60 && !Plan.MeetsMinimum(plan, Plan.Pro)) throw new TierRequiresProException(plan);

            var reserved = GetLong(usageSnap, JobFields.CloudMinutesReserved);
            var consumed = GetLong(usageSnap, JobFields.CloudMinutesConsumed);
            if (!Plan.CanCloudExport(plan, reserved, consumed, estimate))
                throw new MinutesExhaustedException(Plan.Remaining(plan, reserved, consumed), estimate, plan);

            var now = NowMs();
            tx.Set(UsageRef(uid, month), new Dictionary<string, object?>
            {
                [JobFields.CloudMinutesReserved] = reserved + estimate,
                [JobFields.LastCloudExportAt] = now,
                [JobFields.UpdatedAt] = now,
            }, SetOptions.MergeAll);

            var priority = plan == Plan.Creator ? "priority" : "normal";
            tx.Set(jobRef, new Dictionary<string, object?>
            {
                ["userId"] = uid,
                ["projectId"] = req.ProjectId,
                ["projectTitle"] = req.ProjectTitle ?? "Untitled",
                [JobFields.Status] = JobFields.Queued,
                ["plan"] = plan == Plan.Creator ? Plan.Creator : Plan.Pro,
                ["priority"] = priority,
                [JobFields.SourceStoragePath] = req.SourceStoragePath,
                [JobFields.OutputPath] = outputPath,
                ["format"] = "mp4",
                [JobFields.ExportPath] = "cloud",
                [JobFields.SettingsHash] = settingsHash,
                [JobFields.BuildVersion] = opts.BuildVersion,
                ["outputWidth"] = req.OutputWidth,
                ["outputHeight"] = req.OutputHeight,
                ["fps"] = req.Fps,
                ["durationSeconds"] = req.DurationSeconds,
                [JobFields.EstimatedExportMinutes] = estimate,
                [JobFields.Progress] = 0,
                [JobFields.Stage] = JobFields.Queued,
                [JobFields.ProgressStage] = "queued",
                [JobFields.MonthlyBucket] = month,
                ["renderRecipe"] = recipe,
                ["createdAt"] = FieldValue.ServerTimestamp,
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            });
            return plan;
        });

        var paidPlan = livePlan == Plan.Creator ? Plan.Creator : Plan.Pro;
        return new EnqueueResponse
        {
            JobId = jobId,
            EstimatedExportMinutes = estimate,
            Plan = paidPlan,
            Priority = paidPlan == Plan.Creator ? "priority" : "normal",
            Limit = Plan.Limit(paidPlan),
        };
    }

    // ── Claim: heartbeat-lease (ports handler.ts:claimJob) ───────────────────
    public enum ClaimResult { Missing, Terminal, Leased, Claimed }

    /// <param name="forceReclaim">When true, re-claim an in-flight job even if its
    /// lease is still fresh. Safe (and used) ONLY in single-job/Batch mode: Batch
    /// starts a retry attempt only after the previous attempt's container has fully
    /// exited, so the prior owner is provably dead and there is no concurrent
    /// claimant for this dedicated job.</param>
    public async Task<(ClaimResult Result, DocumentSnapshot? Snap)> TryClaimAsync(
        string uid, string jobId, bool forceReclaim = false)
    {
        var jobRef = JobRef(uid, jobId);
        DocumentSnapshot? claimed = null;
        var result = await db.RunTransactionAsync(async tx =>
        {
            var snap = await tx.GetSnapshotAsync(jobRef);
            if (!snap.Exists) return ClaimResult.Missing;
            var status = GetString(snap, JobFields.Status);
            if (JobFields.IsTerminal(status)) return ClaimResult.Terminal;

            var inFlight = status is JobFields.Rendering or JobFields.Uploading;
            if (inFlight && !forceReclaim && AgeMs(snap, JobFields.UpdatedAt) < opts.HeartbeatStaleSeconds * 1000L)
                return ClaimResult.Leased;

            if (inFlight)
                log.LogWarning("[export:reclaim] stale in-flight job re-claimed uid={Uid} jobId={JobId} status={Status}", uid, jobId, status);

            tx.Update(jobRef, new Dictionary<string, object>
            {
                [JobFields.Status] = JobFields.Rendering,
                [JobFields.Stage] = "downloading",
                [JobFields.ProgressStage] = "preparing",
                // Multi-VM attribution + liveness — which worker + build took the job, when.
                [JobFields.WorkerId] = opts.WorkerId,
                [JobFields.BuildVersion] = opts.BuildVersion,
                [JobFields.ClaimedAt] = FieldValue.ServerTimestamp,
                [JobFields.LastHeartbeatAt] = FieldValue.ServerTimestamp,
                [JobFields.HeartbeatAt] = FieldValue.ServerTimestamp,
                // Render-start baseline for the stale-progress watchdog.
                [JobFields.LastProgressAt] = FieldValue.ServerTimestamp,
                [JobFields.Progress] = 0,
                [JobFields.StartedAt] = FieldValue.ServerTimestamp,
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            });
            claimed = snap;
            return ClaimResult.Claimed;
        });
        return (result, result == ClaimResult.Claimed ? claimed : null);
    }

    /// <summary>Merge a patch + bump updatedAt + lastHeartbeatAt + lastProgressAt
    /// (server timestamps). Every stage/progress write doubles as a liveness beat so
    /// stale detection only fires for a genuinely dead worker, AND counts as real
    /// progress so the stale-progress watchdog doesn't fire mid-render/mid-merge.</summary>
    public Task PatchAsync(string uid, string jobId, Dictionary<string, object?> data)
    {
        data[JobFields.UpdatedAt] = FieldValue.ServerTimestamp;
        data[JobFields.LastHeartbeatAt] = FieldValue.ServerTimestamp;
        data[JobFields.HeartbeatAt] = FieldValue.ServerTimestamp;
        // A stage/progress write is REAL progress (unlike the bare heartbeat below).
        data[JobFields.LastProgressAt] = FieldValue.ServerTimestamp;
        return JobRef(uid, jobId).SetAsync(data, SetOptions.MergeAll);
    }

    /// <summary>Bare liveness beat (no progress). Bumps updatedAt/lastHeartbeatAt/
    /// heartbeatAt but DELIBERATELY NOT lastProgressAt — a heartbeat must not mask a
    /// stalled render from the stale-progress watchdog.</summary>
    public Task HeartbeatAsync(string uid, string jobId) =>
        JobRef(uid, jobId).SetAsync(new Dictionary<string, object>
        {
            [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            [JobFields.LastHeartbeatAt] = FieldValue.ServerTimestamp,
            [JobFields.HeartbeatAt] = FieldValue.ServerTimestamp,
        }, SetOptions.MergeAll);

    /// <summary>
    /// Per-worker heartbeat (30s cadence). Rewrites this shard worker's own doc at
    /// users/{uid}/exportJobs/{jobId}/workers/{workerIndex} with its current chunk /
    /// completed count / local progress, then mirrors a coarse activeWorkerCount +
    /// lastWorkerHeartbeatAt + the usual liveness beat onto the MAIN doc. Per-worker
    /// docs never clobber each other (distinct ids), so 8 workers can heartbeat
    /// concurrently. Does NOT bump lastProgressAt (heartbeat ≠ progress).
    /// </summary>
    public async Task WorkerHeartbeatAsync(
        string uid, string jobId, int workerIndex, int currentChunkIndex,
        int chunksCompletedByWorker, int progressPercent)
    {
        var jobRef = JobRef(uid, jobId);
        var workerRef = jobRef.Collection(JobFields.WorkersCollection).Document(workerIndex.ToString());
        await workerRef.SetAsync(new Dictionary<string, object?>
        {
            [JobFields.WorkerIndex] = workerIndex,
            [JobFields.CurrentChunkIndex] = currentChunkIndex,
            [JobFields.ChunksCompleted] = chunksCompletedByWorker,
            [JobFields.ProgressPercent] = progressPercent,
            [JobFields.WorkerId] = opts.WorkerId,
            [JobFields.BuildVersion] = opts.BuildVersion,
            [JobFields.LastWorkerHeartbeatAt] = FieldValue.ServerTimestamp,
        }, SetOptions.MergeAll);

        // Best-effort live worker count: docs heartbeated within ~3× the cadence.
        var activeWorkerCount = 0;
        try
        {
            var freshMs = Math.Max(30, opts.HeartbeatSeconds) * 3 * 1000L;
            var snap = await jobRef.Collection(JobFields.WorkersCollection).GetSnapshotAsync();
            foreach (var d in snap.Documents)
                if (AgeMs(d, JobFields.LastWorkerHeartbeatAt) <= freshMs) activeWorkerCount++;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "[export] active-worker-count read failed job={JobId}", jobId);
        }

        await jobRef.SetAsync(new Dictionary<string, object?>
        {
            [JobFields.LastWorkerHeartbeatAt] = FieldValue.ServerTimestamp,
            [JobFields.ActiveWorkerCount] = activeWorkerCount,
            [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            [JobFields.LastHeartbeatAt] = FieldValue.ServerTimestamp,
            [JobFields.HeartbeatAt] = FieldValue.ServerTimestamp,
        }, SetOptions.MergeAll);
    }

    // ── Parallel chunked render coordination ─────────────────────────────────
    public enum ChunkRecordResult { AlreadyTerminal, AlreadyCounted, Counted, AllComplete }
    public enum MergeClaim { NotReady, Lost, Won }

    private int EffectiveChunkCount(DocumentSnapshot snap)
    {
        var c = (int)GetLong(snap, JobFields.ChunkCount);
        return c > 0 ? c : Math.Max(1, opts.ChunkCount);
    }

    /// <summary>Idempotently flip a chunked job to rendering on the FIRST task that
    /// arrives. Safe for N concurrent callers (never clobbers terminal); does NOT
    /// take the exclusive single-job lease (N tasks share this job).</summary>
    public async Task EnsureChunkedRenderingAsync(string uid, string jobId)
    {
        await db.RunTransactionAsync(async tx =>
        {
            var jobRef = JobRef(uid, jobId);
            var snap = await tx.GetSnapshotAsync(jobRef);
            if (!snap.Exists) return false;
            var status = GetString(snap, JobFields.Status);
            if (JobFields.IsTerminal(status) || status == JobFields.Rendering) return false;
            tx.Update(jobRef, new Dictionary<string, object>
            {
                [JobFields.Status] = JobFields.Rendering,
                [JobFields.Stage] = "rendering_chunks",
                [JobFields.ProgressStage] = "rendering",
                [JobFields.ChunkedStartedAt] = FieldValue.ServerTimestamp,
                [JobFields.StartedAt] = FieldValue.ServerTimestamp,
                [JobFields.BuildVersion] = opts.BuildVersion,
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
                [JobFields.LastHeartbeatAt] = FieldValue.ServerTimestamp,
                [JobFields.HeartbeatAt] = FieldValue.ServerTimestamp,
                // Render-start baseline for the stale-progress watchdog.
                [JobFields.LastProgressAt] = FieldValue.ServerTimestamp,
            });
            return true;
        });
    }

    /// <summary>Record that chunk <paramref name="index"/> uploaded, EXACTLY ONCE.
    /// A per-chunk marker doc gates the chunksCompleted increment, so a Batch task
    /// retry that re-uploads cannot double-count. Returns AllComplete only to the
    /// single caller whose increment reaches chunkCount (the merge leader).</summary>
    public Task<ChunkRecordResult> RecordChunkDoneAsync(
        string uid, string jobId, int index, string outputPath, bool sourceHasAudio, int taskIndex)
    {
        return db.RunTransactionAsync(async tx =>
        {
            var jobRef = JobRef(uid, jobId);
            var jobSnap = await tx.GetSnapshotAsync(jobRef);
            if (!jobSnap.Exists || JobFields.IsTerminal(GetString(jobSnap, JobFields.Status)))
                return ChunkRecordResult.AlreadyTerminal;

            var chunkRef = jobRef.Collection(JobFields.ChunksCollection).Document(index.ToString());
            var chunkSnap = await tx.GetSnapshotAsync(chunkRef);
            if (chunkSnap.Exists && GetString(chunkSnap, "status") == "done")
                return ChunkRecordResult.AlreadyCounted; // retry re-upload → do NOT re-increment

            var chunkCount = EffectiveChunkCount(jobSnap);
            var completed = (int)GetLong(jobSnap, JobFields.ChunksCompleted) + 1;
            var failed = (int)GetLong(jobSnap, JobFields.ChunksFailed);
            var workerCount = (int)GetLong(jobSnap, JobFields.WorkerCount);
            if (workerCount <= 0) workerCount = Math.Max(1, opts.WorkerCount > 0 ? opts.WorkerCount : opts.TaskCount);

            // Progress summary (UI reads chunksCompleted/chunkCount; these extra
            // fields give a richer view + a render-phase percent that reserves the
            // last few % for the merge/audiomux pass).
            var durationSeconds = GetDouble(jobSnap, "durationSeconds");
            var fps = GetDouble(jobSnap, "fps");
            if (fps <= 0) fps = 30;
            var framesExpected = (long)Math.Round(Math.Max(0, durationSeconds) * fps);
            var ratio = chunkCount > 0 ? (double)completed / chunkCount : 0;
            var framesRendered = (long)Math.Round(ratio * framesExpected);
            var progressPercent = (int)Math.Floor(ratio * 95); // last 5% reserved for merge
            var activeChunks = Math.Max(0, Math.Min(workerCount, chunkCount - completed));

            tx.Set(chunkRef, new Dictionary<string, object?>
            {
                ["index"] = index,
                ["status"] = "done",
                ["outputPath"] = outputPath,
                ["sourceHasAudio"] = sourceHasAudio,
                ["workerId"] = opts.WorkerId,
                ["taskIndex"] = taskIndex,
                ["completedAt"] = FieldValue.ServerTimestamp,
            });
            tx.Update(jobRef, new Dictionary<string, object>
            {
                [JobFields.ChunksCompleted] = completed,
                // Progress summary fields.
                [JobFields.TotalChunks] = chunkCount,
                [JobFields.CompletedChunks] = completed,
                [JobFields.FailedChunks] = failed,
                [JobFields.ActiveChunks] = activeChunks,
                [JobFields.FramesExpected] = framesExpected,
                [JobFields.FramesRendered] = framesRendered,
                [JobFields.ProgressPercent] = progressPercent,
                [JobFields.Progress] = ratio, // 0..1 (kept for existing UI)
                [JobFields.Phase] = "rendering",
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
                [JobFields.LastHeartbeatAt] = FieldValue.ServerTimestamp,
                [JobFields.HeartbeatAt] = FieldValue.ServerTimestamp,
                // "A chunk has been recorded" — the core signal the stale-progress
                // watchdog watches. A worker that stops recording chunks goes stale.
                [JobFields.LastProgressAt] = FieldValue.ServerTimestamp,
            });
            return completed >= chunkCount ? ChunkRecordResult.AllComplete : ChunkRecordResult.Counted;
        });
    }

    /// <summary>Claim the single merge slot (leader election). Won only when all
    /// chunks are done AND no live lease is held by another worker. A stale lease
    /// (no heartbeat past MergeLeaseSeconds) is re-claimable so a dead leader's
    /// merge can be retried. Flips the UI stage to "merging".</summary>
    public Task<MergeClaim> TryClaimMergeAsync(string uid, string jobId)
    {
        return db.RunTransactionAsync(async tx =>
        {
            var jobRef = JobRef(uid, jobId);
            var snap = await tx.GetSnapshotAsync(jobRef);
            if (!snap.Exists || JobFields.IsTerminal(GetString(snap, JobFields.Status)))
                return MergeClaim.Lost;
            if ((int)GetLong(snap, JobFields.ChunksCompleted) < EffectiveChunkCount(snap))
                return MergeClaim.NotReady;

            var holder = GetString(snap, JobFields.MergeWorkerId);
            if (!string.IsNullOrEmpty(holder) && holder != opts.WorkerId
                && AgeMs(snap, JobFields.MergeClaimedAt) < opts.MergeLeaseSeconds * 1000L)
                return MergeClaim.Lost;

            tx.Update(jobRef, new Dictionary<string, object>
            {
                [JobFields.MergeWorkerId] = opts.WorkerId,
                [JobFields.MergeClaimedAt] = FieldValue.ServerTimestamp,
                [JobFields.MergeStartedAt] = FieldValue.ServerTimestamp,
                [JobFields.Stage] = "merging",
                [JobFields.ProgressStage] = "merging",
                [JobFields.Phase] = "merging",
                [JobFields.ProgressPercent] = 97,
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
                [JobFields.LastHeartbeatAt] = FieldValue.ServerTimestamp,
                [JobFields.HeartbeatAt] = FieldValue.ServerTimestamp,
                // Merge start is real progress (keeps the watchdog off a healthy merge).
                [JobFields.LastProgressAt] = FieldValue.ServerTimestamp,
            });
            return MergeClaim.Won;
        });
    }

    /// <summary>Fail the whole job from a permanently-failed chunk: release minutes
    /// once (terminal-guarded), set failed + chunksFailed++ + cancelRequested (so
    /// live sibling tasks' cancel-poll stops them fast).</summary>
    public Task<bool> FailJobFromChunkAsync(string uid, string jobId, string code, string message)
    {
        return db.RunTransactionAsync(async tx =>
        {
            var jobRef = JobRef(uid, jobId);
            var snap = await tx.GetSnapshotAsync(jobRef);
            if (!snap.Exists || JobFields.IsTerminal(GetString(snap, JobFields.Status))) return false;
            var month = GetString(snap, JobFields.MonthlyBucket) ?? CurrentMonthKey();
            var estimate = (int)GetLong(snap, JobFields.EstimatedExportMinutes);
            var failed = (int)GetLong(snap, JobFields.ChunksFailed) + 1;
            if (estimate > 0)
            {
                var usageRef = UsageRef(uid, month);
                var us = await tx.GetSnapshotAsync(usageRef);
                var reserved = GetLong(us, JobFields.CloudMinutesReserved);
                tx.Set(usageRef, new Dictionary<string, object?>
                {
                    [JobFields.CloudMinutesReserved] = Math.Max(0, reserved - estimate),
                    [JobFields.UpdatedAt] = NowMs(),
                }, SetOptions.MergeAll);
            }
            tx.Set(jobRef, new Dictionary<string, object?>
            {
                [JobFields.Status] = JobFields.Failed,
                [JobFields.ErrorCode] = code,
                [JobFields.ErrorMessage] = message,
                [JobFields.CancelRequested] = true,
                [JobFields.ChunksFailed] = failed,
                [JobFields.WorkerId] = opts.WorkerId,
                [JobFields.BuildVersion] = opts.BuildVersion,
                [JobFields.FailedAt] = FieldValue.ServerTimestamp,
                [JobFields.CompletedAt] = FieldValue.ServerTimestamp,
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            }, SetOptions.MergeAll);
            return true;
        });
    }

    /// <summary>Read all chunk markers (for the merge leader). Returns the snapshots
    /// keyed by index; missing indices are simply absent.</summary>
    public async Task<IReadOnlyDictionary<int, DocumentSnapshot>> GetChunkMarkersAsync(string uid, string jobId)
    {
        var col = JobRef(uid, jobId).Collection(JobFields.ChunksCollection);
        var snap = await col.GetSnapshotAsync();
        var map = new Dictionary<int, DocumentSnapshot>();
        foreach (var d in snap.Documents)
            if (int.TryParse(d.Id, out var i)) map[i] = d;
        return map;
    }

    // ── Settle on success (ports handler.ts success txn) ─────────────────────
    public Task<bool> SettleSuccessAsync(string uid, string jobId, string month, int estimate,
        string downloadUrl, IReadOnlyList<string> warnings, Dictionary<string, object?>? preflight)
    {
        return db.RunTransactionAsync(async tx =>
        {
            var jobRef = JobRef(uid, jobId);
            var snap = await tx.GetSnapshotAsync(jobRef);
            if (!snap.Exists) return false;
            // Don't double-settle: another re-claim or cancel may have finalized it.
            if (JobFields.IsTerminal(GetString(snap, JobFields.Status))) return false;

            var usageRef = UsageRef(uid, month);
            var usageSnap = await tx.GetSnapshotAsync(usageRef);
            var reserved = GetLong(usageSnap, JobFields.CloudMinutesReserved);
            var consumed = GetLong(usageSnap, JobFields.CloudMinutesConsumed);
            tx.Set(usageRef, new Dictionary<string, object?>
            {
                [JobFields.CloudMinutesReserved] = Math.Max(0, reserved - estimate),
                [JobFields.CloudMinutesConsumed] = Math.Max(0, consumed) + estimate,
                [JobFields.LastCloudExportAt] = NowMs(),
                [JobFields.UpdatedAt] = NowMs(),
            }, SetOptions.MergeAll);

            tx.Set(jobRef, new Dictionary<string, object?>
            {
                [JobFields.Status] = JobFields.Ready,
                [JobFields.Stage] = JobFields.Uploading,
                ["progressStage"] = "ready",
                [JobFields.Progress] = 1,
                [JobFields.DownloadUrl] = downloadUrl,
                [JobFields.ConsumedExportMinutes] = estimate,
                [JobFields.Warnings] = warnings.ToList(),
                [JobFields.Preflight] = preflight,
                [JobFields.CompletedAt] = FieldValue.ServerTimestamp,
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            }, SetOptions.MergeAll);
            return true;
        });
    }

    // ── Fail + release (ports handler.ts guarded catch) ──────────────────────
    public Task FailAndReleaseAsync(string uid, string jobId, string month, int estimate, string code, string message)
    {
        return db.RunTransactionAsync<bool>(async tx =>
        {
            var jobRef = JobRef(uid, jobId);
            var snap = await tx.GetSnapshotAsync(jobRef);
            if (!snap.Exists) return false;
            if (JobFields.IsTerminal(GetString(snap, JobFields.Status))) return false; // don't clobber/double-release

            if (estimate > 0)
            {
                var usageRef = UsageRef(uid, month);
                var usageSnap = await tx.GetSnapshotAsync(usageRef);
                var reserved = GetLong(usageSnap, JobFields.CloudMinutesReserved);
                tx.Set(usageRef, new Dictionary<string, object?>
                {
                    [JobFields.CloudMinutesReserved] = Math.Max(0, reserved - estimate),
                    [JobFields.UpdatedAt] = NowMs(),
                }, SetOptions.MergeAll);
            }
            tx.Set(jobRef, new Dictionary<string, object?>
            {
                [JobFields.Status] = JobFields.Failed,
                [JobFields.ErrorCode] = code,
                [JobFields.ErrorMessage] = message,
                [JobFields.WorkerId] = opts.WorkerId,
                [JobFields.BuildVersion] = opts.BuildVersion,
                [JobFields.FailedAt] = FieldValue.ServerTimestamp,
                [JobFields.CompletedAt] = FieldValue.ServerTimestamp,
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            }, SetOptions.MergeAll);
            return true;
        });
    }

    /// <summary>Fail a STALE active job ("stale") + release its reservation, reading
    /// its month/estimate from the doc. Used by the create-path dedup when an active
    /// job's heartbeat has expired. Guarded so it never clobbers a terminal job.</summary>
    public Task<bool> FailStaleAsync(string uid, string jobId)
    {
        return db.RunTransactionAsync(async tx =>
        {
            var jobRef = JobRef(uid, jobId);
            var snap = await tx.GetSnapshotAsync(jobRef);
            if (!snap.Exists || JobFields.IsTerminal(GetString(snap, JobFields.Status))) return false;
            var month = GetString(snap, JobFields.MonthlyBucket) ?? CurrentMonthKey();
            var estimate = (int)GetLong(snap, JobFields.EstimatedExportMinutes);
            if (estimate > 0)
            {
                var usageRef = UsageRef(uid, month);
                var us = await tx.GetSnapshotAsync(usageRef);
                var reserved = GetLong(us, JobFields.CloudMinutesReserved);
                tx.Set(usageRef, new Dictionary<string, object?>
                {
                    [JobFields.CloudMinutesReserved] = Math.Max(0, reserved - estimate),
                    [JobFields.UpdatedAt] = NowMs(),
                }, SetOptions.MergeAll);
            }
            tx.Set(jobRef, new Dictionary<string, object?>
            {
                [JobFields.Status] = JobFields.Failed,
                [JobFields.ErrorCode] = JobFields.ErrStale,
                [JobFields.ErrorMessage] = "This export timed out (the render service stopped responding). Please try again.",
                [JobFields.WorkerId] = opts.WorkerId,
                [JobFields.BuildVersion] = opts.BuildVersion,
                [JobFields.FailedAt] = FieldValue.ServerTimestamp,
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            }, SetOptions.MergeAll);
            return true;
        });
    }

    /// <summary>
    /// Startup-watchdog fail: mark a job failed + release its reservation ONLY while
    /// it is still pre-render (queued / batch_submitted). If a worker has already
    /// claimed it (rendering/uploading) or it's terminal, this is a no-op (returns
    /// false) — so it can never abort a render that legitimately got going. Returns
    /// true iff it actually failed the job.
    /// </summary>
    public Task<bool> FailIfNotStartedAsync(string uid, string jobId, string code, string message)
    {
        return db.RunTransactionAsync(async tx =>
        {
            var jobRef = JobRef(uid, jobId);
            var snap = await tx.GetSnapshotAsync(jobRef);
            if (!snap.Exists) return false;
            var status = GetString(snap, JobFields.Status);
            // Only intervene before a worker has claimed the job. rendering/uploading
            // (claimed) and terminal states are left untouched.
            if (status is not (JobFields.Queued or JobFields.BatchSubmitted)) return false;

            var month = GetString(snap, JobFields.MonthlyBucket) ?? CurrentMonthKey();
            var estimate = (int)GetLong(snap, JobFields.EstimatedExportMinutes);
            if (estimate > 0)
            {
                var usageRef = UsageRef(uid, month);
                var us = await tx.GetSnapshotAsync(usageRef);
                var reserved = GetLong(us, JobFields.CloudMinutesReserved);
                tx.Set(usageRef, new Dictionary<string, object?>
                {
                    [JobFields.CloudMinutesReserved] = Math.Max(0, reserved - estimate),
                    [JobFields.UpdatedAt] = NowMs(),
                }, SetOptions.MergeAll);
            }
            tx.Set(jobRef, new Dictionary<string, object?>
            {
                [JobFields.Status] = JobFields.Failed,
                [JobFields.ErrorCode] = code,
                [JobFields.ErrorMessage] = message,
                [JobFields.WorkerId] = opts.WorkerId,
                [JobFields.BuildVersion] = opts.BuildVersion,
                [JobFields.FailedAt] = FieldValue.ServerTimestamp,
                [JobFields.CompletedAt] = FieldValue.ServerTimestamp,
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            }, SetOptions.MergeAll);
            return true;
        });
    }

    /// <summary>Find a fresh identical active job (dedup), whether a DIFFERENT export
    /// is active (single-flight), and any STALE active jobs to clean up. Best-effort:
    /// a query failure returns "nothing found" so a create is never blocked by it.</summary>
    private async Task<(string? DuplicateJobId, bool OtherActive, List<string> StaleJobIds)>
        CheckActiveForDedupAsync(string uid, string projectId, string settingsHash)
    {
        var staleIds = new List<string>();
        string? dup = null;
        var other = false;
        try
        {
            var snap = await JobsCol(uid)
                .WhereIn(JobFields.Status, JobFields.ActiveStatuses)
                .Limit(10)
                .GetSnapshotAsync();
            foreach (var d in snap.Documents)
            {
                var beatField = d.ContainsField(JobFields.LastHeartbeatAt)
                    ? JobFields.LastHeartbeatAt
                    : JobFields.UpdatedAt;
                if (AgeMs(d, beatField) > opts.HeartbeatStaleSeconds * 1000L) { staleIds.Add(d.Id); continue; }
                if (GetString(d, "projectId") == projectId && GetString(d, JobFields.SettingsHash) == settingsHash)
                    dup = d.Id;
                else
                    other = true;
            }
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "[export:enqueue] dedup query failed (continuing) uid={Uid}", uid);
        }
        return (dup, other, staleIds);
    }

    // ── Cancel: authoritative release + canceled (ports cancel/route.ts) ─────
    public Task<string> CancelAsync(string uid, string jobId)
    {
        return db.RunTransactionAsync(async tx =>
        {
            var jobRef = JobRef(uid, jobId);
            var snap = await tx.GetSnapshotAsync(jobRef);
            if (!snap.Exists) return "missing";
            var status = GetString(snap, JobFields.Status);
            if (JobFields.IsTerminal(status)) return status!; // idempotent

            var month = GetString(snap, JobFields.MonthlyBucket) ?? CurrentMonthKey();
            var estimate = (int)GetLong(snap, JobFields.EstimatedExportMinutes);
            var usageRef = UsageRef(uid, month);
            var usageSnap = await tx.GetSnapshotAsync(usageRef);
            var reserved = GetLong(usageSnap, JobFields.CloudMinutesReserved);
            tx.Set(usageRef, new Dictionary<string, object?>
            {
                [JobFields.CloudMinutesReserved] = Math.Max(0, reserved - estimate),
                [JobFields.UpdatedAt] = NowMs(),
            }, SetOptions.MergeAll);

            tx.Set(jobRef, new Dictionary<string, object?>
            {
                [JobFields.Status] = JobFields.Canceled,
                [JobFields.CancelRequested] = true,
                [JobFields.CanceledAt] = FieldValue.ServerTimestamp,
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            }, SetOptions.MergeAll);
            return JobFields.Canceled;
        });
    }

    public async Task<bool> IsCancelRequestedAsync(string uid, string jobId)
    {
        var snap = await JobRef(uid, jobId).GetSnapshotAsync();
        if (!snap.Exists) return true; // gone → treat as canceled
        var status = GetString(snap, JobFields.Status);
        return status == JobFields.Canceled || (snap.ContainsField(JobFields.CancelRequested) && snap.GetValue<bool>(JobFields.CancelRequested));
    }

    public Task MirrorProjectExportUrlAsync(string uid, string projectId, string downloadUrl) =>
        db.Document($"users/{uid}/projects/{projectId}").SetAsync(new Dictionary<string, object?>
        { ["exportUrl"] = downloadUrl, ["updatedAt"] = NowMs() }, SetOptions.MergeAll);

    // ── Discovery: claimable queued jobs (poll) ──────────────────────────────
    public async Task<List<(string Uid, string JobId)>> FindClaimableAsync(int limit)
    {
        // Queued jobs (oldest-updated first). OrderBy(updatedAt) reuses the
        // existing (status, updatedAt) collection-group index that the reconciler
        // also uses — no new index needed. Stale in-flight jobs are recovered by
        // the reconciler; the claim txn re-checks the lease either way.
        QuerySnapshot snap;
        try
        {
            snap = await db.CollectionGroup("exportJobs")
                .WhereEqualTo(JobFields.Status, JobFields.Queued)
                .OrderBy(JobFields.UpdatedAt)
                .Limit(limit)
                .GetSnapshotAsync();
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "[export:poll] claimable query failed (index building?)");
            return new List<(string, string)>();
        }
        return snap.Documents.Select(d => (UidFromJobRef(d.Reference), d.Id)).ToList();
    }

    // ── Reconciler: fail + release stale non-terminal jobs ───────────────────
    public async Task<int> ReconcileStaleAsync(int batch)
    {
        var cutoff = Timestamp.FromDateTime(DateTime.UtcNow.AddSeconds(-opts.ReconcileStaleSeconds));
        QuerySnapshot snap;
        try
        {
            snap = await db.CollectionGroup("exportJobs")
                .WhereIn(JobFields.Status, JobFields.ActiveStatuses)
                .WhereLessThan(JobFields.UpdatedAt, cutoff)
                .Limit(batch)
                .GetSnapshotAsync();
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "[export:reconcile] query failed (index building?)");
            return 0;
        }

        var failed = 0;
        foreach (var doc in snap.Documents)
        {
            var uid = UidFromJobRef(doc.Reference);
            var jobId = doc.Id;
            var month = GetString(doc, JobFields.MonthlyBucket) ?? CurrentMonthKey();
            var estimate = (int)GetLong(doc, JobFields.EstimatedExportMinutes);
            try
            {
                var did = await db.RunTransactionAsync(async tx =>
                {
                    var s = await tx.GetSnapshotAsync(doc.Reference);
                    if (!s.Exists || JobFields.IsTerminal(GetString(s, JobFields.Status))) return false;
                    if (AgeMs(s, JobFields.UpdatedAt) < opts.ReconcileStaleSeconds * 1000L) return false; // got fresh
                    if (estimate > 0)
                    {
                        var usageRef = UsageRef(uid, month);
                        var us = await tx.GetSnapshotAsync(usageRef);
                        var reserved = GetLong(us, JobFields.CloudMinutesReserved);
                        tx.Set(usageRef, new Dictionary<string, object?>
                        {
                            [JobFields.CloudMinutesReserved] = Math.Max(0, reserved - estimate),
                            [JobFields.UpdatedAt] = NowMs(),
                        }, SetOptions.MergeAll);
                    }
                    tx.Set(doc.Reference, new Dictionary<string, object?>
                    {
                        [JobFields.Status] = JobFields.Failed,
                        [JobFields.ErrorCode] = JobFields.ErrStale,
                        [JobFields.ErrorMessage] = "This export stalled and was stopped. Please try exporting again.",
                        [JobFields.WorkerId] = opts.WorkerId,
                        [JobFields.BuildVersion] = opts.BuildVersion,
                        [JobFields.FailedAt] = FieldValue.ServerTimestamp,
                        [JobFields.CompletedAt] = FieldValue.ServerTimestamp,
                        [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
                    }, SetOptions.MergeAll);
                    return true;
                });
                if (did) failed++;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "[export:reconcile] failed to reconcile {Path}", doc.Reference.Path);
            }
        }
        if (failed > 0) log.LogInformation("[export:reconcile] swept stale jobs checked={Checked} failed={Failed}", snap.Count, failed);
        return failed;
    }

    // ── Reads ────────────────────────────────────────────────────────────────
    public async Task<DocumentSnapshot?> GetJobAsync(string uid, string jobId)
    {
        var snap = await JobRef(uid, jobId).GetSnapshotAsync();
        return snap.Exists ? snap : null;
    }

    /// <summary>Read just the job's current status (null if the doc is gone). Used by
    /// the single-job runner to derive its process exit code after the pipeline has
    /// already written the terminal state.</summary>
    public async Task<string?> GetJobStatusAsync(string uid, string jobId)
    {
        var snap = await JobRef(uid, jobId).GetSnapshotAsync();
        return snap.Exists ? GetString(snap, JobFields.Status) : null;
    }

    /// <summary>Read the job's terminal status + errorCode (both null if the doc is
    /// gone). The single-job runner uses the errorCode to pick a DETERMINISTIC
    /// (fatal, no-retry) vs transient process exit code.</summary>
    public async Task<(string? Status, string? ErrorCode)> GetJobStatusAndErrorAsync(string uid, string jobId)
    {
        var snap = await JobRef(uid, jobId).GetSnapshotAsync();
        return snap.Exists
            ? (GetString(snap, JobFields.Status), GetString(snap, JobFields.ErrorCode))
            : (null, null);
    }

    public JobView ToView(DocumentSnapshot snap) => new()
    {
        Id = snap.Id,
        UserId = GetString(snap, "userId"),
        ProjectId = GetString(snap, "projectId"),
        Status = GetString(snap, JobFields.Status),
        Stage = GetString(snap, JobFields.Stage),
        Progress = GetDouble(snap, JobFields.Progress),
        ProgressPercent = (int)Math.Round(GetDouble(snap, JobFields.Progress) * 100),
        ExportPath = GetString(snap, JobFields.ExportPath) ?? "cloud",
        SettingsHash = GetString(snap, JobFields.SettingsHash),
        BuildVersion = GetString(snap, JobFields.BuildVersion),
        WorkerId = GetString(snap, JobFields.WorkerId),
        DownloadUrl = GetString(snap, JobFields.DownloadUrl),
        ErrorCode = GetString(snap, JobFields.ErrorCode),
        ErrorMessage = GetString(snap, JobFields.ErrorMessage),
        CancelRequested = snap.ContainsField(JobFields.CancelRequested) ? snap.GetValue<bool>(JobFields.CancelRequested) : null,
        Warnings = snap.ContainsField(JobFields.Warnings) ? snap.GetValue<string[]>(JobFields.Warnings) : null,
        Preflight = snap.ContainsField(JobFields.Preflight) ? snap.GetValue<Dictionary<string, object>>(JobFields.Preflight) : null,
        OutputWidth = (int)GetLong(snap, "outputWidth"),
        OutputHeight = (int)GetLong(snap, "outputHeight"),
        Fps = (int)GetLong(snap, "fps"),
        DurationSeconds = GetDouble(snap, "durationSeconds"),
        EstimatedExportMinutes = (int)GetLong(snap, JobFields.EstimatedExportMinutes),
        ConsumedExportMinutes = snap.ContainsField(JobFields.ConsumedExportMinutes) ? (int)GetLong(snap, JobFields.ConsumedExportMinutes) : null,
        CreatedAt = TsMs(snap, "createdAt"),
        UpdatedAt = TsMs(snap, JobFields.UpdatedAt),
        StartedAt = TsMs(snap, JobFields.StartedAt),
        CompletedAt = TsMs(snap, JobFields.CompletedAt),
        FailedAt = TsMs(snap, JobFields.FailedAt),
        CanceledAt = TsMs(snap, JobFields.CanceledAt),
    };

    // ── helpers ──────────────────────────────────────────────────────────────
    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static string UidFromJobRef(DocumentReference r) =>
        // users/{uid}/exportJobs/{jobId} → parent (exportJobs) → parent (user doc) → id
        r.Parent.Parent?.Id ?? "";

    private static string? GetString(DocumentSnapshot s, string f) =>
        s.ContainsField(f) ? s.GetValue<object>(f)?.ToString() : null;

    private static long GetLong(DocumentSnapshot s, string f)
    {
        if (!s.Exists || !s.ContainsField(f)) return 0;
        return s.GetValue<object>(f) switch { long l => l, int i => i, double d => (long)d, _ => 0 };
    }

    private static double GetDouble(DocumentSnapshot s, string f)
    {
        if (!s.Exists || !s.ContainsField(f)) return 0;
        return s.GetValue<object>(f) switch { double d => d, long l => l, int i => i, _ => 0 };
    }

    private static long? TsMs(DocumentSnapshot s, string f)
    {
        if (!s.ContainsField(f)) return null;
        return s.GetValue<object>(f) switch
        {
            Timestamp t => t.ToDateTimeOffset().ToUnixTimeMilliseconds(),
            long l => l,
            double d => (long)d,
            _ => null,
        };
    }

    private static long AgeMs(DocumentSnapshot s, string f)
    {
        var ms = TsMs(s, f);
        return ms is null ? long.MaxValue : NowMs() - ms.Value;
    }
}
