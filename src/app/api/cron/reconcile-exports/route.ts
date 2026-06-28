import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import { isIndexError, tsComparand, uidFromSubDoc } from "@/lib/admin/query";
import {
  inspectBatchJob,
  cancelBatchJob,
  BatchCapacityError,
  BATCH_CAPACITY_ERROR_CODE,
  BATCH_CAPACITY_ERROR_MESSAGE,
} from "@/lib/export/batch-backend";
import { enqueueExportJob } from "@/lib/export/enqueue";
import { exportBackend } from "@/lib/export/dotnet-backend";
import {
  BATCH_SLOT_STATUSES,
  QUEUE_REASON_WAITING_FOR_SLOT,
  maxActiveBatchJobs,
  exportStaleProgressSeconds,
} from "@/lib/export/batch-capacity";
import type { ExportJobDoc, MonthlyUsage } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cron/reconcile-exports  (Cloud Scheduler cron)
 *
 * Recovers cloud-export jobs that will never finish, in two ways:
 *
 *  1. CAPACITY / pre-render cancel — a Batch job that submitted OK (doc →
 *     batch_submitted) but Google canceled/failed BEFORE any container started,
 *     most often because the region ran out of capacity
 *     (CODE_GCE_ZONE_RESOURCE_POOL_EXHAUSTED). No container = no heartbeat, so the
 *     time-based sweep below would only catch it after 10 min and mislabel it. We
 *     read the Batch job's status directly (inspectBatchJob) and fail it fast with
 *     `batch_capacity_unavailable` (or `batch_failed` for other terminal states).
 *
 *  2. STALE mid-render — a worker that crashed mid-render leaves the job stuck in
 *     a non-terminal state ("Rendering 0%") forever AND leaks its reserved
 *     minutes. No `updatedAt` write within STALE_MS (the worker heartbeats every
 *     60s, so a 10-min gap means a dead instance) → mark failed + release.
 *     (Jobs intentionally waiting for a Batch slot are EXEMPT — see #3.)
 *
 * Both paths idempotently release the job's reserved minutes.
 *
 * It ALSO promotes the global Batch export queue:
 *
 *  3. PROMOTE — jobs deferred at creation because the global active-Batch-export
 *     cap (EXPORT_MAX_ACTIVE_BATCH_JOBS) was hit sit in `queued` with
 *     `queueReason: waiting_for_slot` and were never submitted to Batch. When the
 *     active (submitted/running) count drops below the cap, submit the oldest
 *     waiting jobs to fill the freed slots.
 *
 * Auth: a shared secret in the `x-cron-secret` header (set on the Scheduler
 * job), compared in constant time against `EXPORT_RECONCILE_SECRET`. Fails
 * closed when the secret isn't configured.
 */
const STALE_MS = 10 * 60_000;
/** Error code + readable retry message written when the stale-progress watchdog
 *  cancels an export that made no real progress (Req: "Please retry."). */
const STALE_PROGRESS_ERROR_CODE = "stale_progress_timeout";
const STALE_PROGRESS_ERROR_MESSAGE =
  "Export stopped because no progress was detected. Please retry.";
/** Statuses where a worker is actively rendering, so REAL progress (lastProgressAt)
 *  is expected to advance — the stale-progress watchdog only inspects these. */
const RENDER_PROGRESS_STATUSES: ExportJobDoc["status"][] = ["rendering", "uploading"];
/** A batch_submitted job that hasn't progressed in this long is worth a Batch
 *  status check — catches a Google-canceled job in ~one cron tick instead of
 *  waiting out STALE_MS. Smaller cutoff ⇒ the stale set is a subset, so a single
 *  query (reusing the existing (status, updatedAt) index) feeds both passes. */
const PROVISION_STALL_MS = 90_000;
/** A promotion claim older than this is treated as abandoned (the prior cron run
 *  died mid-dispatch) and is retried, so a job can't get stuck "claimed". */
const PROMOTION_CLAIM_STALE_MS = 5 * 60_000;
const ACTIVE_STATUSES: ExportJobDoc["status"][] = [
  "queued",
  "batch_submitted",
  "rendering",
  "uploading",
];
/** Bound the per-run work; the cron re-runs and drains over multiple ticks. */
const BATCH = 200;

function authorized(req: NextRequest): boolean {
  const expected = process.env.EXPORT_RECONCILE_SECRET ?? "";
  if (!expected) return false; // misconfigured → reject (fail closed)
  const got = req.headers.get("x-cron-secret") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function toMillis(v: unknown): number {
  return (v as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
}

/**
 * Idempotently mark a job failed + release its reserved minutes, in one
 * transaction. Re-reads the doc so a worker that finished (or wrote fresh
 * progress) between the query and now is left alone. `requireStaleMs`, when set,
 * additionally bails if the job got a heartbeat within that window (the stale
 * sweep wants that guard; the Batch-status path already knows the job is dead).
 * Returns true iff this call performed the failure write.
 */
async function failJobAndRefund(
  db: FirebaseFirestore.Firestore,
  ref: FirebaseFirestore.DocumentReference,
  uid: string,
  fail: { errorCode: string; errorMessage: string },
  opts?: { requireStaleMs?: number; requireProgressStaleMs?: number; setCancelRequested?: boolean }
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const job = snap.data() as ExportJobDoc;
    if (!ACTIVE_STATUSES.includes(job.status)) return false; // already terminal
    if (opts?.requireStaleMs != null && Date.now() - toMillis(job.updatedAt) < opts.requireStaleMs) {
      return false; // got fresh heartbeat
    }
    if (opts?.requireProgressStaleMs != null) {
      // Re-check REAL progress in-txn: a chunk recorded between the query and now
      // (lastProgressAt advanced) means the job is healthy — leave it alone.
      const lastProgress =
        toMillis(job.lastProgressAt) || toMillis(job.startedAt) || toMillis(job.updatedAt);
      if (Date.now() - lastProgress < opts.requireProgressStaleMs) return false;
    }

    // Release the reserved minutes (clamp at 0 — same as the worker/cancel
    // paths). ALL reads happen before any writes per Firestore txn rules.
    const estimate = job.estimatedExportMinutes ?? 0;
    if (estimate > 0 && job.monthlyBucket) {
      const usageRef = db.doc(`users/${uid}/usage/${job.monthlyBucket}`);
      const uSnap = await tx.get(usageRef);
      const reserved = (uSnap.data() as MonthlyUsage | undefined)?.cloudMinutesReserved ?? 0;
      tx.set(
        usageRef,
        { cloudMinutesReserved: Math.max(0, reserved - estimate), updatedAt: Date.now() },
        { merge: true }
      );
    }

    tx.set(
      ref,
      {
        status: "failed",
        errorCode: fail.errorCode,
        errorMessage: fail.errorMessage,
        // Cooperative backstop to the real Batch cancel: a still-live sibling worker's
        // 1s cancel-poll sees this and exits fast (the Batch cancel tears the VM down).
        ...(opts?.setCancelRequested ? { cancelRequested: true } : {}),
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  });
}

/**
 * Promote deferred jobs (status `queued`, `queueReason: waiting_for_slot`) by
 * submitting them to Batch when the global active count is below the cap. Counts
 * SUBMITTED/running jobs (queued ones don't occupy a slot), then dispatches the
 * oldest waiting jobs to fill the freed slots. Each is claimed transactionally so
 * two overlapping cron runs can't double-submit the same job. Best-effort: index
 * errors / per-job dispatch errors are swallowed so the cron keeps draining.
 */
async function promoteQueuedJobs(
  db: FirebaseFirestore.Firestore
): Promise<{ submitted: number; activeBatchJobs: number; max: number }> {
  const max = maxActiveBatchJobs();

  let activeBatchJobs: number;
  try {
    const slotSnap = await db
      .collectionGroup("exportJobs")
      .where("status", "in", [...BATCH_SLOT_STATUSES])
      .count()
      .get();
    activeBatchJobs = slotSnap.data().count ?? 0;
  } catch (err) {
    if (isIndexError(err)) return { submitted: 0, activeBatchJobs: 0, max };
    throw err;
  }

  const available = max - activeBatchJobs;
  console.info("[reconcile-exports] queue promotion check", {
    activeBatchJobs,
    maxActiveBatchJobs: max,
    available,
  });
  if (available <= 0) return { submitted: 0, activeBatchJobs, max };

  // Fetch deferred queued jobs and pick the oldest in memory — a plain
  // `status == "queued"` collection-group query reuses the single-field index the
  // cap already needs, avoiding a new (status, createdAt) composite index.
  let candidates: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const snap = await db
      .collectionGroup("exportJobs")
      .where("status", "==", "queued")
      .limit(BATCH)
      .get();
    candidates = snap.docs;
  } catch (err) {
    if (isIndexError(err)) return { submitted: 0, activeBatchJobs, max };
    throw err;
  }

  const now = Date.now();
  const waiting = candidates
    .map((d) => ({ d, job: d.data() as ExportJobDoc }))
    .filter(
      ({ job }) =>
        job.queueReason === QUEUE_REASON_WAITING_FOR_SLOT &&
        job.cancelRequested !== true &&
        now - toMillis(job.promotionClaimedAt) > PROMOTION_CLAIM_STALE_MS
    )
    .sort((a, b) => toMillis(a.job.createdAt) - toMillis(b.job.createdAt));

  let submitted = 0;
  for (const { d, job } of waiting) {
    if (submitted >= available) break;
    const uid = uidFromSubDoc(d.ref);
    if (!uid) continue;

    // Claim transactionally — overlapping cron runs see the fresh claim and skip.
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(d.ref);
      if (!snap.exists) return false;
      const j = snap.data() as ExportJobDoc;
      if (
        j.status !== "queued" ||
        j.queueReason !== QUEUE_REASON_WAITING_FOR_SLOT ||
        j.cancelRequested === true
      ) {
        return false;
      }
      if (j.promotionClaimedAt && now - toMillis(j.promotionClaimedAt) <= PROMOTION_CLAIM_STALE_MS) {
        return false; // freshly claimed by another run
      }
      tx.set(
        d.ref,
        { promotionClaimedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      return true;
    });
    if (!claimed) continue;

    try {
      await enqueueExportJob({
        uid,
        jobId: d.id,
        priority: job.priority === "priority" ? "priority" : "normal",
        renderMode: job.renderMode,
        ...(job.renderMode === "chunked"
          ? {
              chunkCount: job.chunkCount,
              chunkSeconds: job.chunkSeconds,
              // workerCount is the shard/task count; fall back to chunkParallelism
              // for docs created before the sharding change.
              workerCount: job.workerCount ?? job.chunkParallelism,
              durationSeconds: job.durationSeconds,
            }
          : {}),
      });
      submitted++;
      console.info("[reconcile-exports] submitted after slot opened", {
        jobId: d.id,
        uid,
        activeBatchJobs: activeBatchJobs + submitted,
        maxActiveBatchJobs: max,
      });
    } catch (err) {
      if (err instanceof BatchCapacityError) {
        // Whole region is out of capacity — fail this one cleanly + refund, and
        // STOP (further submits this tick would hit the same wall).
        await failJobAndRefund(db, d.ref, uid, {
          errorCode: BATCH_CAPACITY_ERROR_CODE,
          errorMessage: BATCH_CAPACITY_ERROR_MESSAGE,
        }).catch(() => {});
        console.warn("[reconcile-exports] promotion hit capacity — stopping this tick", {
          jobId: d.id,
        });
        break;
      }
      // Transient dispatch error — release the claim so it retries next tick.
      await d.ref
        .set(
          { promotionClaimedAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        )
        .catch(() => {});
      console.error("[reconcile-exports] promotion dispatch failed", { jobId: d.id, err });
    }
  }

  return { submitted, activeBatchJobs, max };
}

/**
 * Stale-PROGRESS watchdog — the cost-safety kill switch. A worker heartbeats every
 * 30s (keeping `updatedAt` fresh) even when it is rendering NOTHING, so the
 * `updatedAt` stale sweep below can NEVER catch an alive-but-stuck worker. This pass
 * keys off `lastProgressAt` (last chunk recorded / real progress, never bumped by the
 * bare heartbeat) instead: a `rendering`/`uploading` export with no progress for
 * `EXPORT_STALE_PROGRESS_SECONDS` (default 720) gets its real Google Batch job
 * CANCELLED (so the up-to-8 VMs stop billing — not just a Firestore write) and is
 * failed `stale_progress_timeout` with a clear retry message.
 *
 * The `status in (rendering, uploading)` collection-group query reuses the same
 * single-field index the promotion pass uses for `status == queued`; `lastProgressAt`
 * is filtered in memory (the active-render set is bounded by the global active-job
 * cap, default 1), so NO new composite index is needed. Best-effort: an index error
 * degrades to a no-op.
 */
async function sweepStaleProgress(db: FirebaseFirestore.Firestore): Promise<number> {
  const staleSecondsThreshold = exportStaleProgressSeconds();
  const thresholdMs = staleSecondsThreshold * 1000;

  let docs: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const snap = await db
      .collectionGroup("exportJobs")
      .where("status", "in", [...RENDER_PROGRESS_STATUSES])
      .limit(BATCH)
      .get();
    docs = snap.docs;
  } catch (err) {
    if (isIndexError(err)) return 0;
    throw err;
  }

  const now = Date.now();
  let failed = 0;
  for (const d of docs) {
    const uid = uidFromSubDoc(d.ref);
    if (!uid) continue;
    const job = d.data() as ExportJobDoc;
    const lastProgress =
      toMillis(job.lastProgressAt) || toMillis(job.startedAt) || toMillis(job.updatedAt);
    if (!lastProgress) continue; // no progress baseline yet — judge it next tick
    const staleSeconds = (now - lastProgress) / 1000;
    if (staleSeconds < staleSecondsThreshold) continue;

    console.warn("[reconcile-exports] stale-progress watchdog cancelling Batch job", {
      exportId: d.id,
      batchJobName: job.batchJobName ?? job.batchJobId ?? null,
      lastProgressAt: new Date(lastProgress).toISOString(),
      staleSeconds: Math.round(staleSeconds),
      reason: STALE_PROGRESS_ERROR_CODE,
    });

    // Cancel the REAL Batch job FIRST so its VMs are torn down + stop billing — a
    // Firestore-only write would leave them running to the task timeout. Best-effort
    // and never throws; we fail the doc regardless of the cancel result.
    if (job.batchJobName || job.batchJobId) {
      try {
        await cancelBatchJob({ jobName: job.batchJobName, batchJobId: job.batchJobId });
      } catch (err) {
        console.error("[reconcile-exports] stale-progress cancelBatchJob threw", {
          exportId: d.id,
          err,
        });
      }
    }

    const didFail = await failJobAndRefund(
      db,
      d.ref,
      uid,
      { errorCode: STALE_PROGRESS_ERROR_CODE, errorMessage: STALE_PROGRESS_ERROR_MESSAGE },
      { requireProgressStaleMs: thresholdMs, setCancelRequested: true }
    );
    if (didFail) failed++;
  }
  return failed;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { db } = getAdmin();
  // Query at the SMALLER cutoff so jobs that stalled provisioning (~90s) are
  // available for a Batch-status check. The 10-min stale set is a subset, so this
  // one query (same (status, updatedAt) index) feeds both passes below.
  const cutoff = tsComparand(Date.now() - PROVISION_STALL_MS);

  let docs: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const snap = await db
      .collectionGroup("exportJobs")
      .where("status", "in", ACTIVE_STATUSES)
      .where("updatedAt", "<", cutoff)
      .limit(BATCH)
      .get();
    docs = snap.docs;
  } catch (err) {
    // The composite index (status, updatedAt) may still be building — degrade
    // gracefully so the cron doesn't 500 while it comes online.
    if (isIndexError(err)) {
      return NextResponse.json({ ok: true, indexBuilding: true, checked: 0, failed: 0 });
    }
    console.error("[reconcile-exports] query failed", err);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }

  let failed = 0;
  let capacityFailed = 0;
  for (const d of docs) {
    const uid = uidFromSubDoc(d.ref);
    if (!uid) continue;
    const job = d.data() as ExportJobDoc;
    try {
      // 1) Batch cancel/fail at ANY submitted stage. A batch_submitted job whose
      //    container never started writes no progress; a rendering/uploading job
      //    whose Batch job was cancelled/deleted (or whose merge leader died) leaves
      //    the doc stuck "rendering" — the UI shows "Rendering chunks: 0/N" forever.
      //    Ask Batch directly for ALL submitted-stage statuses (not just
      //    batch_submitted): a terminal Batch state (CANCELLED/FAILED/_IN_PROGRESS)
      //    fails it fast. Healthy jobs report QUEUED/SCHEDULED/RUNNING → not
      //    terminalBad → fall through to the time-based stale check. (A null/missing
      //    inspection is AMBIGUOUS — control-plane blip vs deleted — so it's left to
      //    the 10-min stale sweep rather than risk failing a healthy job on a blip.)
      const submittedStage =
        job.status === "batch_submitted" ||
        job.status === "rendering" ||
        job.status === "uploading";
      if (submittedStage && (job.batchJobName || job.batchJobId)) {
        const inspection = await inspectBatchJob({
          jobName: job.batchJobName,
          batchJobId: job.batchJobId,
        });
        if (inspection?.terminalBad) {
          const fail = inspection.capacityExhausted
            ? { errorCode: BATCH_CAPACITY_ERROR_CODE, errorMessage: BATCH_CAPACITY_ERROR_MESSAGE }
            : {
                errorCode: "batch_failed",
                errorMessage:
                  "The export was stopped by the render service before it finished. Please try again.",
              };
          const didFail = await failJobAndRefund(db, d.ref, uid, fail);
          if (didFail) {
            failed++;
            if (inspection.capacityExhausted) capacityFailed++;
            console.info("[reconcile-exports] failed job with terminal Batch state", {
              jobId: d.id,
              status: job.status,
              batchState: inspection.state,
              capacityExhausted: inspection.capacityExhausted,
            });
          }
          continue; // handled — don't also stale-sweep this doc
        }
      }

      // 2) Stale mid-render sweep (unchanged): worker started then died.
      //    EXEMPT jobs intentionally waiting for a Batch slot — they have no
      //    progress BY DESIGN (not submitted yet); the promotion pass owns them.
      const waitingForSlot =
        job.status === "queued" && job.queueReason === QUEUE_REASON_WAITING_FOR_SLOT;
      if (!waitingForSlot && Date.now() - toMillis(job.updatedAt) >= STALE_MS) {
        // A dead-heartbeat job may still have a wedged (not-yet-exited) Batch task
        // billing a VM — cancel the real job too, not just the Firestore doc.
        if (job.batchJobName || job.batchJobId) {
          await cancelBatchJob({ jobName: job.batchJobName, batchJobId: job.batchJobId }).catch(
            () => {}
          );
        }
        const didFail = await failJobAndRefund(
          db,
          d.ref,
          uid,
          {
            errorCode: "stale_timeout",
            errorMessage: "This export stalled and was stopped. Please try exporting again.",
          },
          { requireStaleMs: STALE_MS, setCancelRequested: true }
        );
        if (didFail) failed++;
      }
    } catch (err) {
      console.error("[reconcile-exports] reconcile failed", { path: d.ref.path, err });
    }
  }

  if (failed > 0) {
    console.info("[reconcile-exports] swept jobs", {
      checked: docs.length,
      failed,
      capacityFailed,
    });
  }

  // Stale-PROGRESS watchdog: cancel + fail rendering jobs whose lastProgressAt has
  // frozen (alive-but-stuck workers the updatedAt sweep above can't see). Cancels the
  // real Batch job so its VMs stop billing. Best-effort — never blocks promotion.
  let staleProgressFailed = 0;
  try {
    staleProgressFailed = await sweepStaleProgress(db);
  } catch (err) {
    console.error("[reconcile-exports] stale-progress sweep failed", err);
  }

  // Promote deferred jobs into any freed Batch slots (Batch backend only — other
  // backends manage their own concurrency / claiming).
  let promoted = 0;
  try {
    if (exportBackend() === "batch") {
      const res = await promoteQueuedJobs(db);
      promoted = res.submitted;
    }
  } catch (err) {
    console.error("[reconcile-exports] promotion failed", err);
  }

  return NextResponse.json({
    ok: true,
    checked: docs.length,
    failed,
    capacityFailed,
    staleProgressFailed,
    promoted,
  });
}
