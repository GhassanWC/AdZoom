import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import { isIndexError, tsComparand, uidFromSubDoc } from "@/lib/admin/query";
import type { ExportJobDoc, MonthlyUsage } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cron/reconcile-exports  (Cloud Scheduler cron)
 *
 * Recovers STALE cloud-export jobs: a worker that crashed mid-render leaves the
 * job stuck in a non-terminal state ("Rendering 0%") forever AND leaks its
 * reserved minutes. This reconciler finds such jobs (no `updatedAt` write within
 * STALE_MS — the worker heartbeats every 60s, so a 10-min gap means a dead
 * instance, not a slow-but-healthy pass) and, idempotently, marks them failed +
 * releases their reservation.
 *
 * Auth: a shared secret in the `x-cron-secret` header (set on the Scheduler
 * job), compared in constant time against `EXPORT_RECONCILE_SECRET`. Fails
 * closed when the secret isn't configured.
 */
const STALE_MS = 10 * 60_000;
const ACTIVE_STATUSES: ExportJobDoc["status"][] = ["queued", "rendering", "uploading"];
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

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { db } = getAdmin();
  const cutoff = tsComparand(Date.now() - STALE_MS);

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
  for (const d of docs) {
    const uid = uidFromSubDoc(d.ref);
    if (!uid) continue;
    try {
      const didFail = await db.runTransaction(async (tx) => {
        // Re-read inside the txn — the worker may have finished or written fresh
        // progress between the query and now.
        const snap = await tx.get(d.ref);
        if (!snap.exists) return false;
        const job = snap.data() as ExportJobDoc;
        if (!ACTIVE_STATUSES.includes(job.status)) return false; // already terminal
        if (Date.now() - toMillis(job.updatedAt) < STALE_MS) return false; // got fresh

        // Release the reserved minutes (clamp at 0 — same as the worker/cancel
        // paths). ALL reads happen before any writes per Firestore txn rules.
        const estimate = job.estimatedExportMinutes ?? 0;
        if (estimate > 0 && job.monthlyBucket) {
          const usageRef = db.doc(`users/${uid}/usage/${job.monthlyBucket}`);
          const uSnap = await tx.get(usageRef);
          const reserved =
            (uSnap.data() as MonthlyUsage | undefined)?.cloudMinutesReserved ?? 0;
          tx.set(
            usageRef,
            { cloudMinutesReserved: Math.max(0, reserved - estimate), updatedAt: Date.now() },
            { merge: true }
          );
        }

        tx.set(
          d.ref,
          {
            status: "failed",
            errorCode: "stale_timeout",
            errorMessage: "This export stalled and was stopped. Please try exporting again.",
            completedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return true;
      });
      if (didFail) failed++;
    } catch (err) {
      console.error("[reconcile-exports] reconcile failed", { path: d.ref.path, err });
    }
  }

  if (failed > 0) console.info("[reconcile-exports] swept stale jobs", { checked: docs.length, failed });
  return NextResponse.json({ ok: true, checked: docs.length, failed });
}
