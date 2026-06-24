import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { getUserPlan } from "@/lib/usage/gating";
import { currentMonthKey } from "@/lib/usage/usage";
import { normalizePlan, planMeetsMinimum } from "@/lib/usage/plan";
import {
  CLOUD_EXPORT_MINUTES,
  CLOUD_EXPORT_MAX_DURATION_SECONDS,
  CloudExportNotAllowedError,
  CloudMinutesError,
  canCloudExport,
  cloudMinutesRemaining,
  estimateExportMinutes,
  exceedsCloudExportDuration,
  planAllowsCloudExport,
} from "@/lib/usage/cloud-minutes";
import { buildRenderRecipe } from "@/lib/render/recipe";
import { enqueueExportJob } from "@/lib/export/enqueue";
import {
  BatchCapacityError,
  BATCH_CAPACITY_ERROR_CODE,
  BATCH_CAPACITY_ERROR_MESSAGE,
} from "@/lib/export/batch-backend";
import { planChunking } from "@/lib/export/chunk-plan";
import { computeSettingsHash } from "@/lib/export/settings-hash";
import type {
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
  ExportJobDoc,
  MonthlyUsage,
  ProjectDoc,
  SerializedRenderRecipe,
  SourceCrop,
  VisualAnalysis,
} from "@/lib/firebase/schema";

/**
 * Shared "create a cloud export job" pipeline used by BOTH `/api/export/cloud`
 * (a fresh export from the editor) and `/api/export/retry` (a re-run from a prior
 * job's recipe). Centralising it guarantees the duplicate-prevention rules are
 * identical on every entry point:
 *
 *   1. Load + own the project, take the AUTHORITATIVE source path.
 *   2. Compute a deterministic `settingsHash`.
 *   3. Look at the user's active jobs:
 *        • a FRESH active job with the SAME settingsHash ⇒ return it (dedup — a
 *          repeated click never spawns a second identical export).
 *        • a FRESH active job with DIFFERENT settings ⇒ block (one export at a time).
 *        • any STALE active job (dead worker, past heartbeat) ⇒ fail it ("stale")
 *          and release its reservation, then continue.
 *   4. Gate plan + tier.
 *   5. In a transaction: re-check minutes, RESERVE, create the job doc.
 *   6. Enqueue; on dispatch failure fail the job + release the reservation.
 *
 * Terminal prior jobs (ready/failed/canceled) never block — re-exporting a video
 * that already succeeded, or retrying a failed one, always creates a fresh job.
 */

/** Active job is "stale" once its heartbeat is older than this (matches the
 *  client's STALE_UI_MS and the reconciler window). */
const HEARTBEAT_STALE_MS = 12 * 60 * 1000;

const ACTIVE_STATUSES = ["queued", "batch_submitted", "rendering", "uploading"] as const;

export interface CreateCloudExportInput {
  uid: string;
  projectId: string;
  projectTitle: string;
  resolution: "1080p" | "4K";
  fps: 30 | 60;
  format: ExportFormat;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceDuration?: number;
  moments: DetectedMoment[];
  effects: EffectsSettings;
  sourceCrop?: SourceCrop | null;
  visualAnalysis?: VisualAnalysis;
}

export type CreateCloudExportResult =
  | {
      ok: true;
      jobId: string;
      /** True when an identical active job already existed (no new job created). */
      deduped: boolean;
      estimatedExportMinutes: number;
      outputDurationSeconds: number;
      plan: "pro" | "creator";
      priority: "normal" | "priority";
      limit: number;
    }
  | {
      ok: false;
      status: number;
      error: string;
      kind?: string;
      remaining?: number;
      requested?: number;
    };

function tsToMs(v: unknown): number | undefined {
  const t = v as { toMillis?: () => number } | undefined;
  if (t?.toMillis) return t.toMillis();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function numOr(primary: number | undefined, fallback: number | undefined): number {
  if (typeof primary === "number" && Number.isFinite(primary) && primary > 0) return primary;
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
  return 0;
}

export async function createCloudExportJob(
  db: FirebaseFirestore.Firestore,
  input: CreateCloudExportInput
): Promise<CreateCloudExportResult> {
  const { uid, projectId, projectTitle, resolution, fps, format } = input;

  // ── Project ownership + authoritative source path ────────────────────────
  const projectRef = db.doc(`users/${uid}/projects/${projectId}`);
  const projectSnap = await projectRef.get();
  if (!projectSnap.exists) {
    return { ok: false, status: 404, error: "Project not found." };
  }
  const project = projectSnap.data() as ProjectDoc;
  if (project.userId && project.userId !== uid) {
    return { ok: false, status: 403, error: "Not your project." };
  }
  const sourceStoragePath = project.storagePath;
  if (!sourceStoragePath) {
    return {
      ok: false,
      status: 400,
      error: "This project has no uploaded source video to export.",
    };
  }

  const sourceWidth = numOr(project.width, input.sourceWidth);
  const sourceHeight = numOr(project.height, input.sourceHeight);
  const sourceDuration = numOr(project.duration, input.sourceDuration);
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(sourceDuration > 0)) {
    return {
      ok: false,
      status: 400,
      error: "Couldn't determine the source video dimensions/duration.",
    };
  }

  const effectiveCrop = input.sourceCrop ?? project.sourceCrop ?? null;
  const settingsHash = computeSettingsHash({
    projectId,
    sourceObjectPath: sourceStoragePath,
    format,
    resolution,
    fps,
    effects: input.effects,
    moments: input.moments,
    sourceCrop: effectiveCrop,
  });

  // ── Dedup + single-flight against the user's active jobs ─────────────────
  // Defensive guard: NEVER reuse a canceled / failed / completed / cancel-requested
  // job — reusing one makes the Batch worker claim a terminal job and abort. The
  // active-status query already excludes terminal jobs; we additionally skip any
  // cancel-requested job and RE-VALIDATE a dedup candidate with a fresh read, so a
  // job that was canceled in the cancel→re-export race is not reused (we create a
  // fresh job instead). This is a tightening of the existing dedup only — a genuine
  // identical active export is still deduped (double-click guard) and a different
  // active export still blocks (one export at a time).
  console.log("[export-create] export request received", { uid, projectId, settingsHash });
  try {
    const activeSnap = await db
      .collection(`users/${uid}/exportJobs`)
      .where("status", "in", [...ACTIVE_STATUSES])
      .limit(10)
      .get();

    const now = Date.now();
    const staleIds: string[] = [];
    let freshDuplicateId: string | null = null;
    let freshOtherActive = false;

    for (const d of activeSnap.docs) {
      const data = d.data();
      const beat =
        tsToMs(data.lastHeartbeatAt) ?? tsToMs(data.heartbeatAt) ?? tsToMs(data.updatedAt) ?? 0;
      const stale = now - beat > HEARTBEAT_STALE_MS;
      if (stale) {
        staleIds.push(d.id);
        continue;
      }
      // Guard: a job already asked to cancel is NOT a reuse candidate (and isn't a
      // "different active export" that should block either — it's on its way out).
      if (data.cancelRequested === true) {
        continue;
      }
      if (data.projectId === projectId && data.settingsHash === settingsHash) {
        freshDuplicateId = d.id; // identical export already running
      } else {
        freshOtherActive = true; // a different export is in flight
      }
    }

    // Identical active export → return it, do not create a duplicate. Re-validate
    // with a fresh read first: if it was canceled/failed between the query and now,
    // do NOT reuse it — fall through and create a fresh job.
    if (freshDuplicateId) {
      const dupSnap = await db.doc(`users/${uid}/exportJobs/${freshDuplicateId}`).get();
      const dup = (dupSnap.data() ?? {}) as Partial<ExportJobDoc>;
      const reusable =
        !!dup.status &&
        (ACTIVE_STATUSES as readonly string[]).includes(dup.status) &&
        dup.cancelRequested !== true;
      if (reusable) {
        const plan = await getUserPlan(uid);
        const paidPlan = plan === "creator" ? "creator" : "pro";
        console.log("[export-create] dedup — returning existing active job", {
          uid,
          jobId: freshDuplicateId,
          settingsHash,
        });
        return {
          ok: true,
          jobId: freshDuplicateId,
          deduped: true,
          estimatedExportMinutes: (dup.estimatedExportMinutes as number) ?? 0,
          outputDurationSeconds: (dup.durationSeconds as number) ?? 0,
          plan: paidPlan,
          priority: paidPlan === "creator" ? "priority" : "normal",
          limit: CLOUD_EXPORT_MINUTES[paidPlan],
        };
      }
      // Candidate is no longer reusable (terminal/canceled in the race) → ignore it
      // and create a fresh job below.
      console.log("[export-create] previous job not reusable — creating a fresh job", {
        uid,
        jobId: freshDuplicateId,
        status: dup.status,
      });
    }

    // Stale active jobs (dead worker) → fail them + release minutes, then continue.
    for (const id of staleIds) {
      await failStaleJob(db, uid, id).catch((e) =>
        console.warn("[export-create] failStaleJob error (continuing)", { id, e })
      );
    }

    // A DIFFERENT export is genuinely running → one at a time.
    if (freshOtherActive) {
      return {
        ok: false,
        status: 409,
        error: "You already have an export running. Wait for it to finish or cancel it.",
        kind: "export_already_running",
      };
    }
  } catch (err) {
    console.warn("[export-create] active/dedup check failed (continuing)", err);
  }

  // ── Plan gate ────────────────────────────────────────────────────────────
  const plan = await getUserPlan(uid);
  if (!planAllowsCloudExport(plan)) {
    return {
      ok: false,
      status: 402,
      error: "Cloud MP4 export requires a Pro or Creator plan.",
      kind: "cloud_export_requires_paid",
    };
  }
  const paidPlan = plan === "creator" ? "creator" : "pro";

  if ((resolution === "4K" || fps === 60) && !planMeetsMinimum(plan, "pro")) {
    return {
      ok: false,
      status: 402,
      error: "4K and 60fps exports require a Pro or Creator plan.",
      kind: "tier_requires_pro",
    };
  }

  // ── Recipe → output dims + billed duration ───────────────────────────────
  const recipe = buildRenderRecipe({
    sourceWidth,
    sourceHeight,
    fps,
    resolution,
    format,
    sourceDuration,
    moments: input.moments,
    effects: input.effects,
    visualAnalysis: input.visualAnalysis,
    sourceCrop: effectiveCrop,
    applyWatermark: false,
  });
  const outputDurationSeconds = recipe.outputDuration;
  const estimate = estimateExportMinutes(outputDurationSeconds);

  // ── Max video length gate (per plan) ─────────────────────────────────────
  // Pro ≤ 30 min, Creator ≤ 60 min of OUTPUT. Bounds per-job render/Batch time;
  // distinct from the monthly minutes quota checked in the transaction below.
  if (exceedsCloudExportDuration(plan, outputDurationSeconds)) {
    const maxMin = Math.round(CLOUD_EXPORT_MAX_DURATION_SECONDS[plan] / 60);
    return {
      ok: false,
      status: 413,
      error:
        plan === "creator"
          ? `Cloud export supports videos up to ${maxMin} minutes.`
          : `The Pro plan supports cloud exports up to ${maxMin} minutes. Upgrade to Creator for up to 60 minutes.`,
      kind: "cloud_export_too_long",
    };
  }

  const serializedRecipe: SerializedRenderRecipe = {
    sourceWidth,
    sourceHeight,
    fps,
    resolution,
    format,
    sourceDuration,
    moments: input.moments,
    effects: input.effects,
    sourceCrop: effectiveCrop,
    applyWatermark: false,
    ...(input.visualAnalysis != null ? { visualAnalysis: input.visualAnalysis } : {}),
  };

  const monthKey = currentMonthKey();
  const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
  const userRef = db.doc(`users/${uid}`);
  const jobRef = db.collection(`users/${uid}/exportJobs`).doc();
  const jobId = jobRef.id;
  const outputPath = `users/${uid}/projects/${projectId}/exports/${jobId}.mp4`;
  const buildVersion = process.env.BUILD_VERSION ?? "unknown";

  // ── Single vs chunked render decision ────────────────────────────────────
  // Chunked = N parallel Batch tasks merged into one MP4 (faster for long videos);
  // requires a LINEAR timeline (no cuts/speed — the render CLI refuses to chunk
  // those). Anything ineligible falls back to the proven single-worker path.
  // Mirror the render CLI's chunk_unsupported_timeline predicate EXACTLY
  // (services/export-worker/src/render.ts): hasSpeed is moment-type based and
  // multiplier-agnostic (buildTimelineMap clamps multiplier to >=1, so a speed-up
  // moment with multiplier<=1 still yields speedMultiplier===1 — checking segments
  // would wrongly pass it as linear, then the CLI would hard-refuse the chunk).
  const hasSpeed = input.moments.some((m) => m.effectType === "speed-up");
  const hasCuts = recipe.timelineMap.totalRemoved > 0;
  const timelineLinear = !hasSpeed && !hasCuts;
  const chunk = planChunking({
    outputDurationSeconds,
    format: "mp4",
    linear: timelineLinear,
    plan: paidPlan,
    env: process.env,
  });
  console.log("[export-create] render mode decided", {
    uid,
    jobId,
    renderMode: chunk.renderMode,
    reason: chunk.reason,
    ...(chunk.renderMode === "chunked"
      ? { chunkCount: chunk.chunkCount, chunkSeconds: chunk.chunkSeconds, chunkParallelism: chunk.chunkParallelism }
      : {}),
  });

  // Best-effort global active-export count → queue position + a hard capacity cap
  // (cost guard so we never fan out more concurrent Batch VMs than intended).
  const maxActive = Number.parseInt(process.env.EXPORT_MAX_ACTIVE_BATCH_EXPORTS ?? "", 10);
  let queuePosition: number | undefined;
  try {
    const ahead = await db
      .collectionGroup("exportJobs")
      .where("status", "in", [...ACTIVE_STATUSES])
      .count()
      .get();
    const n = ahead.data().count ?? 0;
    if (Number.isFinite(maxActive) && maxActive > 0 && n >= maxActive) {
      console.warn("[export-create] global active-export cap reached — rejecting", { n, maxActive });
      return {
        ok: false,
        status: 429,
        error: "The export service is at capacity right now. Please try again in a few minutes.",
        kind: "export_capacity",
      };
    }
    if (n > 0) queuePosition = n + 1;
  } catch {
    /* no index → omit position + skip cap (fail open) */
  }

  // ── Transaction: re-check + reserve minutes + create the job ─────────────
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
        exportPath: "cloud",
        settingsHash,
        buildVersion,
        outputWidth: recipe.canvasW,
        outputHeight: recipe.canvasH,
        fps,
        durationSeconds: outputDurationSeconds,
        estimatedExportMinutes: estimate,
        progress: 0,
        stage: "queued",
        progressStage: "queued",
        ...(queuePosition ? { queuePosition } : {}),
        renderMode: chunk.renderMode,
        ...(chunk.renderMode === "chunked"
          ? {
              chunkCount: chunk.chunkCount,
              chunkSeconds: chunk.chunkSeconds,
              chunkParallelism: chunk.chunkParallelism,
              chunksCompleted: 0,
              chunksFailed: 0,
            }
          : {}),
        monthlyBucket: monthKey,
        renderRecipe: serializedRecipe,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    if (err instanceof CloudExportNotAllowedError) {
      return {
        ok: false,
        status: 402,
        error: "Cloud MP4 export requires a Pro or Creator plan.",
        kind: "cloud_export_requires_paid",
      };
    }
    if (err instanceof CloudMinutesError) {
      return {
        ok: false,
        status: 429,
        error: `Not enough cloud export minutes left this month (need ${err.requested}, have ${err.remaining}). Upgrade or wait for next month.`,
        kind: "cloud_minutes_exhausted",
        remaining: err.remaining,
        requested: err.requested,
      };
    }
    throw err;
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────
  try {
    await enqueueExportJob({
      uid,
      jobId,
      priority: paidPlan === "creator" ? "priority" : "normal",
      renderMode: chunk.renderMode,
      ...(chunk.renderMode === "chunked"
        ? {
            chunkCount: chunk.chunkCount,
            chunkSeconds: chunk.chunkSeconds,
            chunkParallelism: chunk.chunkParallelism,
            durationSeconds: outputDurationSeconds,
          }
        : {}),
    });
  } catch (err) {
    console.error("[export-create] enqueue failed — rolling back", err);
    // Region had no capacity at submit time → retryable capacity failure, not a
    // generic dispatch error. (The common exhaustion case is the ASYNC cancel
    // caught by the reconciler; this is the synchronous safety net.)
    if (err instanceof BatchCapacityError) {
      await releaseAndFail(db, uid, jobId, monthKey, estimate, {
        errorCode: BATCH_CAPACITY_ERROR_CODE,
        errorMessage: BATCH_CAPACITY_ERROR_MESSAGE,
      }).catch((e) => console.error("[export-create] rollback failed", e));
      return {
        ok: false,
        status: 503,
        error: BATCH_CAPACITY_ERROR_MESSAGE,
        kind: BATCH_CAPACITY_ERROR_CODE,
      };
    }
    await releaseAndFail(db, uid, jobId, monthKey, estimate).catch((e) =>
      console.error("[export-create] rollback failed", e)
    );
    return {
      ok: false,
      status: 502,
      error: "Couldn't queue the export for rendering. Please try again in a moment.",
      kind: "dispatch_failed",
    };
  }

  console.log("[export-create] new export job created", {
    uid,
    jobId,
    settingsHash,
    status: "queued",
  });
  return {
    ok: true,
    jobId,
    deduped: false,
    estimatedExportMinutes: estimate,
    outputDurationSeconds,
    plan: paidPlan,
    priority: paidPlan === "creator" ? "priority" : "normal",
    limit: CLOUD_EXPORT_MINUTES[paidPlan],
  };
}

/**
 * Mark a STALE active job failed ("stale") and release its minute reservation,
 * atomically. A dead worker leaves a job stuck in queued/rendering forever; this
 * lets a fresh export supersede it cleanly. Guarded so it never touches a job
 * another worker just finalised.
 */
async function failStaleJob(
  db: FirebaseFirestore.Firestore,
  uid: string,
  jobId: string
): Promise<void> {
  const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) return;
    const job = snap.data() as { status?: string; monthlyBucket?: string; estimatedExportMinutes?: number };
    if (job.status === "ready" || job.status === "failed" || job.status === "canceled") {
      return; // already terminal
    }
    if (job.monthlyBucket && (job.estimatedExportMinutes ?? 0) > 0) {
      const usageRef = db.doc(`users/${uid}/usage/${job.monthlyBucket}`);
      const uSnap = await tx.get(usageRef);
      const reserved =
        (uSnap.data() as { cloudMinutesReserved?: number } | undefined)?.cloudMinutesReserved ?? 0;
      tx.set(
        usageRef,
        {
          cloudMinutesReserved: Math.max(0, reserved - (job.estimatedExportMinutes ?? 0)),
          updatedAt: Date.now(),
        },
        { merge: true }
      );
    }
    tx.set(
      jobRef,
      {
        status: "failed",
        errorCode: "stale",
        errorMessage:
          "This export timed out (the render service stopped responding). Please try again.",
        failedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
  console.log("[export-create] failed stale job", { uid, jobId });
}

async function releaseAndFail(
  db: FirebaseFirestore.Firestore,
  uid: string,
  jobId: string,
  monthKey: string,
  estimate: number,
  fail: { errorCode: string; errorMessage: string } = {
    errorCode: "dispatch_failed",
    errorMessage: "Couldn't queue the export for rendering. Please try again.",
  }
): Promise<void> {
  const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
  const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);
  await db.runTransaction(async (tx) => {
    const usageSnap = await tx.get(usageRef);
    const reserved =
      (usageSnap.data() as MonthlyUsage | undefined)?.cloudMinutesReserved ?? 0;
    tx.set(
      usageRef,
      { cloudMinutesReserved: Math.max(0, reserved - estimate), updatedAt: Date.now() },
      { merge: true }
    );
    tx.set(
      jobRef,
      {
        status: "failed",
        errorCode: fail.errorCode,
        errorMessage: fail.errorMessage,
        failedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        completedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}
