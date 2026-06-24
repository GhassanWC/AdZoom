import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import { isIndexError, tsComparand, uidFromSubDoc } from "@/lib/admin/query";
import {
  inspectBatchJob,
  BATCH_CAPACITY_ERROR_CODE,
  BATCH_CAPACITY_ERROR_MESSAGE,
} from "@/lib/export/batch-backend";
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
 *
 * Both paths idempotently release the job's reserved minutes.
 *
 * Auth: a shared secret in the `x-cron-secret` header (set on the Scheduler
 * job), compared in constant time against `EXPORT_RECONCILE_SECRET`. Fails
 * closed when the secret isn't configured.
 */
const STALE_MS = 10 * 60_000;
/** A batch_submitted job that hasn't progressed in this long is worth a Batch
 *  status check — catches a Google-canceled job in ~one cron tick instead of
 *  waiting out STALE_MS. Smaller cutoff ⇒ the stale set is a subset, so a single
 *  query (reusing the existing (status, updatedAt) index) feeds both passes. */
const PROVISION_STALL_MS = 90_000;
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
  opts?: { requireStaleMs?: number }
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const job = snap.data() as ExportJobDoc;
    if (!ACTIVE_STATUSES.includes(job.status)) return false; // already terminal
    if (opts?.requireStaleMs != null && Date.now() - toMillis(job.updatedAt) < opts.requireStaleMs) {
      return false; // got fresh progress
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
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  });
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
      // 1) Pre-render Batch cancel/fail: a batch_submitted job whose container
      //    never started writes no progress, so ask Batch directly. Healthy
      //    provisioning jobs report QUEUED/SCHEDULED/RUNNING → not terminalBad →
      //    fall through to the time-based stale check.
      if (job.status === "batch_submitted" && (job.batchJobName || job.batchJobId)) {
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
          }
          continue; // handled — don't also stale-sweep this doc
        }
      }

      // 2) Stale mid-render sweep (unchanged): worker started then died.
      if (Date.now() - toMillis(job.updatedAt) >= STALE_MS) {
        const didFail = await failJobAndRefund(
          db,
          d.ref,
          uid,
          {
            errorCode: "stale_timeout",
            errorMessage: "This export stalled and was stopped. Please try exporting again.",
          },
          { requireStaleMs: STALE_MS }
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
  return NextResponse.json({ ok: true, checked: docs.length, failed, capacityFailed });
}
