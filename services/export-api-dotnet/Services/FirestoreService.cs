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
                ["outputWidth"] = req.OutputWidth,
                ["outputHeight"] = req.OutputHeight,
                ["fps"] = req.Fps,
                ["durationSeconds"] = req.DurationSeconds,
                [JobFields.EstimatedExportMinutes] = estimate,
                [JobFields.Progress] = 0,
                [JobFields.Stage] = JobFields.Queued,
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

    public async Task<(ClaimResult Result, DocumentSnapshot? Snap)> TryClaimAsync(string uid, string jobId)
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
            if (inFlight && AgeMs(snap, JobFields.UpdatedAt) < opts.HeartbeatStaleSeconds * 1000L)
                return ClaimResult.Leased;

            if (inFlight)
                log.LogWarning("[export:reclaim] stale in-flight job re-claimed uid={Uid} jobId={JobId} status={Status}", uid, jobId, status);

            tx.Update(jobRef, new Dictionary<string, object>
            {
                [JobFields.Status] = JobFields.Rendering,
                [JobFields.Stage] = "downloading",
                ["progressStage"] = "preparing",
                // Multi-VM attribution + liveness — which worker took the job, when.
                ["workerId"] = opts.WorkerId,
                ["claimedAt"] = FieldValue.ServerTimestamp,
                ["lastHeartbeatAt"] = FieldValue.ServerTimestamp,
                [JobFields.Progress] = 0,
                [JobFields.StartedAt] = FieldValue.ServerTimestamp,
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            });
            claimed = snap;
            return ClaimResult.Claimed;
        });
        return (result, result == ClaimResult.Claimed ? claimed : null);
    }

    /// <summary>Merge a patch + bump updatedAt (server timestamp). Used for stage/progress/heartbeat.</summary>
    public Task PatchAsync(string uid, string jobId, Dictionary<string, object?> data)
    {
        data[JobFields.UpdatedAt] = FieldValue.ServerTimestamp;
        return JobRef(uid, jobId).SetAsync(data, SetOptions.MergeAll);
    }

    public Task HeartbeatAsync(string uid, string jobId) =>
        JobRef(uid, jobId).SetAsync(new Dictionary<string, object>
        {
            [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            ["lastHeartbeatAt"] = FieldValue.ServerTimestamp,
        }, SetOptions.MergeAll);

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
                [JobFields.CompletedAt] = FieldValue.ServerTimestamp,
                [JobFields.UpdatedAt] = FieldValue.ServerTimestamp,
            }, SetOptions.MergeAll);
            return true;
        });
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
                        [JobFields.ErrorCode] = "stale_timeout",
                        [JobFields.ErrorMessage] = "This export stalled and was stopped. Please try exporting again.",
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

    public JobView ToView(DocumentSnapshot snap) => new()
    {
        Id = snap.Id,
        UserId = GetString(snap, "userId"),
        ProjectId = GetString(snap, "projectId"),
        Status = GetString(snap, JobFields.Status),
        Stage = GetString(snap, JobFields.Stage),
        Progress = GetDouble(snap, JobFields.Progress),
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
