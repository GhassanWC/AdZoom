import { NextResponse, type NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import type { ExportJobDoc } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/export/cancel  { jobId }
 *
 * Requests cancellation of a cloud export job. The client never writes job docs
 * directly (Firestore rules forbid it), so cancel routes through here: we verify
 * ownership and set `cancelRequested:true`. The worker polls this flag between
 * frames and tears down both ffmpeg processes, sets `status:"canceled"`, and
 * releases the minute reservation. A job that hasn't been picked up yet is
 * short-circuited to `canceled` here so it never renders.
 *
 * Idempotent + safe: terminal jobs (ready/failed/canceled) are left untouched.
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
    }

    const { auth, db } = getAdmin();
    let uid: string;
    try {
      const decoded = await auth.verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (err) {
      console.error("[export-cancel] token verify failed", err);
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as { jobId?: string };
    const jobId = body.jobId;
    if (typeof jobId !== "string" || !jobId) {
      return NextResponse.json({ error: "Body must include { jobId }" }, { status: 400 });
    }

    const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return { status: 404 as const };
      const job = snap.data() as ExportJobDoc;

      // Already terminal — nothing to do (idempotent).
      if (job.status === "ready" || job.status === "failed" || job.status === "canceled") {
        return { status: 200 as const, state: job.status };
      }

      // The cancel route is AUTHORITATIVE for cancellation: for ANY non-terminal
      // job (queued | rendering | uploading) we finalize it here and now —
      // release the reservation + set status="canceled" + raise cancelRequested.
      // This means cancel is INSTANT and reliable even if the worker has died
      // mid-render (the old code only flagged a rendering job and depended on a
      // live worker to release, so a crashed worker left it stuck forever). A
      // still-running worker sees the flag, kills ffmpeg, and — seeing the job
      // already canceled — does NOT release again (no double-spend).
      const usageRef = db.doc(`users/${uid}/usage/${job.monthlyBucket}`);
      const usageSnap = await tx.get(usageRef);
      const reserved =
        (usageSnap.data() as { cloudMinutesReserved?: number } | undefined)
          ?.cloudMinutesReserved ?? 0;
      tx.set(
        usageRef,
        {
          cloudMinutesReserved: Math.max(0, reserved - (job.estimatedExportMinutes ?? 0)),
          updatedAt: Date.now(),
        },
        { merge: true }
      );
      tx.set(
        jobRef,
        {
          status: "canceled",
          cancelRequested: true,
          canceledAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { status: 200 as const, state: "canceled" as const };
    });

    if (result.status === 404) {
      return NextResponse.json({ error: "Export job not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, state: result.state });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Cancel failed.";
    console.error("[export-cancel] failed", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
