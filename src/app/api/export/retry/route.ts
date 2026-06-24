import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { createCloudExportJob } from "@/lib/export/create-job";
import { isCloudExportEnabled } from "@/lib/export/feature";
import type { ExportJobDoc, SerializedRenderRecipe } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/export/retry  { jobId }
 *
 * Re-runs a prior cloud export from its stored `renderRecipe`. Reuses the shared
 * `createCloudExportJob` pipeline, so it gets the SAME duplicate-prevention rules:
 *   • If an identical export is already active, it returns that job (no dup).
 *   • Otherwise it mints a FRESH jobId from the prior recipe.
 * A retry of a terminal (failed/canceled/ready) job always creates a clean job.
 */
export async function POST(req: NextRequest) {
  try {
    if (!isCloudExportEnabled()) {
      return NextResponse.json(
        { error: "Cloud export is not enabled.", kind: "cloud_export_disabled" },
        { status: 503 }
      );
    }

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
      console.error("[export-retry] token verify failed", err);
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as { jobId?: string };
    const jobId = body.jobId;
    if (typeof jobId !== "string" || !jobId) {
      return NextResponse.json({ error: "Body must include { jobId }" }, { status: 400 });
    }

    const snap = await db.doc(`users/${uid}/exportJobs/${jobId}`).get();
    if (!snap.exists) {
      return NextResponse.json({ error: "Export job not found." }, { status: 404 });
    }
    const job = snap.data() as ExportJobDoc;
    const recipe = job.renderRecipe as SerializedRenderRecipe | undefined;
    if (!recipe) {
      return NextResponse.json(
        { error: "This export can't be retried (its render recipe is missing). Re-export from the project." },
        { status: 400 }
      );
    }

    const result = await createCloudExportJob(db, {
      uid,
      projectId: job.projectId,
      projectTitle: job.projectTitle,
      resolution: recipe.resolution,
      fps: recipe.fps,
      format: recipe.format,
      sourceWidth: recipe.sourceWidth,
      sourceHeight: recipe.sourceHeight,
      sourceDuration: recipe.sourceDuration,
      moments: recipe.moments,
      effects: recipe.effects,
      sourceCrop: recipe.sourceCrop,
      visualAnalysis: recipe.visualAnalysis,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          kind: result.kind,
          ...(result.remaining != null ? { remaining: result.remaining } : {}),
          ...(result.requested != null ? { requested: result.requested } : {}),
        },
        { status: result.status }
      );
    }

    console.log("[export-retry] ok", { uid, fromJobId: jobId, jobId: result.jobId, deduped: result.deduped });
    return NextResponse.json({
      ok: true,
      jobId: result.jobId,
      deduped: result.deduped,
      queuedForSlot: result.queuedForSlot ?? false,
      estimatedExportMinutes: result.estimatedExportMinutes,
      outputDurationSeconds: result.outputDurationSeconds,
      plan: result.plan,
      priority: result.priority,
      limit: result.limit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Retry failed.";
    console.error("[export-retry] failed", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
