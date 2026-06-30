import { NextResponse, type NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import { exportBackend, dotnetCancel } from "@/lib/export/dotnet-backend";
import { cancelBatchJob } from "@/lib/export/batch-backend";
import { cancelRemotionExecution } from "@/lib/export/remotion-backend";
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

    // dotnet backend: cancellation is authoritative in the C# API (it releases
    // minutes + sets canceled; its runner kills the in-flight render). On 404 or
    // success we're done; on any other failure (or missing config) we fall through
    // to the local transaction.
    //
    // The fallback is double-release SAFE: C#'s cancel does the minute release AND
    // status=canceled in ONE atomic Firestore transaction, and the local txn below
    // reads+writes the SAME job + usage docs — so Firestore serializes them. If C#
    // already canceled, the local txn reads the terminal status and returns BEFORE
    // touching the usage doc (the guard at the top of the txn), releasing exactly
    // once. (Invariant: C#'s release+status flip MUST stay in one transaction.)
    if (exportBackend() === "dotnet") {
      try {
        const r = await dotnetCancel(uid, jobId);
        if (r) {
          console.log(`[export-cancel] backend=dotnet proxied job=${jobId} status=${r.status} state=${r.state ?? ""}`);
          if (r.status === 404) {
            return NextResponse.json({ error: "Export job not found." }, { status: 404 });
          }
          if (r.ok) {
            return NextResponse.json({ ok: true, state: r.state ?? "canceled" });
          }
          console.warn(`[export-cancel] backend=dotnet proxy non-2xx (${r.status}) — local fallback`, { jobId });
        } else {
          console.warn("[export-cancel] backend=dotnet but EXPORT_API_URL/secret missing — local fallback", { jobId });
        }
      } catch (err) {
        console.warn("[export-cancel] backend=dotnet proxy failed — local fallback", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return { status: 404 as const };
      const job = snap.data() as ExportJobDoc;
      // Captured for the post-txn teardown (stop the VM/execution so it can't keep
      // charging after we mark the job canceled).
      const batch = {
        priorStatus: job.status,
        batchJobName: job.batchJobName ?? null,
        batchJobId: job.batchJobId ?? null,
        remotionExecutionName: job.remotionExecutionName ?? null,
      };

      // Already terminal — nothing to do (idempotent).
      if (job.status === "ready" || job.status === "failed" || job.status === "canceled") {
        return { status: 200 as const, state: job.status, ...batch };
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
      const u = usageSnap.data() as
        | { cloudMinutesReserved?: number; exportsUsedThisMonth?: number }
        | undefined;
      // Release the minutes reservation AND refund the monthly export COUNT (so a
      // canceled export doesn't burn a Free user's 2/month) when the job still
      // holds the slot.
      const countApplied = job.monthlyUsageApplied === true;
      tx.set(
        usageRef,
        {
          cloudMinutesReserved: Math.max(0, (u?.cloudMinutesReserved ?? 0) - (job.estimatedExportMinutes ?? 0)),
          ...(countApplied
            ? { exportsUsedThisMonth: Math.max(0, (u?.exportsUsedThisMonth ?? 0) - 1) }
            : {}),
          updatedAt: Date.now(),
        },
        { merge: true }
      );
      tx.set(
        jobRef,
        {
          status: "canceled",
          cancelRequested: true,
          ...(countApplied ? { monthlyUsageApplied: false } : {}),
          canceledAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { status: 200 as const, state: "canceled" as const, ...batch };
    });

    console.log(
      `[export-cancel] local txn job=${jobId} result=${result.status === 404 ? "404" : result.state}`
    );
    if (result.status === 404) {
      return NextResponse.json({ error: "Export job not found." }, { status: 404 });
    }

    // Stop the Google Cloud Batch VM so a canceled export stops billing. The
    // Firestore flag alone doesn't stop Batch — without this the task keeps
    // RUNNING (and charging) until it finishes or hits BATCH_MAX_RUN_SECONDS.
    // Only when a Batch job exists AND the worker could still be running it:
    // skip ready/failed (the worker already exited → VM gone), but DO try for a
    // job that was already `canceled` (a prior cancel may not have stopped it).
    if (
      (result.batchJobName || result.batchJobId) &&
      result.priorStatus !== "ready" &&
      result.priorStatus !== "failed"
    ) {
      try {
        const stopped = await cancelBatchJob({
          jobName: result.batchJobName,
          batchJobId: result.batchJobId,
        });
        console.log(
          `[export-cancel] batch teardown job=${jobId} priorStatus=${result.priorStatus} stopped=${stopped}`
        );
      } catch (err) {
        // Never fail the user's cancel on a Batch teardown error — the worker's
        // cancel-poll still exits, and the stale reconciler/max-run ceiling is the
        // final backstop. Surface it for ops.
        console.error("[export-cancel] batch teardown threw (job already canceled in Firestore)", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Stop the Remotion Cloud Run Job execution so a canceled export stops billing.
    // The worker's own cancelRequested poll is the backstop that aborts the render;
    // this only tears the VM down sooner. Best-effort — never fails the cancel.
    if (
      result.remotionExecutionName &&
      result.priorStatus !== "ready" &&
      result.priorStatus !== "failed"
    ) {
      try {
        const stopped = await cancelRemotionExecution({ executionName: result.remotionExecutionName });
        console.log(
          `[export-cancel] remotion teardown job=${jobId} priorStatus=${result.priorStatus} stopped=${stopped}`
        );
      } catch (err) {
        console.error("[export-cancel] remotion teardown threw (job already canceled in Firestore)", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json({ ok: true, state: result.state });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Cancel failed.";
    console.error("[export-cancel] failed", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
