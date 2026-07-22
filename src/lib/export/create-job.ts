import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { getUserPlan } from "@/lib/usage/gating";
import { currentMonthKey } from "@/lib/usage/usage";
import { normalizePlan, type PlanTier } from "@/lib/usage/plan";
import {
  type ExportResolution,
  normalizeResolution,
  normalizeFps,
  presetLabel,
  priorityLabelForPlan,
  MAX_ACTIVE_EXPORTS_PER_PLAN,
  FREE_MONTHLY_CLOUD_EXPORTS,
  EXPORT_PRIORITY_RANK,
  globalActiveExportLimit,
  MonthlyExportLimitError,
} from "@/lib/export/plan-policy";
import {
  CLOUD_EXPORT_MINUTES,
  CLOUD_EXPORT_MAX_DURATION_SECONDS,
  CloudMinutesError,
  canCloudExport,
  cloudMinutesRemaining,
  estimateExportMinutes,
  exceedsCloudExportDuration,
} from "@/lib/usage/cloud-minutes";
import { buildRenderRecipe } from "@/lib/render/recipe";
import { summarizeEditsForLog } from "@/lib/render/edit-counts";
import { enqueueExportJob } from "@/lib/export/enqueue";
import {
  BatchCapacityError,
  BATCH_CAPACITY_ERROR_CODE,
  BATCH_CAPACITY_ERROR_MESSAGE,
  inspectBatchJob,
} from "@/lib/export/batch-backend";
import { isActiveBatchState } from "@/lib/export/batch-status";
import { exportBackend } from "@/lib/export/dotnet-backend";
import {
  BATCH_SLOT_STATUSES,
  QUEUE_REASON_WAITING_FOR_SLOT,
  maxActiveBatchJobs,
} from "@/lib/export/batch-capacity";
import {
  planChunking,
  summarizeTimelineForChunking,
  chunkEligibilityLog,
  type ChunkPlanInput,
} from "@/lib/export/chunk-plan";
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
  /** Client-REQUESTED resolution. Normalized server-side per plan (never trusted). */
  resolution: ExportResolution;
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
      /** True when the global Batch cap was hit: the job is queued (waiting for a
       *  slot) and was NOT submitted to Batch — the queue cron submits it later. */
      queuedForSlot?: boolean;
      estimatedExportMinutes: number;
      outputDurationSeconds: number;
      plan: PlanTier;
      priority: "normal" | "priority";
      /** Free: monthly cloud-export count limit. Paid: monthly minutes limit. */
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

  // ── Plan + SERVER-SIDE normalization (never trust client quality/priority) ──
  // The user's actual plan caps resolution (Free→720p, Pro/Creator→1080p, 4K
  // disabled everywhere) and fps (Free→30). The normalized values drive the
  // recipe, the settingsHash (so dedup matches the real output), and the job doc.
  const plan = await getUserPlan(uid);
  const normalizedResolution = normalizeResolution(plan, resolution);
  const normalizedFps = normalizeFps(plan, fps);
  const requestedPreset = presetLabel(resolution, fps);
  const normalizedPreset = presetLabel(normalizedResolution, normalizedFps);
  const priorityLabel = priorityLabelForPlan(plan);
  const priorityRank = EXPORT_PRIORITY_RANK[plan];
  const isFree = plan === "free";
  /** Free uses a monthly COUNT limit; paid uses the minutes quota. */
  const planLimit = isFree ? FREE_MONTHLY_CLOUD_EXPORTS : CLOUD_EXPORT_MINUTES[plan];
  /**
   * Free cloud exports carry the brand mark — the "Watermark included" line on
   * /pricing. This was hardcoded `false` for every plan back when cloud export
   * was paid-only, so Free cloud MP4s shipped clean. Derived from the plan now,
   * and the Remotion composition draws it (see WatermarkLayer).
   */
  const applyWatermark = isFree;

  const settingsHash = computeSettingsHash({
    projectId,
    sourceObjectPath: sourceStoragePath,
    format,
    resolution: normalizedResolution,
    fps: normalizedFps,
    effects: input.effects,
    moments: input.moments,
    sourceCrop: effectiveCrop,
    // In the hash because it changes the OUTPUT PIXELS: without it, a user who
    // upgrades mid-export would dedup onto their in-flight watermarked render.
    applyWatermark,
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
    const staleIds: string[] = []; // heartbeat-stale (dead worker)
    const staleBatchIds: string[] = []; // doc says active but the Batch job is gone
    let freshDuplicateId: string | null = null;
    let freshActiveOthers = 0; // distinct live active exports (for the per-plan cap)
    const batchBackend = exportBackend() === "batch";

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

      const isDuplicate = data.projectId === projectId && data.settingsHash === settingsHash;
      if (isDuplicate) {
        console.log("[export-create] existing export candidate", {
          uid,
          jobId: d.id,
          status: data.status,
          batchJobName: data.batchJobName ?? null,
        });
      }

      // Batch-reality check (THE fix): a doc that's been SUBMITTED (status != queued)
      // must still have a LIVE Batch job (QUEUED/SCHEDULED/RUNNING). If the Batch job
      // is CANCELLED/FAILED/SUCCEEDED/missing, the doc is STALE — the UI shows
      // "rendering" but nothing renders. Treat it as stale (fail + release minutes);
      // never reuse it and never let it block a fresh export. A `queued` doc hasn't
      // been submitted yet (no Batch job to check) → it's legitimately queued.
      if (batchBackend && data.status !== "queued") {
        const inspection = await inspectBatchJob({
          jobName: data.batchJobName,
          batchJobId: data.batchJobId,
        }).catch(() => null);
        const alive = !!inspection && inspection.active;
        console.log("[export-create] existing export batch state checked", {
          uid,
          jobId: d.id,
          status: data.status,
          batchState: inspection?.state ?? "missing",
          terminalBad: inspection?.terminalBad ?? null,
          alive,
        });
        if (!alive) {
          console.log("[export-create] stale export rejected", {
            uid,
            jobId: d.id,
            status: data.status,
            reason: inspection ? "batch_not_running" : "batch_missing",
            batchState: inspection?.state ?? "missing",
          });
          staleBatchIds.push(d.id);
          continue;
        }
      }

      if (isDuplicate) {
        freshDuplicateId = d.id; // identical export with a LIVE Batch job
      } else {
        freshActiveOthers += 1; // a different export is genuinely in flight
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
          plan,
          priority: priorityLabel,
          limit: planLimit,
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
    // Stale-Batch jobs (doc active but the Batch job is gone) → fail them too, with a
    // clear reason, so a fresh export can take over.
    for (const id of staleBatchIds) {
      await failStaleJob(db, uid, id, {
        errorCode: "batch_missing",
        errorMessage:
          "The previous render stopped unexpectedly. Starting a fresh export.",
      }).catch((e) =>
        console.warn("[export-create] failStaleJob (batch) error (continuing)", { id, e })
      );
    }

    // Per-plan ACTIVE export cap (Free 1, Pro 1, Creator 2). The would-be-new
    // job is the (freshActiveOthers + 1)-th, so block once we're already at the
    // cap. (A duplicate was returned above and never reaches here.)
    const activeCap = MAX_ACTIVE_EXPORTS_PER_PLAN[plan];
    if (freshActiveOthers >= activeCap) {
      return {
        ok: false,
        status: 409,
        error:
          activeCap > 1
            ? `You already have ${activeCap} exports running. Wait for one to finish or cancel it.`
            : "You already have an export running. Wait for it to finish or cancel it.",
        kind: "export_already_running",
      };
    }
  } catch (err) {
    console.warn("[export-create] active/dedup check failed (continuing)", err);
  }

  // Billing-plan alias for the (Batch-only) chunk planner, which predates Free
  // cloud export. Free/Remotion never chunks, so this is inert for them.
  const paidPlan: "pro" | "creator" = plan === "creator" ? "creator" : "pro";

  // ── Recipe → output dims + billed duration (NORMALIZED quality) ───────────
  const recipe = buildRenderRecipe({
    sourceWidth,
    sourceHeight,
    fps: normalizedFps,
    resolution: normalizedResolution,
    format,
    sourceDuration,
    moments: input.moments,
    effects: input.effects,
    visualAnalysis: input.visualAnalysis,
    sourceCrop: effectiveCrop,
    applyWatermark,
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
          : plan === "pro"
            ? `The Pro plan supports cloud exports up to ${maxMin} minutes. Upgrade to Creator for up to 60 minutes.`
            : `Free cloud exports support videos up to ${maxMin} minutes. Upgrade to Pro for longer exports.`,
      kind: "cloud_export_too_long",
    };
  }

  const serializedRecipe: SerializedRenderRecipe = {
    sourceWidth,
    sourceHeight,
    fps: normalizedFps,
    resolution: normalizedResolution,
    format,
    sourceDuration,
    moments: input.moments,
    effects: input.effects,
    sourceCrop: effectiveCrop,
    applyWatermark,
    ...(input.visualAnalysis != null ? { visualAnalysis: input.visualAnalysis } : {}),
  };

  // Stage log #1 of the caption-integrity chain: what the immutable snapshot
  // contains. The SAME summary is logged again by the render worker and the
  // Remotion renderer — if captionCount changes between stages, the stage
  // that logged the smaller number is where edits are being dropped.
  const editCounts = summarizeEditsForLog(serializedRecipe.moments);
  console.log("[export-create] edit snapshot", {
    uid,
    projectId,
    captionsEnabled: editCounts.captionsEnabled,
    captionCount: editCounts.captionCount,
    enabledCaptionCount: editCounts.enabledCaptionCount,
    totalMoments: editCounts.total,
    enabledMoments: editCounts.enabled,
    byType: editCounts.byType,
  });

  const monthKey = currentMonthKey();
  const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
  const userRef = db.doc(`users/${uid}`);
  const jobRef = db.collection(`users/${uid}/exportJobs`).doc();
  const jobId = jobRef.id;
  const outputPath = `users/${uid}/projects/${projectId}/exports/${jobId}.mp4`;
  const buildVersion = process.env.BUILD_VERSION ?? "unknown";

  // ── Single vs chunked render decision ────────────────────────────────────
  // Chunked = N parallel Batch tasks merged into one MP4 (faster for long videos).
  // Timeline-aware: chunks are sliced by OUTPUT time and the render core maps each
  // output frame back to source time via the recipe timeline map, so cuts + speed
  // ARE chunkable. Only effect TYPES the chunk renderer can't reproduce force a
  // single render (fail-closed — see summarizeTimelineForChunking). The single
  // path stays as the emergency fallback. `summarizeTimelineForChunking` keeps
  // hasSpeed moment-type based (multiplier-agnostic) so a speed-up's audioMode is
  // always honored by the global audio pass.
  const chunkTimeline = summarizeTimelineForChunking(input.moments);
  const chunkInput: ChunkPlanInput = {
    outputDurationSeconds,
    format: "mp4",
    plan: paidPlan,
    timeline: chunkTimeline,
    env: process.env,
  };
  const chunk = planChunking(chunkInput);
  // Remotion renders ONE MP4 (never sharded), so its job doc must NOT carry Batch
  // chunk fields — they'd make the UI show a frozen "Rendering chunks: 0/N". Stamp
  // the backend so the UI picks the right progress treatment (frame/ETA, not chunks).
  const backend = exportBackend();
  const isRemotion = backend === "remotion";
  console.log("[export-create] render mode decided", {
    uid,
    jobId,
    ...chunkEligibilityLog(chunkInput, chunk, { sourceDurationSeconds: sourceDuration }),
  });

  // ── Global active-Batch-export cap (cost guard) ──────────────────────────
  // Count how many jobs are currently SUBMITTED to Batch (occupying a slot —
  // queued jobs are WAITING, not occupying one). If we're at the cap, DEFER:
  // create the job as `queued` with `queueReason: waiting_for_slot` and DON'T
  // submit a Batch job now; the reconcile/queue cron submits it when a slot
  // opens. Only applies to the Batch backend (other backends manage their own
  // concurrency). Best-effort: a missing index fails open (dispatch normally).
  const capApplies = exportBackend() === "batch";
  const maxActive = maxActiveBatchJobs();
  let deferred = false;
  let queuePosition: number | undefined;
  if (capApplies) {
    try {
      const slotSnap = await db
        .collectionGroup("exportJobs")
        .where("status", "in", [...BATCH_SLOT_STATUSES])
        .count()
        .get();
      const activeBatchJobs = slotSnap.data().count ?? 0;
      deferred = activeBatchJobs >= maxActive;
      console.log("[export-create] batch capacity check", {
        jobId,
        activeBatchJobs,
        maxActiveBatchJobs: maxActive,
        deferred,
      });
      if (deferred) {
        // Only when deferring: count those already waiting, so we can show a
        // position behind everything submitted + waiting (+1 for this job).
        const waitingSnap = await db
          .collectionGroup("exportJobs")
          .where("status", "==", "queued")
          .count()
          .get();
        queuePosition = activeBatchJobs + (waitingSnap.data().count ?? 0) + 1;
      }
    } catch {
      /* no index → skip cap (fail open: dispatch immediately) */
    }
  } else if (isRemotion) {
    // GLOBAL active-export cap for Remotion (cost guard, backend-agnostic). Count
    // platform-wide RENDERING/UPLOADING jobs (queued = waiting, not occupying a
    // slot). Over the limit → DEFER as `queued`; the reconcile cron promotes
    // queued jobs by priority (Creator>Pro>Free, FIFO) when a slot frees.
    try {
      const limit = globalActiveExportLimit();
      const activeSnap = await db
        .collectionGroup("exportJobs")
        .where("status", "in", ["rendering", "uploading"])
        .count()
        .get();
      const activeGlobal = activeSnap.data().count ?? 0;
      deferred = activeGlobal >= limit;
      console.log("[export-create] global remotion capacity check", {
        jobId,
        activeGlobal,
        globalActiveExportLimit: limit,
        deferred,
      });
      if (deferred) {
        const waitingSnap = await db
          .collectionGroup("exportJobs")
          .where("status", "==", "queued")
          .count()
          .get();
        queuePosition = activeGlobal + (waitingSnap.data().count ?? 0) + 1;
      }
    } catch {
      /* no index → fail open (dispatch immediately) */
    }
  }

  // ── Transaction: re-check limits + reserve + create the job ──────────────
  // Re-reads the LIVE plan + usage so two concurrent requests can't both pass.
  // Free is gated by the monthly COUNT (no minutes); paid by the minutes quota.
  // Every plan increments the monthly export count (refunded on system failure
  // via `monthlyUsageApplied`).
  try {
    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      const usageSnap = await tx.get(usageRef);
      const livePlan = normalizePlan(
        (userSnap.data() as { plan?: unknown } | undefined)?.plan
      );
      const usage = (usageSnap.exists ? usageSnap.data() : undefined) as
        | MonthlyUsage
        | undefined;
      const usedThisMonth = Math.max(0, usage?.exportsUsedThisMonth ?? 0);

      if (livePlan === "free") {
        if (usedThisMonth >= FREE_MONTHLY_CLOUD_EXPORTS) {
          throw new MonthlyExportLimitError(livePlan, usedThisMonth, FREE_MONTHLY_CLOUD_EXPORTS);
        }
      } else if (!canCloudExport(livePlan, usage, estimate)) {
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
          // Minutes are reserved for PAID plans only (Free has 0 minutes).
          ...(livePlan !== "free"
            ? { cloudMinutesReserved: (usage?.cloudMinutesReserved ?? 0) + estimate }
            : {}),
          // Monthly cloud-export COUNT — reserved for everyone; the Free gate above.
          exportsUsedThisMonth: usedThisMonth + 1,
          exportMonthKey: monthKey,
          lastExportPlan: livePlan,
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
        planAtExport: livePlan,
        priority: priorityLabelForPlan(livePlan),
        priorityRank: EXPORT_PRIORITY_RANK[livePlan],
        queuedAt: now,
        requestedPreset,
        normalizedPreset,
        monthlyUsageApplied: true,
        sourceStoragePath,
        outputPath,
        format: "mp4",
        exportPath: "cloud",
        settingsHash,
        buildVersion,
        outputWidth: recipe.canvasW,
        outputHeight: recipe.canvasH,
        fps: normalizedFps,
        durationSeconds: outputDurationSeconds,
        estimatedExportMinutes: estimate,
        progress: 0,
        stage: "queued",
        progressStage: "queued",
        backend,
        ...(queuePosition ? { queuePosition } : {}),
        ...(deferred ? { queueReason: QUEUE_REASON_WAITING_FOR_SLOT } : {}),
        // Remotion never shards → "single" + no chunk fields, so the UI shows
        // "Rendering video" with real frame progress instead of a chunk count.
        renderMode: isRemotion ? "single" : chunk.renderMode,
        ...(!isRemotion && chunk.renderMode === "chunked"
          ? {
              chunkCount: chunk.chunkCount, // TOTAL chunks (UI shows chunksCompleted/chunkCount)
              chunkSeconds: chunk.chunkSeconds,
              workerCount: chunk.workerCount, // Batch tasks (shard workers)
              // chunkParallelism kept = workerCount for existing diagnostics UI.
              chunkParallelism: chunk.workerCount,
              chunksCompleted: 0,
              chunksFailed: 0,
              // Progress summary (worker updates these per completed chunk).
              totalChunks: chunk.chunkCount,
              completedChunks: 0,
              failedChunks: 0,
              progressPercent: 0,
            }
          : {}),
        monthlyBucket: monthKey,
        renderRecipe: serializedRecipe,
        // Immutable audit of what the snapshot contained at creation — lets
        // anyone diff a job's render logs against what was enqueued.
        editCounts: {
          total: editCounts.total,
          enabled: editCounts.enabled,
          captionCount: editCounts.captionCount,
          enabledCaptionCount: editCounts.enabledCaptionCount,
          byType: editCounts.byType,
        },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    if (err instanceof MonthlyExportLimitError) {
      return {
        ok: false,
        status: 429,
        error: `You've used all ${err.limit} free cloud exports this month. Upgrade to Pro for more exports and 1080p.`,
        kind: "free_monthly_export_limit",
        remaining: 0,
        requested: 1,
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

  console.log("[export-create] fresh export created", {
    uid,
    jobId,
    projectId,
    settingsHash,
    renderMode: chunk.renderMode,
    deferred,
  });

  // ── Dispatch (or defer when the global Batch cap is hit) ──────────────────
  // When deferred, the job stays `queued` (waiting_for_slot) and is NOT submitted
  // to Batch now; the reconcile/queue cron promotes it once a slot frees up.
  if (deferred) {
    console.log("[export-create] queued due to cap (waiting for slot)", {
      uid,
      jobId,
      maxActiveBatchJobs: maxActive,
      queuePosition,
    });
    return {
      ok: true,
      jobId,
      deduped: false,
      queuedForSlot: true,
      estimatedExportMinutes: estimate,
      outputDurationSeconds,
      plan,
      priority: priorityLabel,
      limit: planLimit,
    };
  }

  try {
    await enqueueExportJob({
      uid,
      jobId,
      priority: priorityLabel,
      renderMode: chunk.renderMode,
      ...(chunk.renderMode === "chunked"
        ? {
            chunkCount: chunk.chunkCount,
            chunkSeconds: chunk.chunkSeconds,
            workerCount: chunk.workerCount,
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
    plan,
    priority: priorityLabel,
    limit: planLimit,
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
  jobId: string,
  reason: { errorCode: string; errorMessage: string } = {
    errorCode: "stale",
    errorMessage:
      "This export timed out (the render service stopped responding). Please try again.",
  }
): Promise<void> {
  const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) return;
    const job = snap.data() as {
      status?: string;
      monthlyBucket?: string;
      estimatedExportMinutes?: number;
      monthlyUsageApplied?: boolean;
    };
    if (job.status === "ready" || job.status === "failed" || job.status === "canceled") {
      return; // already terminal — don't clobber a job the worker just settled
    }
    const needMinutesRelease = !!job.monthlyBucket && (job.estimatedExportMinutes ?? 0) > 0;
    const needCountRefund = !!job.monthlyBucket && job.monthlyUsageApplied === true;
    if (needMinutesRelease || needCountRefund) {
      const usageRef = db.doc(`users/${uid}/usage/${job.monthlyBucket}`);
      const uSnap = await tx.get(usageRef);
      const u = uSnap.data() as
        | { cloudMinutesReserved?: number; exportsUsedThisMonth?: number }
        | undefined;
      tx.set(
        usageRef,
        {
          ...(needMinutesRelease
            ? { cloudMinutesReserved: Math.max(0, (u?.cloudMinutesReserved ?? 0) - (job.estimatedExportMinutes ?? 0)) }
            : {}),
          ...(needCountRefund
            ? { exportsUsedThisMonth: Math.max(0, (u?.exportsUsedThisMonth ?? 0) - 1) }
            : {}),
          updatedAt: Date.now(),
        },
        { merge: true }
      );
    }
    tx.set(
      jobRef,
      {
        status: "failed",
        errorCode: reason.errorCode,
        errorMessage: reason.errorMessage,
        ...(needCountRefund ? { monthlyUsageApplied: false } : {}),
        failedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
  console.log("[export-create] failed stale job", { uid, jobId, errorCode: reason.errorCode });
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
    const jobSnap = await tx.get(jobRef);
    const usageSnap = await tx.get(usageRef);
    // Refund the monthly export COUNT only if this job still holds a slot — so a
    // dispatch failure never unfairly burns a Free user's 2/month allowance.
    const countApplied =
      (jobSnap.data() as { monthlyUsageApplied?: boolean } | undefined)?.monthlyUsageApplied === true;
    const u = usageSnap.data() as MonthlyUsage | undefined;
    tx.set(
      usageRef,
      {
        cloudMinutesReserved: Math.max(0, (u?.cloudMinutesReserved ?? 0) - estimate),
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
        status: "failed",
        errorCode: fail.errorCode,
        errorMessage: fail.errorMessage,
        ...(countApplied ? { monthlyUsageApplied: false } : {}),
        failedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        completedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}
