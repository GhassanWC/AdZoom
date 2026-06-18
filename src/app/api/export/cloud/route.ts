import { NextResponse, type NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import { getUserPlan } from "@/lib/usage/gating";
import { currentMonthKey } from "@/lib/usage/usage";
import { normalizePlan } from "@/lib/usage/plan";
import {
  CLOUD_EXPORT_MINUTES,
  CloudExportNotAllowedError,
  CloudMinutesError,
  canCloudExport,
  cloudMinutesRemaining,
  estimateExportMinutes,
  planAllowsCloudExport,
} from "@/lib/usage/cloud-minutes";
import { buildRenderRecipe } from "@/lib/render/recipe";
import { enqueueExportJob } from "@/lib/export/enqueue";
import { isCloudExportEnabled } from "@/lib/export/feature";
import type {
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
  MonthlyUsage,
  ProjectDoc,
  SerializedRenderRecipe,
  SourceCrop,
  VisualAnalysis,
} from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CloudExportBody {
  projectId?: string;
  projectTitle?: string;
  resolution?: "1080p" | "4K";
  fps?: 30 | 60;
  format?: ExportFormat;
  /** Live editor render state (what the browser exporter would use). */
  sourceWidth?: number;
  sourceHeight?: number;
  sourceDuration?: number;
  moments?: DetectedMoment[];
  effects?: EffectsSettings;
  sourceCrop?: SourceCrop | null;
  visualAnalysis?: VisualAnalysis;
}

/**
 * POST /api/export/cloud
 *
 * Creates a server-side cloud MP4 export job (paid plans only). Mirrors the
 * browser `/api/billing/export-permit` gate, but instead of returning an upload
 * path it creates a `users/{uid}/exportJobs/{jobId}` doc and enqueues it for the
 * Cloud Run worker. Steps:
 *
 *   1. Verify the Firebase ID token.
 *   2. Load the project, verify ownership, take the AUTHORITATIVE source path
 *      (never trust the client for storage paths).
 *   3. Gate the plan — Free has 0 cloud minutes (402).
 *   4. Compute OUTPUT duration (post cuts/speed) + the minute estimate, and the
 *      output dimensions, from the SAME pure `buildRenderRecipe` the worker uses.
 *   5. In one transaction: re-check remaining minutes, RESERVE the estimate, and
 *      create the job doc `status:"queued"`. (Atomic, so two concurrent requests
 *      can't both pass the check.)
 *   6. Enqueue the job. On dispatch failure, fail the job + release the reservation.
 *
 * Errors: 401 auth · 400 bad body · 403 not owner · 404 project missing ·
 * 402 `{kind:"cloud_export_requires_paid"}` · 429 `{kind:"cloud_minutes_exhausted"}`.
 */
export async function POST(req: NextRequest) {
  try {
    // Kill switch — server-authoritative. Cloud export stays dark in production
    // until CLOUD_EXPORT_ENABLED="true", even if the worker is deployed.
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
      console.error("[export-cloud] token verify failed", err);
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as CloudExportBody;
    const { projectId, projectTitle, resolution, fps, format } = body;
    if (
      typeof projectId !== "string" ||
      typeof projectTitle !== "string" ||
      (resolution !== "1080p" && resolution !== "4K") ||
      (fps !== 30 && fps !== 60) ||
      (format !== "Source" &&
        format !== "TikTok 9:16" &&
        format !== "YouTube 16:9" &&
        format !== "Custom") ||
      !Array.isArray(body.moments) ||
      typeof body.effects !== "object" ||
      body.effects == null
    ) {
      return NextResponse.json(
        {
          error:
            "Body must include { projectId, projectTitle, resolution: '1080p'|'4K', fps: 30|60, format, moments[], effects }",
        },
        { status: 400 }
      );
    }

    // ── Project ownership + authoritative source path ──────────────────────
    const projectRef = db.doc(`users/${uid}/projects/${projectId}`);
    const projectSnap = await projectRef.get();
    if (!projectSnap.exists) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    const project = projectSnap.data() as ProjectDoc;
    if (project.userId && project.userId !== uid) {
      // Defense in depth — the path is already scoped to the caller's uid.
      return NextResponse.json({ error: "Not your project." }, { status: 403 });
    }
    const sourceStoragePath = project.storagePath;
    if (!sourceStoragePath) {
      return NextResponse.json(
        { error: "This project has no uploaded source video to export." },
        { status: 400 }
      );
    }

    // Prefer the project's authoritative geometry/duration; fall back to the
    // client-reported values (the live <video> dims) when absent.
    const sourceWidth = numOr(project.width, body.sourceWidth);
    const sourceHeight = numOr(project.height, body.sourceHeight);
    const sourceDuration = numOr(project.duration, body.sourceDuration);
    if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(sourceDuration > 0)) {
      return NextResponse.json(
        { error: "Couldn't determine the source video dimensions/duration." },
        { status: 400 }
      );
    }

    // ── Plan gate (Free has 0 cloud minutes) ───────────────────────────────
    const plan = await getUserPlan(uid);
    if (!planAllowsCloudExport(plan)) {
      return NextResponse.json(
        {
          error: "Cloud MP4 export requires a Pro or Creator plan.",
          kind: "cloud_export_requires_paid",
          actual: plan,
        },
        { status: 402 }
      );
    }
    const paidPlan = plan === "creator" ? "creator" : "pro";

    // ── Recipe (shared with the worker) → output dims + billed duration ─────
    const recipe = buildRenderRecipe({
      sourceWidth,
      sourceHeight,
      fps,
      resolution,
      format,
      sourceDuration,
      moments: body.moments,
      effects: body.effects,
      visualAnalysis: body.visualAnalysis,
      sourceCrop: body.sourceCrop ?? project.sourceCrop ?? null,
      applyWatermark: false, // paid plans are never watermarked
    });
    const outputDurationSeconds = recipe.outputDuration;
    const estimate = estimateExportMinutes(outputDurationSeconds);

    const serializedRecipe: SerializedRenderRecipe = {
      sourceWidth,
      sourceHeight,
      fps,
      resolution,
      format,
      sourceDuration,
      moments: body.moments,
      effects: body.effects,
      sourceCrop: body.sourceCrop ?? project.sourceCrop ?? null,
      applyWatermark: false,
      // Firestore rejects `undefined` — only include visualAnalysis when the
      // project actually has a CV pass (older projects don't).
      ...(body.visualAnalysis != null
        ? { visualAnalysis: body.visualAnalysis }
        : {}),
    };

    const monthKey = currentMonthKey();
    const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
    const userRef = db.doc(`users/${uid}`);
    const jobRef = db.collection(`users/${uid}/exportJobs`).doc();
    const jobId = jobRef.id;
    const outputPath = `users/${uid}/projects/${projectId}/exports/${jobId}.mp4`;

    // ── Transaction: re-check + reserve minutes + create the job ───────────
    try {
      await db.runTransaction(async (tx) => {
        const userSnap = await tx.get(userRef);
        const usageSnap = await tx.get(usageRef);
        const livePlan = normalizePlan(
          (userSnap.data() as { plan?: unknown } | undefined)?.plan
        );
        if (!planAllowsCloudExport(livePlan)) {
          throw new CloudExportNotAllowedError(livePlan);
        }
        const usage = (usageSnap.exists ? usageSnap.data() : undefined) as
          | MonthlyUsage
          | undefined;
        if (!canCloudExport(livePlan, usage, estimate)) {
          throw new CloudMinutesError(
            cloudMinutesRemaining(livePlan, usage),
            estimate,
            livePlan
          );
        }

        const now = Date.now();
        tx.set(
          usageRef,
          {
            cloudMinutesReserved: (usage?.cloudMinutesReserved ?? 0) + estimate,
            lastCloudExportAt: now,
            updatedAt: now,
          },
          { merge: true }
        );

        tx.set(jobRef, {
          userId: uid,
          projectId,
          projectTitle,
          status: "queued",
          plan: livePlan === "creator" ? "creator" : "pro",
          priority: livePlan === "creator" ? "priority" : "normal",
          sourceStoragePath,
          outputPath,
          format: "mp4",
          outputWidth: recipe.canvasW,
          outputHeight: recipe.canvasH,
          fps,
          durationSeconds: outputDurationSeconds,
          estimatedExportMinutes: estimate,
          progress: 0,
          stage: "queued",
          monthlyBucket: monthKey,
          renderRecipe: serializedRecipe,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
    } catch (err) {
      if (err instanceof CloudExportNotAllowedError) {
        return NextResponse.json(
          {
            error: "Cloud MP4 export requires a Pro or Creator plan.",
            kind: "cloud_export_requires_paid",
            actual: err.plan,
          },
          { status: 402 }
        );
      }
      if (err instanceof CloudMinutesError) {
        return NextResponse.json(
          {
            error: `Not enough cloud export minutes left this month (need ${err.requested}, have ${err.remaining}). Upgrade or wait for next month.`,
            kind: "cloud_minutes_exhausted",
            remaining: err.remaining,
            requested: err.requested,
            plan: err.plan,
          },
          { status: 429 }
        );
      }
      throw err;
    }

    // ── Dispatch. On failure, fail the job + release the reservation. ──────
    try {
      await enqueueExportJob({
        uid,
        jobId,
        priority: paidPlan === "creator" ? "priority" : "normal",
      });
    } catch (err) {
      console.error("[export-cloud] enqueue failed — rolling back", err);
      await releaseAndFail(db, uid, jobId, monthKey, estimate, err).catch((e) =>
        console.error("[export-cloud] rollback failed", e)
      );
      return NextResponse.json(
        {
          error:
            "Couldn't queue the export for rendering. Please try again in a moment.",
          kind: "dispatch_failed",
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      jobId,
      estimatedExportMinutes: estimate,
      outputDurationSeconds,
      plan: paidPlan,
      priority: paidPlan === "creator" ? "priority" : "normal",
      limit: CLOUD_EXPORT_MINUTES[paidPlan],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Cloud export failed.";
    console.error("[export-cloud] failed", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function numOr(primary: number | undefined, fallback: number | undefined): number {
  if (typeof primary === "number" && Number.isFinite(primary) && primary > 0) return primary;
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
  return 0;
}

/** Mark a queued job failed and release its minute reservation atomically. */
async function releaseAndFail(
  db: FirebaseFirestore.Firestore,
  uid: string,
  jobId: string,
  monthKey: string,
  estimate: number,
  cause: unknown
): Promise<void> {
  const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
  const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);
  await db.runTransaction(async (tx) => {
    const usageSnap = await tx.get(usageRef);
    const reserved = (usageSnap.data() as MonthlyUsage | undefined)?.cloudMinutesReserved ?? 0;
    tx.set(
      usageRef,
      { cloudMinutesReserved: Math.max(0, reserved - estimate), updatedAt: Date.now() },
      { merge: true }
    );
    tx.set(
      jobRef,
      {
        status: "failed",
        errorCode: "dispatch_failed",
        errorMessage: cause instanceof Error ? cause.message : "Failed to queue render.",
        updatedAt: FieldValue.serverTimestamp(),
        completedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}
