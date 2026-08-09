import { NextResponse, type NextRequest } from "next/server";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import { recordEvent } from "@/lib/analytics/recordEvent";
import { EVENTS } from "@/lib/analytics/events";
import { stripUndefined } from "@/lib/firebase/sanitize";
import {
  type AnalysisOptions,
  type EngineLayer,
  aiLayersPresent,
  DEFAULT_ANALYSIS_OPTIONS,
  layerForMoment,
  shouldRunLayer,
} from "@/lib/analysis/engine-layers";
import {
  classifyVideoSections,
  labelMoments,
  proposeGapFills,
  proposeVisualMoments,
  reviewEditorialDecisions,
  uploadVideoToGemini,
  waitForGeminiFileActive,
  GeminiCancelled,
  type GeminiVideoRef,
  type SectionClassification,
} from "@/lib/gemini";
import {
  classifyError,
  estimateAnalysisSeconds,
} from "@/lib/analysis-stages";
import {
  balanceTimeline,
  distributionScore,
  REJECTED_POOL_CAP,
} from "@/lib/timeline-balancer";
import {
  normalizeSelectedVideoType,
  mapSelectedToDetectedVideoType,
} from "@/lib/analysis/video-type";
import { resolveEditRecipe, logEditRecipePlan } from "@/lib/analysis/edit-recipe";
// The AI Editor — decides which candidate edits deserve to exist at all.
import {
  decideTimeline,
  attentionValueAt,
  isEditorialJustification,
  type EditorialContext,
} from "@/lib/analysis/editorial-decision";
import { generateOverlayEdits } from "@/lib/analysis/overlay-generators";
// NOTE: transcription/captions are DECOUPLED from analysis — this route never
// starts ASR, reserves caption quota, or generates captions. All caption
// generation lives behind the dedicated "Generate AI Captions" action
// (src/lib/transcript/caption-request.ts + /api/projects/[id]/captions). Only
// an EXISTING transcript is read here as a signal (e.g. hook text).
import { hasUsableTranscript } from "@/lib/transcript/transcribe";
import { buildEditDiagnostics } from "@/lib/diagnostics/edit-diagnostics";
import { momentsFromEvents } from "@/lib/attention/events";
import { attentionCurve } from "@/lib/attention/score";
import { cursorIntent } from "@/lib/attention/cursor-intent";
import { classifyClick, type ClickTier } from "@/lib/attention/click-classifier";
import { canUseAiFeature } from "@/lib/usage/ai-features";
import { canUsePreset, getUserPlan } from "@/lib/usage/gating";
import {
  exceedsUploadDuration,
  FREE_UPLOAD_MAX_DURATION_SECONDS,
  FREE_VIDEO_DURATION_LIMIT_CODE,
  FREE_VIDEO_DURATION_LIMIT_MESSAGE,
} from "@/lib/usage/plan";
import type { Interaction } from "@/lib/recording/types";
import {
  resolveScopeAndTrust,
  type CaptureDimensions,
} from "@/lib/recording/scope-detect";
import {
  AI_MOMENT_QUOTA,
  type AnalysisActivityEvent,
  type AnalysisErrorKind,
  type AudioAnalysis,
  type ClickPipelineDiagnostics,
  type DetectedMoment,
  type EffectsSettings,
  type MomentProvenance,
  type OutputCanvas,
  type Pacing,
  type ProjectDoc,
  type ProjectStatus,
  type Transcript,
  type VisualAnalysis,
  type ZoomPresetId,
} from "@/lib/firebase/schema";
// The Director runs as the FINAL STAGE of analysis (see the stage below) — the
// user's brief, applied to the understanding this run just produced.
import { materializeProject } from "@/lib/firebase/materialize-project";
import { runDirectorStage } from "@/lib/director/analysis-stage";
import { stripUndefinedDeep } from "@/lib/director/state";
import { shouldRunDirectorStage, type DirectorState } from "@/lib/director/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const INLINE_BYTE_LIMIT = 18 * 1024 * 1024;

/**
 * Internal finalize budget — kept safely under `maxDuration` (Cloud Run /
 * App Hosting kills the request at 300s and returns a non-JSON 504, which the
 * client can only show as the opaque "Finalize failed"). The serial Gemini
 * sequence (file-active wait + classify + gap-fill + label) on a long/arbitrary
 * video can exceed 300s, so each Gemini step is bounded by the REMAINING budget:
 * when it's spent, the step rejects fast → the outer catch returns clean JSON
 * (and the client's non-fatal finalize keeps the progressive edits).
 */
const FINALIZE_BUDGET_MS = 260_000;

/** Reject `p` after `ms` so a wall-clock overrun surfaces as a catchable error
 *  instead of a platform 504. The underlying Gemini call can't be cancelled, but
 *  the response is sent (clean JSON) instead of hanging into the platform kill. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), Math.max(1, ms));
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

class CancelledError extends Error {
  constructor() {
    super("Cancelled by user");
    this.name = "CancelledError";
  }
}

async function emitActivity(
  ref: DocumentReference,
  kind: AnalysisActivityEvent["kind"],
  text: string
) {
  await ref.set(
    {
      analysis: {
        activity: FieldValue.arrayUnion({ ts: Date.now(), kind, text }),
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function setStage(
  ref: DocumentReference,
  status: ProjectStatus,
  stageLabel: string
) {
  await ref.set(
    {
      status,
      analysis: {
        status: "analyzing",
        stage: stageLabel,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function isCancelled(ref: DocumentReference): Promise<boolean> {
  const snap = await ref.get();
  const data = snap.data() as Record<string, unknown> | undefined;
  const analysis = data?.analysis as { cancelRequested?: boolean } | undefined;
  return Boolean(analysis?.cancelRequested);
}

async function bail(
  ref: DocumentReference,
  kind: AnalysisErrorKind,
  message: string
) {
  await ref.set(
    {
      status: "failed" as ProjectStatus,
      analysis: {
        status: "failed",
        errorKind: kind,
        errorMessage: message,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function markCancelled(ref: DocumentReference) {
  await ref.set(
    {
      status: "cancelled" as ProjectStatus,
      analysis: {
        status: "cancelled",
        stage: "Cancelled",
        cancelRequested: false,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function ensureNotCancelled(ref: DocumentReference) {
  if (await isCancelled(ref)) throw new CancelledError();
}

// ── Finalize (chunked) helpers — non-destructive merge of progressive moments ──

/** Focus-region center (normalized 0..1). */
function regionCenter(m: DetectedMoment): { x: number; y: number } {
  const r = m.focusRegion;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** True when two moments target nearly the same spot — used for dedupe + guard. */
function regionClose(a: DetectedMoment, b: DetectedMoment): boolean {
  const ca = regionCenter(a);
  const cb = regionCenter(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y) < 0.08;
}

/**
 * Merge "obvious" boundary duplicates: moments whose starts are within 0.4s AND
 * whose focus regions point at nearly the same spot. Keeps the higher-confidence
 * one. Conservative — the chunk orchestrator's primary-span ownership already
 * prevents most overlap duplicates, so this normally merges 0.
 */
function dedupeBoundaryDuplicates(moments: DetectedMoment[]): {
  kept: DetectedMoment[];
  merged: Array<{ id: string; reason: string }>;
} {
  const sorted = [...moments].sort((a, b) => a.startTime - b.startTime);
  const kept: DetectedMoment[] = [];
  const merged: Array<{ id: string; reason: string }> = [];
  for (const m of sorted) {
    const twin = kept.find(
      (k) => Math.abs(k.startTime - m.startTime) < 0.4 && regionClose(k, m)
    );
    if (twin) {
      const mConf = m.confidenceScore ?? m.attentionScore ?? 0;
      const tConf = twin.confidenceScore ?? twin.attentionScore ?? 0;
      if (mConf > tConf) {
        kept[kept.indexOf(twin)] = m;
        merged.push({ id: twin.id, reason: `duplicate of ${m.id}` });
      } else {
        merged.push({ id: m.id, reason: `duplicate of ${twin.id}` });
      }
      continue;
    }
    kept.push(m);
  }
  return { kept, merged };
}

/** Patch label/reason from `labeled` (by id) onto `base`, non-destructively. */
function applyLabels(
  base: DetectedMoment[],
  labeled: DetectedMoment[]
): DetectedMoment[] {
  const byId = new Map(labeled.map((m) => [m.id, m]));
  return base.map((m) => {
    const l = byId.get(m.id);
    return l ? { ...m, label: l.label, reason: l.reason } : m;
  });
}

// ── Crop / Speed finalize — non-destructive merge (never drops standalone) ──

/** Generic adjacent-merge over a time-sorted list. */
function mergeRun(
  sorted: DetectedMoment[],
  canMerge: (prev: DetectedMoment, cur: DetectedMoment) => boolean,
  combine: (prev: DetectedMoment, cur: DetectedMoment) => DetectedMoment
): DetectedMoment[] {
  const out: DetectedMoment[] = [];
  for (const cur of sorted) {
    const prev = out[out.length - 1];
    if (prev && canMerge(prev, cur)) out[out.length - 1] = combine(prev, cur);
    else out.push(cur);
  }
  return out;
}

/** Drop AI sections that overlap a user section of the same type (user wins). */
function dropAiOverlappingUser(
  sections: DetectedMoment[],
  merged: Array<{ id: string; reason: string }>
): DetectedMoment[] {
  const users = sections.filter((s) => s.source === "user");
  if (!users.length) return sections;
  return sections.filter((s) => {
    if (s.source === "user") return true;
    const overlaps = users.some(
      (u) => !(s.endTime <= u.startTime || s.startTime >= u.endTime)
    );
    if (overlaps) {
      merged.push({ id: s.id, reason: "user-section-wins" });
      return false;
    }
    return true;
  });
}

/**
 * Finalize cut + crop + speed sections WITHOUT dropping data: merge adjacent
 * same-type AI sections (a dead run / boring run / stable region split across
 * chunk boundaries) and let user sections always win. Camera moments are
 * returned untouched.
 */
function mergeCropSpeedSections(moments: DetectedMoment[]): {
  moments: DetectedMoment[];
  merged: Array<{ id: string; reason: string }>;
  cropBefore: number;
  cropAfter: number;
  speedBefore: number;
  speedAfter: number;
  cutBefore: number;
  cutAfter: number;
} {
  const GAP = 1.0; // seconds — sections within this gap (or overlapping) merge.
  const merged: Array<{ id: string; reason: string }> = [];
  const camera = moments.filter(
    (m) =>
      m.effectType !== "crop" &&
      m.effectType !== "speed-up" &&
      m.effectType !== "cut"
  );
  const crops = dropAiOverlappingUser(
    moments.filter((m) => m.effectType === "crop"),
    merged
  ).sort((a, b) => a.startTime - b.startTime);
  const speeds = dropAiOverlappingUser(
    moments.filter((m) => m.effectType === "speed-up"),
    merged
  ).sort((a, b) => a.startTime - b.startTime);
  const cuts = dropAiOverlappingUser(
    moments.filter((m) => m.effectType === "cut"),
    merged
  ).sort((a, b) => a.startTime - b.startTime);

  const mergedCrops = mergeRun(
    crops,
    (prev, cur) =>
      prev.source !== "user" &&
      cur.source !== "user" &&
      prev.crop?.aspectRatio === cur.crop?.aspectRatio &&
      cur.startTime - prev.endTime <= GAP &&
      regionClose(prev, cur),
    (prev, cur) => {
      const keepCur = (cur.confidenceScore ?? 0) > (prev.confidenceScore ?? 0);
      merged.push({ id: keepCur ? prev.id : cur.id, reason: "merged-adjacent-crop" });
      return {
        ...(keepCur ? cur : prev),
        startTime: Math.min(prev.startTime, cur.startTime),
        endTime: Math.max(prev.endTime, cur.endTime),
      };
    }
  );

  const mergedSpeeds = mergeRun(
    speeds,
    (prev, cur) =>
      prev.source !== "user" &&
      cur.source !== "user" &&
      cur.startTime - prev.endTime <= GAP,
    (prev, cur) => {
      const mult = Math.max(
        prev.speed?.multiplier ?? 1,
        cur.speed?.multiplier ?? 1
      );
      const audioMode =
        prev.speed?.audioMode === "mute" || cur.speed?.audioMode === "mute"
          ? "mute"
          : prev.speed?.audioMode ?? "keep";
      merged.push({ id: cur.id, reason: "merged-adjacent-speed" });
      return {
        ...prev,
        endTime: Math.max(prev.endTime, cur.endTime),
        label: `Speed ${mult}×`,
        speed: { multiplier: mult, audioMode, transition: prev.speed?.transition ?? "cut" },
      };
    }
  );

  const mergedCuts = mergeRun(
    cuts,
    (prev, cur) =>
      prev.source !== "user" &&
      cur.source !== "user" &&
      prev.cut?.active !== false &&
      cur.cut?.active !== false &&
      cur.startTime - prev.endTime <= GAP,
    (prev, cur) => {
      merged.push({ id: cur.id, reason: "merged-adjacent-cut" });
      return {
        ...prev,
        endTime: Math.max(prev.endTime, cur.endTime),
      };
    }
  );

  return {
    moments: [...camera, ...mergedCuts, ...mergedCrops, ...mergedSpeeds].sort(
      (a, b) => a.startTime - b.startTime
    ),
    merged,
    cropBefore: crops.length,
    cropAfter: mergedCrops.length,
    speedBefore: speeds.length,
    speedAfter: mergedSpeeds.length,
    cutBefore: cuts.length,
    cutAfter: mergedCuts.length,
  };
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id: projectId } = await params;
  let ref: DocumentReference | null = null;
  // Wall-clock start — Gemini steps below are bounded by the remaining budget so
  // the route returns clean JSON before the platform's 300s hard kill.
  const reqStart = Date.now();
  const budgetRemainingMs = () => Math.max(0, FINALIZE_BUDGET_MS - (Date.now() - reqStart));

  try {
    // 1. Auth
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
    }

    const { auth, db, storage } = getAdmin();
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch (err) {
      console.error("[analyze] token verify failed", err);
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }
    const uid = decoded.uid;

    // 2. Load project
    ref = db.doc(`users/${uid}/projects/${projectId}`);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const project = snap.data() as Record<string, unknown>;
    const storagePath = project.storagePath as string | undefined;
    const mimeType = (project.mimeType as string | undefined) || "video/mp4";
    const duration = project.duration as number | undefined;
    const fileSize = project.fileSize as number | undefined;
    const interactionScope = project.interactionScope as
      | "tab"
      | "external"
      | undefined;
    const interactionsPath = project.interactionsPath as string | undefined;
    const captureDimensions = project.captureDimensions as
      | CaptureDimensions
      | undefined;
    const selectedPresetId = project.selectedPresetId as string | undefined;

    void recordEvent(EVENTS.ANALYSIS_STARTED, {
      userId: uid,
      userEmail: decoded.email ?? null,
      projectId,
      metadata: { duration: duration ?? null, interactionScope: interactionScope ?? null },
    });

    // Finalize mode (progressive chunked path): the client orchestrator already
    // streamed the timeline (progressive CV/event moments) + a merged
    // `visualAnalysis`. This pass is NON-DESTRUCTIVE — the progressive moments
    // are the source of truth. We PRESERVE ALL of them (not just user-edited):
    // because they are `provenance:"cv"`/`"event"`, the balancer keeps every
    // preserved moment (quota only drops `ai`/`ai-override`), so finalize can
    // only LABEL them, MERGE obvious boundary duplicates, ADD a few gap-fills,
    // and refresh chapter/preset metadata — never prune the timeline down to a
    // fresh whole-video balance. Direct runs send no body (a parse failure →
    // the normal flow), so all of this is gated on `isFinalize`.
    const reqBody = (await req.json().catch(() => null)) as {
      mode?: string;
      chunkCount?: number;
      progressiveCount?: number;
      analysisOptions?: AnalysisOptions;
      carryOver?: DetectedMoment[];
      /** Phase 4 — client-computed audio intelligence (Web Audio). */
      audioAnalysis?: AudioAnalysis | null;
      /** Force re-transcription even if a transcript already exists. */
      forceRetranscribe?: boolean;
    } | null;
    const isFinalize = reqBody?.mode === "finalize";
    // Phase 4 audio intelligence: prefer the client's fresh result, else fall
    // back to any previously-stored one (e.g. a re-run) so signals stay stable.
    const audioAnalysis: AudioAnalysis | null =
      reqBody?.audioAnalysis ??
      ((project.analysis as { audioAnalysis?: AudioAnalysis } | undefined)?.audioAnalysis ?? null);
    // Engine selection. A legacy no-body call → all-on default + empty
    // carry-over, i.e. exactly today's "clear and regenerate everything".
    const analysisOptions = reqBody?.analysisOptions ?? DEFAULT_ANALYSIS_OPTIONS;
    // User-selected video type (from the run options, falling back to the saved
    // project field). When it's not "auto" it OVERRIDES the model's detected type
    // so the balancer + edit recipe follow the user's declaration.
    const selectedVideoType = normalizeSelectedVideoType(
      analysisOptions.selectedVideoType ?? project.selectedVideoType
    );
    const videoTypeOverride = mapSelectedToDetectedVideoType(selectedVideoType);
    const finalizeChunkCount =
      typeof reqBody?.chunkCount === "number" ? reqBody.chunkCount : undefined;
    const progressiveMoments =
      (project.analysis as { detectedMoments?: DetectedMoment[] } | undefined)
        ?.detectedMoments ?? [];
    const dedup = isFinalize
      ? dedupeBoundaryDuplicates(progressiveMoments)
      : { kept: [] as DetectedMoment[], merged: [] as Array<{ id: string; reason: string }> };
    // Moments the balancer must keep verbatim:
    //  - finalize: the progressive timeline (source of truth).
    //  - direct: the carry-over set the client computed from `existingEditMode`
    //    (user edits + non-selected AI layers). The balancer regenerates the
    //    selected layers AROUND these (it bypasses spacing for preserved), so a
    //    direct re-analyze no longer wipes preserved edits.
    const carryOver = reqBody?.carryOver ?? [];
    const preservedMoments: DetectedMoment[] = isFinalize ? dedup.kept : carryOver;
    // Layers whose engine actually ran this analysis — mirrors the orchestrator
    // per-chunk gate (`shouldRunLayer`) so "keep = add missing" holds on the
    // server too. Used by the post-balance layer filter below.
    const ranLayers = ((): Set<EngineLayer> => {
      const existingAiLayers = aiLayersPresent(preservedMoments);
      return new Set(
        (["camera", "crop", "speed"] as EngineLayer[]).filter((l) =>
          shouldRunLayer(l, analysisOptions, existingAiLayers)
        )
      );
    })();

    if (isFinalize) {
      const perChunk =
        finalizeChunkCount && finalizeChunkCount > 0
          ? (progressiveMoments.length / finalizeChunkCount).toFixed(1)
          : "n/a";
      console.info("[finalize] before", {
        projectId,
        progressiveMoments: progressiveMoments.length,
        chunkCount: finalizeChunkCount ?? "unknown",
        momentsPerChunk: perChunk,
        boundaryDuplicatesMerged: dedup.merged.length,
      });
    }

    if (!storagePath) {
      return NextResponse.json({ error: "Project has no video uploaded" }, { status: 400 });
    }

    // ── Plan gate: Free plan is capped at 3-minute videos. Server backstop for
    // the client-side upload checks — catches a direct API call or a reanalyze
    // of an old long project. Gates on the stored/probed `duration`; an unknown
    // duration is not blocked here (the client paths probe a real one).
    const plan = await getUserPlan(uid);
    if (exceedsUploadDuration(plan, duration)) {
      return NextResponse.json(
        {
          error: FREE_VIDEO_DURATION_LIMIT_MESSAGE,
          kind: "duration_limit",
          code: FREE_VIDEO_DURATION_LIMIT_CODE,
          limit: FREE_UPLOAD_MAX_DURATION_SECONDS,
          duration,
        },
        { status: 402 }
      );
    }

    // ── Plan gate: refuse to analyze if the project has a premium preset
    // selected that this user can't use. Catches the case where someone
    // tampered `selectedPresetId` directly on their project doc.
    if (selectedPresetId && !(await canUsePreset(uid, selectedPresetId))) {
      return NextResponse.json(
        {
          error: "The preset on this project requires a higher plan. Upgrade or pick a different preset.",
          kind: "plan_required",
        },
        { status: 402 }
      );
    }

    // Pre-compute AI feature flags once so the gates below stay readable.
    const allowGapFill = await canUseAiFeature(uid, "advanced-balancing");
    const allowLabeling = await canUseAiFeature(uid, "ai-labeling");
    const allowVisualMoments = await canUseAiFeature(uid, "ai-visual-moments");
    if (!process.env.GEMINI_API_KEY) {
      await bail(ref, "unknown", "GEMINI_API_KEY is not configured on the server.");
      return NextResponse.json(
        { error: "Gemini is not configured on this server." },
        { status: 503 }
      );
    }

    // 3. Initialize analysis state (reset activity, clear errors, set estimate)
    const estimateSeconds = estimateAnalysisSeconds(fileSize, duration);
    await ref.set(
      {
        status: "preparing" as ProjectStatus,
        analysis: {
          status: "analyzing",
          stage: isFinalize ? "Finalizing timeline" : "Preparing analysis",
          // Finalize keeps the progressively-streamed moments on screen while
          // the AI pass runs; a direct run seeds the carry-over set (per the
          // chosen existingEditMode) instead of a blanket clear, so preserved
          // edits survive. `lastRunOptions` records the engine selection.
          ...(isFinalize
            ? {}
            : {
                detectedMoments: stripUndefined(reqBody?.carryOver ?? []),
                lastRunOptions: analysisOptions,
              }),
          boringSections: [],
          recommendedPresetIds: [],
          activity: [],
          startedAt: Date.now(),
          estimateSeconds,
          cancelRequested: false,
          errorKind: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await emitActivity(ref, "info", "Analysis started");

    // 4. Download from Storage
    await ensureNotCancelled(ref);
    const bucket = storage.bucket();
    const file = bucket.file(storagePath);
    const [exists] = await file.exists();
    if (!exists) {
      await bail(ref, "upload_failed", `Storage object missing: ${storagePath}`);
      return NextResponse.json({ error: "Source video missing" }, { status: 410 });
    }
    const [buffer] = await file.download();
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    await emitActivity(ref, "ok", `Downloaded video (${sizeMB} MB)`);

    // Load real interaction events if the recording carried them. Best-effort:
    // a missing/corrupt manifest just falls back to CV-only analysis.
    // `loadDiag` records exactly what happened in this stage so the Analysis
    // Debug panel can show whether the JSON sidecar was even reached.
    let interactions: Interaction[] = [];
    const loadDiag: {
      attemptedLoad: boolean;
      interactionsLoaded: boolean;
      loadReason?: string;
    } = { attemptedLoad: false, interactionsLoaded: false };
    // LOAD is now independent of scope: if a manifest exists, read it so its
    // clicks are at least counted. Whether the coordinates are TRUSTED (and
    // therefore drive zooms) is decided separately, just below.
    if (interactionsPath) {
      loadDiag.attemptedLoad = true;
      console.info("[analyze] loading interactions", {
        projectId,
        interactionsPath,
        scope: interactionScope,
      });
      await emitActivity(
        ref,
        "info",
        `Loading interactions from ${interactionsPath}`
      );
      try {
        const [iBuf] = await bucket.file(interactionsPath).download();
        const parsed = JSON.parse(iBuf.toString("utf8")) as {
          version: number;
          scope: string;
          events: Interaction[];
        };
        interactions = Array.isArray(parsed?.events) ? parsed.events : [];
        loadDiag.interactionsLoaded = true;
        await emitActivity(
          ref,
          "ok",
          `Loaded ${interactions.length} interaction event${interactions.length === 1 ? "" : "s"}`
        );
      } catch (err) {
        console.warn("[analyze] interactions load failed", err);
        loadDiag.loadReason =
          err instanceof Error
            ? `load-failed: ${err.message}`
            : "load-failed";
        await emitActivity(
          ref,
          "warn",
          "Interaction manifest unreadable — falling back to CV-only"
        );
      }
    } else {
      loadDiag.loadReason =
        interactionScope === "external"
          ? "scope=external (no interactions manifest saved)"
          : "no-interactionsPath";
    }

    // Separate LOAD from TRUST. We loaded the stream above regardless of scope
    // so diagnostics can count it, but only TRUSTED coordinates may drive
    // camera zooms. Rather than trust the capture-time scope blindly, we
    // INDEPENDENTLY re-validate it from the persisted capture dimensions —
    // a HiDPI tab that was misclassified at capture is corrected here.
    const resolvedScope = resolveScopeAndTrust(interactionScope, captureDimensions);
    const coordinatesTrusted = resolvedScope.coordinatesTrusted;
    const effectiveScope = resolvedScope.scopeValidated;
    const trustedInteractions: Interaction[] = coordinatesTrusted
      ? interactions
      : [];
    console.info("[analyze] scope validation", {
      projectId,
      scopeAssigned: resolvedScope.scopeAssigned,
      scopeValidated: resolvedScope.scopeValidated,
      coordinatesTrusted,
      validationReason: resolvedScope.validationReason,
    });
    if (interactions.length > 0) {
      await emitActivity(
        ref,
        coordinatesTrusted ? "ok" : "warn",
        coordinatesTrusted
          ? `Coordinates trusted — ${resolvedScope.trustReason}`
          : `Coordinates not trusted — ${resolvedScope.trustReason}; counting clicks for diagnostics only`
      );
    }

    await ensureNotCancelled(ref);

    // 5–6. Gemini refinement (upload → classify) — BEST-EFFORT, never fatal.
    // Gemini adds structure (videoType / narrative / presets) and, later,
    // gap-fill + labels. But it is NOT required to produce an edit: the
    // progressive/CV timeline, the deterministic overlays (hook / CTA /
    // smart-crop / text), and background ASR are all Gemini-INDEPENDENT. So a
    // Gemini upload/classify failure (a timeout, a flaky connection) must NOT
    // 500 the whole finalize — that would wipe the overlays + the transcript
    // dispatch too. On failure we log, fall back to the prior/neutral structure,
    // null the video ref (which skips gap-fill/labels), and carry on so the user
    // keeps every edit we can make without Gemini.
    const useInline = buffer.length <= INLINE_BYTE_LIMIT;
    const priorAnalysis = project.analysis as
      | {
          summary?: string;
          videoType?: SectionClassification["videoType"];
          narrativeStructure?: SectionClassification["narrativeStructure"];
          recommendedPresetIds?: string[];
        }
      | undefined;
    let geminiVideo: GeminiVideoRef | null = null;
    let sections: SectionClassification;
    try {
      if (useInline) {
        geminiVideo = { kind: "inline", buffer, mimeType };
        await emitActivity(ref, "info", `Using inline video (${sizeMB} MB)`);
      } else {
        await setStage(ref, "uploading_to_gemini", "Uploading to Gemini");
        await emitActivity(ref, "info", "Uploading video to Gemini Files API");
        // Hard ceiling so a flaky Gemini connection can't hang the whole run —
        // `uploadVideoToGemini` already bounds + retries each attempt internally.
        const uploaded = await withDeadline(
          uploadVideoToGemini(buffer, mimeType, {
            retries: 2,
            perAttemptTimeoutMs: Math.min(60_000, Math.max(5_000, budgetRemainingMs() - 30_000)),
          }),
          Math.min(150_000, Math.max(10_000, budgetRemainingMs())),
          "Uploading the video to Gemini timed out — please retry (temporary connectivity issue)."
        );
        await emitActivity(ref, "ok", `Uploaded — file id ${uploaded.name.split("/").pop()}`);
        await ensureNotCancelled(ref);
        await setStage(ref, "extracting_frames", "Extracting frames");
        await waitForGeminiFileActive(uploaded.name, {
          // Never let the file-active wait eat the whole budget — leave room for
          // the classify/gap-fill/label generations before the 300s wall.
          timeoutMs: Math.min(120_000, Math.max(1000, budgetRemainingMs())),
          shouldCancel: () => isCancelled(ref!),
          onProgress: async (state, attempt) => {
            if (attempt > 0 && attempt % 3 === 0) {
              await emitActivity(ref!, "info", `Gemini state: ${state}`);
            }
          },
        });
        await emitActivity(ref, "ok", "Gemini finished extracting frames");
        geminiVideo = { kind: "file", uri: uploaded.uri, mimeType: uploaded.mimeType };
      }

      await ensureNotCancelled(ref);

      // Phase A — Section classification (videoType, narrative, summary, presets).
      await setStage(ref, "analyzing", "Analyzing the video");
      await emitActivity(ref, "info", "Asking Gemini for structure (sections + classification)");
      sections = await withDeadline(
        classifyVideoSections({ video: geminiVideo, hintedDuration: duration }),
        budgetRemainingMs(),
        "Analysis timed out while classifying the video. Try a shorter clip or run it again."
      );
      await emitActivity(
        ref,
        "ok",
        `Classified as ${sections.videoType.replace(/-/g, " ")}${
          sections.narrativeStructure.length > 0
            ? ` · ${sections.narrativeStructure.length} narrative segments`
            : ""
        }`
      );
    } catch (gErr) {
      // Preserve REAL cancellation; only degrade on Gemini / connectivity errors.
      if (gErr instanceof CancelledError || gErr instanceof GeminiCancelled) throw gErr;
      geminiVideo = null; // skips gap-fill / visual / label below
      sections = {
        summary: priorAnalysis?.summary ?? "",
        videoType: priorAnalysis?.videoType ?? "mixed",
        narrativeStructure: priorAnalysis?.narrativeStructure ?? [],
        boringSections: [],
        recommendedPresetIds: priorAnalysis?.recommendedPresetIds ?? [],
      };
      console.warn("[analyze] Gemini refinement unavailable — continuing with deterministic edits + overlays", {
        projectId,
        error: gErr instanceof Error ? gErr.message : String(gErr),
      });
      await emitActivity(
        ref,
        "warn",
        "AI refinement unavailable (couldn't reach Gemini) — keeping your edits and adding overlays."
      );
    }

    await ensureNotCancelled(ref);

    // The type the edit recipe actually uses: the user's selection (mapped onto
    // the internal type) when set, else the model's detection (or the fallback).
    const effectiveVideoType = videoTypeOverride ?? sections.videoType;

    await ensureNotCancelled(ref);

    // 7. Phase B — Build the deterministic candidate pool. Real events first,
    // CV candidates as a backstop. Gemini contributes ZERO moments at this
    // stage (invariant 1).
    await setStage(ref, "generating_timeline", "Building your edit");

    const existingPacing = (project.effectsSettings as { pacing?: Pacing } | undefined)?.pacing;
    const pacing: Pacing = existingPacing ?? "moderate";
    // The project's zoom style bounds how long a generated zoom may run (see
    // timeline/zoom-normalize). Absent ⇒ the balancer's "standard" default.
    const zoomPreset = (
      project.effectsSettings as { zoomPreset?: ZoomPresetId } | undefined
    )?.zoomPreset;
    const visualAnalysis = project.visualAnalysis as VisualAnalysis | undefined;

    // ── Transcript (READ-ONLY during analysis; captions are DECOUPLED) ──────
    // Analysis NEVER starts ASR, reserves caption quota, or generates/replaces
    // captions. It only REUSES an existing complete transcript as a signal
    // (e.g. hook text). All caption generation flows through the dedicated
    // "Generate AI Captions" action. Existing caption moments are preserved
    // verbatim (see caption preservation at the merge below).
    const priorTranscript = (project.analysis as { transcript?: Transcript } | undefined)?.transcript;
    const transcript: Transcript = priorTranscript ?? { status: "unavailable" };
    const transcriptUsable = hasUsableTranscript(transcript);
    const silenceSegmentCount = audioAnalysis?.silenceSegments?.length ?? 0;
    console.info("[transcript:analysis]", {
      projectId,
      action: "reuse-only (captions decoupled from analysis)",
      status: transcript.status,
      transcriptSegments: transcript.segments?.length ?? 0,
    });
    console.info("[audio:analysis]", {
      projectId,
      audioStatus: audioAnalysis?.status ?? "not_run",
      hasUsableSpeech: audioAnalysis?.hasUsableSpeech ?? false,
      silenceSegments: silenceSegmentCount,
      transcriptStatus: transcript.status,
      transcriptSegments: transcript.segments?.length ?? 0,
    });

    // ── Edit Recipe Engine ────────────────────────────────────────────────
    // Request the structured edit PLAN for this run (which operations fit the
    // video type + the signals we actually have). It does NOT mutate the
    // zoom/cut/speed timeline built below — it's recorded on the analysis for
    // observability + future edit executors (captions, crop, overlays, music…).
    const isTabScope = interactionScope === "tab";
    const editRecipePlan = resolveEditRecipe({
      selectedVideoType,
      detectedVideoType: sections.videoType,
      signals: {
        // Phase 4 — real transcript/audio signals gate captions + silence removal.
        hasTranscript: transcriptUsable,
        hasAudioAnalysis: audioAnalysis?.status === "complete",
        hasUsableSpeech: audioAnalysis?.hasUsableSpeech ?? false,
        silenceSegmentCount,
        transcriptLanguage: transcript.language,
        hasSceneData: (visualAnalysis?.sceneChanges?.length ?? 0) > 0,
        hasVisualMoments: (visualAnalysis?.sampleCount ?? 0) > 0,
        hasInteractionData: isTabScope,
        isScreenRecording: selectedVideoType === "screen-recording" || isTabScope,
        durationSeconds: duration ?? undefined,
      },
    });
    logEditRecipePlan(editRecipePlan, { projectId, mode: isFinalize ? "finalize" : "direct" });

    // Cursor intent (hesitation / velocity per bucket) feeds the click
    // classifier's "deliberate approach" signal — small bump per click
    // when the user slowed before pressing. Cheap; skip when there's
    // no interaction stream.
    // Pipeline consumers see only TRUSTED interactions. For untrusted/external
    // recordings this is `[]`, preserving the existing CV-only behaviour while
    // the full loaded stream is still counted in diagnostics below.
    const cursorIntentSeries =
      trustedInteractions.length > 0
        ? cursorIntent(
            trustedInteractions,
            duration ?? 0,
            visualAnalysis?.sampleRate ?? 10
          )
        : undefined;

    const eventMoments =
      trustedInteractions.length > 0
        ? momentsFromEvents(trustedInteractions, {
            duration: duration ?? 0,
            cursorIntent: cursorIntentSeries,
            visualAnalysis,
            scope: effectiveScope,
          })
        : [];

    // Click → moment conversion summary. Counts the raw clicks
    // (left + double + right) against the moments they produced so the
    // analyze log surfaces when many clicks collapsed into few moments
    // (resolveOverlaps merge) vs many clicks got their own moment.
    // The downstream balancer still applies its own selection rules;
    // this is "what events.ts emitted before selection."
    const totalClicks = interactions.filter(
      (e) => e.type === "click" || e.type === "dblclick" || e.type === "rightclick"
    ).length;
    const clickMoments = eventMoments.filter(
      (m) => m.provenance === "event" &&
        (m.eventIds ?? []).some((id) => id.startsWith("ev_"))
    ).length;

    // Per-tier breakdown — re-run classifyClick to tally tiers. Cheap
    // (pure function, no I/O) and decoupled from events.ts emit logic.
    // We classify single-clicks AND dblclicks as primary-cta (events.ts
    // does the same); right-clicks are always primary-cta by spec.
    const clickMomentsByTier: ClickPipelineDiagnostics["clickMomentsByTier"] = {
      "primary-cta": 0,
      icon: 0,
      nav: 0,
      form: 0,
      background: 0,
    };
    for (const e of interactions) {
      if (e.type === "click") {
        const cls = classifyClick({
          click: { x: e.x, y: e.y, t: e.t, targetRect: e.targetRect },
          cursorIntent: cursorIntentSeries,
          visualAnalysis,
          scope: effectiveScope ?? "tab",
        });
        clickMomentsByTier[cls.tier as ClickTier] += 1;
      } else if (e.type === "dblclick" || e.type === "rightclick") {
        clickMomentsByTier["primary-cta"] += 1;
      }
    }
    if (interactions.length > 0) {
      await emitActivity(
        ref,
        "ok",
        `Derived ${eventMoments.length} moment${
          eventMoments.length === 1 ? "" : "s"
        } from ${interactions.length} interaction event${
          interactions.length === 1 ? "" : "s"
        } (${totalClicks} click${totalClicks === 1 ? "" : "s"} → ${clickMoments} click moment${
          clickMoments === 1 ? "" : "s"
        })`
      );
      console.info("[analyze] click→moment summary", {
        projectId,
        totalInteractions: interactions.length,
        totalClicks,
        clickMomentsEmitted: clickMoments,
        totalEventMoments: eventMoments.length,
        scope: interactionScope,
      });
    }

    // Canonical attention curve — single importance signal across the product.
    // Only trusted interactions feed it (external coords would be noise; the
    // curve's own `useEvents` gate also drops them, so this is belt-and-braces).
    const attention = attentionCurve({
      duration: duration ?? 0,
      interactions: trustedInteractions,
      interactionScope: effectiveScope,
      visualAnalysis,
      uiRegions: visualAnalysis?.uiRegions,
    });

    // First selection pass: events + CV only. No `raw` AI input. This gives
    // us the deterministic-only timeline before we even consider gap-fill.
    // boringSections + interactions are passed so the reject pass can drop
    // CV candidates that landed in quiet/idle stretches.
    const firstPass = balanceTimeline({
      raw: [],
      duration: duration ?? 0,
      pacing,
      videoType: effectiveVideoType,
      visualAnalysis,
      eventMoments,
      // Finalize: the progressive moments ARE the CV result — don't regenerate
      // CV candidates (that's what pruned 17 → 6–7). Direct runs still do.
      useCvCandidates: !isFinalize,
      boringSections: sections.boringSections,
      interactions,
      preserved: preservedMoments,
      zoomPreset,
    });

    await ensureNotCancelled(ref);

    // 8. Phase C — Detect coverage gaps and call Gemini for limited gap-fill
    // ONLY. Gemini sees the empty windows and the maxMoments budget; it
    // cannot exceed either. Quota math: even if every gap-fill survives,
    // they make up ≤ AI_MOMENT_QUOTA of the final timeline.
    const GAP_MIN_SECONDS = 15;
    const dur = duration ?? 0;
    const sortedFirst = [...firstPass.moments].sort((a, b) => a.startTime - b.startTime);
    const rawGaps: Array<{ startTime: number; endTime: number }> = [];
    let cursor = 0;
    for (const m of sortedFirst) {
      if (m.startTime - cursor >= GAP_MIN_SECONDS) {
        rawGaps.push({ startTime: cursor, endTime: m.startTime });
      }
      cursor = Math.max(cursor, m.endTime);
    }
    if (dur - cursor >= GAP_MIN_SECONDS) {
      rawGaps.push({ startTime: cursor, endTime: dur });
    }

    // Pre-filter: drop any gap that sits entirely inside a boring section —
    // no point asking Gemini to fill a window we already classified as quiet.
    const isFullyInsideBoring = (
      g: { startTime: number; endTime: number }
    ): boolean =>
      (sections.boringSections ?? []).some(
        (b) => g.startTime >= b.startTime - 0.1 && g.endTime <= b.endTime + 0.1
      );
    const gaps = rawGaps.filter((g) => !isFullyInsideBoring(g));
    const skippedBoringGaps = rawGaps.length - gaps.length;
    if (skippedBoringGaps > 0) {
      await emitActivity(
        ref,
        "info",
        `Skipped ${skippedBoringGaps} gap${skippedBoringGaps === 1 ? "" : "s"} inside boring sections`
      );
    }

    // Quota-aware budget: gap-fills count as AI moments. Project the final
    // size as max(firstPass + maxFills, MIN_MOMENTS) and back-solve. We're
    // conservative — pick the floor.
    const projectedTotal = firstPass.moments.length + gaps.length;
    const aiBudget = Math.max(
      0,
      Math.min(gaps.length, Math.floor(projectedTotal * AI_MOMENT_QUOTA) + 1)
    );

    let aiGapMoments: DetectedMoment[] = [];
    if (gaps.length > 0 && aiBudget > 0 && !allowGapFill) {
      await emitActivity(
        ref,
        "info",
        "AI gap-fill skipped — Creator plan required for advanced AI balancing"
      );
    } else if (geminiVideo && gaps.length > 0 && aiBudget > 0) {
      await emitActivity(
        ref,
        "info",
        `Asking Gemini to fill ${gaps.length} coverage gap${
          gaps.length === 1 ? "" : "s"
        } (budget ${aiBudget})`
      );
      try {
        const proposals = await withDeadline(
          proposeGapFills({
            video: geminiVideo,
            gaps,
            maxMoments: aiBudget,
            boringSections: sections.boringSections,
          }),
          budgetRemainingMs(),
          "gap-fill timed out"
        );
        aiGapMoments = proposals.map((p, i) => ({
          id: `mom_ai_${i + 1}`,
          startTime: p.startTime,
          endTime: p.endTime,
          label: p.label || "AI suggestion",
          reason: p.reason || "",
          focusRegion: p.focusRegion,
          effectType: p.effectType,
          uiContext: p.uiContext,
          attentionScore: p.attentionScore,
          recommendedIntensity: p.recommendedIntensity,
          source: "ai",
          provenance: "ai" as MomentProvenance,
          confidenceScore: Math.max(0.3, Math.min(0.6, p.attentionScore)),
          confidenceSource: "ai-gap-fill" as const,
          confidenceReason: `${Math.max(0.3, Math.min(0.6, p.attentionScore)).toFixed(2)} — AI gap-fill in ${p.startTime.toFixed(1)}–${p.endTime.toFixed(1)}s coverage gap`,
          // Explainability — Gemini chose this effect for this window.
          whyEffectType: `Gemini gap-fill → ${p.effectType}${p.uiContext ? ` (${p.uiContext} context)` : ""}`,
          targetRegionSource: "ai-proposal" as const,
          sourceSignals: ["ai-gap-fill", `gap@${p.startTime.toFixed(1)}-${p.endTime.toFixed(1)}`],
        }));
        await emitActivity(
          ref,
          "ok",
          `Gemini proposed ${aiGapMoments.length} gap-fill moment${
            aiGapMoments.length === 1 ? "" : "s"
          }`
        );
      } catch (err) {
        console.warn("[analyze] gap-fill failed", err);
        await emitActivity(ref, "warn", "Gap-fill call failed — proceeding with deterministic timeline only");
      }
    } else if (gaps.length === 0) {
      await emitActivity(ref, "info", "No coverage gaps ≥15s — skipping AI gap-fill");
    }

    // 8b. Phase C2 — Gemini VISUAL MOMENTS (paid enhancement). For uploads with
    // no real interaction events, Gemini watches the video and proposes moments
    // directly (not gap-bounded). The deterministic CV engine still carries the
    // FREE base timeline; these merge into the AI pool and are bounded by the
    // same AI_MOMENT_QUOTA at the final balance. Skipped when real events exist
    // (the event path is authoritative) or the user lacks the feature.
    let aiVisualMoments: DetectedMoment[] = [];
    // Skipped in finalize: this IS the whole-video CV generator whose output the
    // balancer pruned down to 6–7. The progressive chunk pass already produced
    // the CV timeline, so finalize must not regenerate it.
    if (geminiVideo && !isFinalize && eventMoments.length === 0 && allowVisualMoments && dur > 0) {
      const visualBudget = Math.max(4, Math.min(12, Math.ceil(dur / 20)));
      await emitActivity(
        ref,
        "info",
        `Asking Gemini to find visual moments (budget ${visualBudget})`
      );
      try {
        const proposals = await proposeVisualMoments({
          video: geminiVideo,
          hintedDuration: dur,
          maxMoments: visualBudget,
          boringSections: sections.boringSections,
        });
        aiVisualMoments = proposals.map((p, i) => ({
          id: `mom_vis_${i + 1}`,
          startTime: p.startTime,
          endTime: p.endTime,
          label: p.label || "Visual moment",
          reason: p.reason || "",
          focusRegion: p.focusRegion,
          effectType: p.effectType,
          uiContext: p.uiContext,
          attentionScore: p.attentionScore,
          recommendedIntensity: p.recommendedIntensity,
          source: "ai",
          provenance: "ai" as MomentProvenance,
          confidenceScore: Math.max(0.3, Math.min(0.6, p.attentionScore)),
          confidenceSource: "ai-gap-fill" as const,
          confidenceReason: `${Math.max(0.3, Math.min(0.6, p.attentionScore)).toFixed(2)} — Gemini visual moment at ${p.startTime.toFixed(1)}s`,
          whyEffectType: `Gemini visual detection → ${p.effectType}${p.uiContext ? ` (${p.uiContext} context)` : ""}`,
          targetRegionSource: "ai-proposal" as const,
          sourceSignals: ["ai-visual-moment", `t@${p.startTime.toFixed(1)}`],
        }));
        await emitActivity(
          ref,
          "ok",
          `Gemini proposed ${aiVisualMoments.length} visual moment${aiVisualMoments.length === 1 ? "" : "s"}`
        );
      } catch (err) {
        console.warn("[analyze] visual-moments failed", err);
        await emitActivity(ref, "warn", "Visual-moments call failed — using the deterministic visual engine only");
      }
    } else if (eventMoments.length === 0 && !allowVisualMoments) {
      await emitActivity(
        ref,
        "info",
        "Visual AI moments are a Pro feature — using the free on-device visual engine"
      );
    }

    await ensureNotCancelled(ref);

    // 9. Phase D — Final balance pass with the unified pool. Priority +
    // quota enforcement is applied here. Old `rawMoments` from previous runs
    // (if any) are NOT used — we keep the new candidate pool as `rawMoments`
    // for the rebalance endpoint. boringSections + interactions feed the
    // reject pass so AI gap-fills in idle / quiet stretches are dropped.
    const balanced = balanceTimeline({
      raw: [...aiGapMoments, ...aiVisualMoments],
      duration: dur,
      pacing,
      videoType: effectiveVideoType,
      visualAnalysis,
      eventMoments,
      // Finalize keeps progressive moments as `preserved`; don't regenerate CV.
      useCvCandidates: !isFinalize,
      boringSections: sections.boringSections,
      interactions,
      preserved: preservedMoments,
      zoomPreset,
    });

    await ensureNotCancelled(ref);

    // 10. Phase E — Label the FINAL moments. Gemini sees the chosen moments
    // and returns label + reason per id. It cannot add or remove moments
    // here — labeling is display-only.
    const needsLabeling = balanced.moments
      .filter((m) => m.provenance !== "user")
      .map((m) => ({
        id: m.id,
        startTime: m.startTime,
        endTime: m.endTime,
        hint:
          m.provenance === "event"
            ? `derived from real interaction (${m.confidenceSource ?? "event"})`
            : m.provenance === "cv"
              ? `inferred from CV signals (${m.confidenceSource ?? "motion"})`
              : `AI gap-fill`,
        uiContext: m.uiContext,
      }));

    if (needsLabeling.length > 0 && !allowLabeling) {
      await emitActivity(
        ref,
        "info",
        "AI labeling skipped — Creator plan required for cinematic AI labels"
      );
    } else if (geminiVideo && needsLabeling.length > 0) {
      await emitActivity(ref, "info", `Asking Gemini to label ${needsLabeling.length} moment${needsLabeling.length === 1 ? "" : "s"}`);
      try {
        const labels = await withDeadline(
          labelMoments({ video: geminiVideo, moments: needsLabeling }),
          budgetRemainingMs(),
          "labeling timed out"
        );
        const byId = new Map(labels.map((l) => [l.id, l]));
        for (const m of balanced.moments) {
          const l = byId.get(m.id);
          if (l) {
            m.label = l.label;
            // Keep our confidenceReason as the structured one; surface
            // Gemini's reason on the editorial `reason` field.
            m.reason = l.reason || m.reason;
          }
        }
        await emitActivity(ref, "ok", `Labelled ${labels.length} moment${labels.length === 1 ? "" : "s"}`);
      } catch (err) {
        console.warn("[analyze] labeling failed", err);
        await emitActivity(ref, "warn", "Labeling call failed — using deterministic labels");
      }
    }

    // Stats reporting (now driven by the new pipeline's balancer output).
    if (balanced.stats.rewrittenEffects > 0) {
      await emitActivity(
        ref,
        "info",
        `Rewrote ${balanced.stats.rewrittenEffects} effect${
          balanced.stats.rewrittenEffects === 1 ? "" : "s"
        } by UI context (e.g. scroll → speed-up)`
      );
    }
    if (balanced.stats.rhythmPenalized > 0) {
      await emitActivity(
        ref,
        "info",
        `Rhythm memory adjusted ${balanced.stats.rhythmPenalized} pick${
          balanced.stats.rhythmPenalized === 1 ? "" : "s"
        }`
      );
    }
    if (balanced.stats.droppedTooClose > 0) {
      await emitActivity(
        ref,
        "info",
        `Balancer pruned ${balanced.stats.droppedTooClose} clustered moment${
          balanced.stats.droppedTooClose === 1 ? "" : "s"
        }`
      );
    }
    if (balanced.stats.quotaDropped > 0) {
      await emitActivity(
        ref,
        "info",
        `Dropped ${balanced.stats.quotaDropped} AI moment${
          balanced.stats.quotaDropped === 1 ? "" : "s"
        } to honor the ${Math.round(AI_MOMENT_QUOTA * 100)}% quota`
      );
    }
    if (balanced.stats.eventOverlapsResolved > 0) {
      await emitActivity(
        ref,
        "info",
        `Resolved ${balanced.stats.eventOverlapsResolved} candidate overlap${
          balanced.stats.eventOverlapsResolved === 1 ? "" : "s"
        } by priority`
      );
    }
    // New: surface what the reject pass dropped — the user wants to see
    // *why* the timeline ends up smaller now.
    if (balanced.stats.aiRejectedBoring > 0) {
      await emitActivity(
        ref,
        "info",
        `Rejected ${balanced.stats.aiRejectedBoring} AI moment${
          balanced.stats.aiRejectedBoring === 1 ? "" : "s"
        } in boring sections`
      );
    }
    if (balanced.stats.aiRejectedIdle > 0) {
      await emitActivity(
        ref,
        "info",
        `Rejected ${balanced.stats.aiRejectedIdle} AI moment${
          balanced.stats.aiRejectedIdle === 1 ? "" : "s"
        } inside long idle stretches`
      );
    }
    if (balanced.stats.aiRejectedNoTarget > 0) {
      await emitActivity(
        ref,
        "info",
        `Rejected ${balanced.stats.aiRejectedNoTarget} AI moment${
          balanced.stats.aiRejectedNoTarget === 1 ? "" : "s"
        } with no meaningful target`
      );
    }
    if (balanced.stats.sceneChangeNudged > 0) {
      await emitActivity(
        ref,
        "info",
        `Nudged ${balanced.stats.sceneChangeNudged} moment${
          balanced.stats.sceneChangeNudged === 1 ? "" : "s"
        } to start after a scene change`
      );
    }
    const emptyQuartiles = balanced.stats.quartileCoverage.filter((c) => !c).length;
    if (balanced.stats.quartileLeftEmpty > 0) {
      await emitActivity(
        ref,
        "info",
        `${balanced.stats.quartileLeftEmpty} quartile${
          balanced.stats.quartileLeftEmpty === 1 ? "" : "s"
        } silent — candidates rejected as boring/idle (honouring rejection)`
      );
    } else if (emptyQuartiles > 0) {
      await emitActivity(
        ref,
        "warn",
        `${emptyQuartiles} of 4 quartiles had no detectable activity`
      );
    } else {
      await emitActivity(ref, "ok", "All 4 quartiles covered");
    }
    const distScore = distributionScore(balanced.moments, duration ?? 0);
    await emitActivity(
      ref,
      "info",
      `Distribution score ${(distScore * 100).toFixed(0)}/100 · avg attention ${(balanced.stats.avgAttention * 100).toFixed(0)}/100`
    );

    // Preset recommendations come from the section classifier.
    await setStage(ref, "generating_presets", "Generating presets");
    if (sections.recommendedPresetIds.length > 0) {
      await emitActivity(
        ref,
        "ok",
        `Recommended ${sections.recommendedPresetIds.length} preset${
          sections.recommendedPresetIds.length === 1 ? "" : "s"
        }`
      );
    } else {
      await emitActivity(ref, "warn", "No preset matched strongly — defaults will be used");
    }

    await ensureNotCancelled(ref);

    // 11. Finalize. `rawMoments` is the full candidate pool (event + cv +
    // ai-gap-fill + rejected) so the rebalance endpoint can re-pick without
    // re-calling Gemini — and so denser presets can un-reject the rejected
    // pool. User-edited moments live in `detectedMoments` and are preserved
    // across rebalance.
    const rawPool: DetectedMoment[] = [
      ...eventMoments,
      ...aiGapMoments,
      ...aiVisualMoments,
      ...balanced.rejectedPool,
    ];
    // Firestore rejects writes containing `undefined` anywhere in the
    // document. Optional fields like `whyEffectType` or `targetRegionSource`
    // are absent on legacy / CV / preserved moments — strip them out before
    // persisting so the write doesn't blow up.
    // ── Finalize safety guard ──────────────────────────────────────────────
    // Progressive moments are the source of truth. With preserve-all +
    // useCvCandidates:false they always survive, so `balanced.moments` is
    // `progressive + a few gap-fills` and `removed` is normally empty. The guard
    // is belt-and-braces: if the balance somehow dropped >20% of the progressive
    // moments (and the drops aren't just duplicates), keep the progressive
    // timeline (with labels applied) + the surviving additive gap-fills.
    let finalMoments = balanced.moments;
    if (isFinalize) {
      const balancedIds = new Set(balanced.moments.map((m) => m.id));
      const removed = preservedMoments.filter((m) => !balancedIds.has(m.id));
      const onlyDuplicates =
        removed.length > 0 &&
        removed.every((r) =>
          balanced.moments.some(
            (b) => Math.abs(b.startTime - r.startTime) < 0.4 && regionClose(b, r)
          )
        );
      const removedRatio =
        preservedMoments.length > 0 ? removed.length / preservedMoments.length : 0;
      const added = balanced.moments.filter(
        (m) => !preservedMoments.some((p) => p.id === m.id)
      );

      if (removed.length > 0 && removedRatio > 0.2 && !onlyDuplicates) {
        // Block the destructive write — rebuild from the preserved timeline.
        finalMoments = [...applyLabels(preservedMoments, balanced.moments), ...added].sort(
          (a, b) => a.startTime - b.startTime
        );
        await emitActivity(
          ref,
          "warn",
          `Finalize protection — kept ${preservedMoments.length} progressive edits (balance tried to drop ${removed.length}).`
        );
      }

      // Duration-preservation guard: a final moment must never collapse to a
      // zero-width marker. Clamp any missing/zero/inverted endTime to
      // startTime + a minimum length so the timeline renders a real clip.
      const MIN_FINAL_LEN = 0.5;
      let durationFixed = 0;
      finalMoments = finalMoments.map((m) => {
        const d = m.endTime - m.startTime;
        if (!Number.isFinite(d) || d < MIN_FINAL_LEN) {
          durationFixed++;
          return { ...m, endTime: Number(m.startTime || 0) + MIN_FINAL_LEN };
        }
        return m;
      });

      // Non-destructive crop/speed finalize: merge adjacent same-type AI
      // sections (cross-chunk runs) + let user sections win. Never drops a
      // standalone section, so this can't trip the zoom guard above.
      const cropSpeedBefore = {
        crop: finalMoments.filter((m) => m.effectType === "crop").length,
        speed: finalMoments.filter((m) => m.effectType === "speed-up").length,
      };
      const cs = mergeCropSpeedSections(finalMoments);
      finalMoments = cs.moments;

      console.info("[finalize] after", {
        projectId,
        finalMoments: finalMoments.length,
        progressive: preservedMoments.length,
        added: added.length,
        removed: removed.length,
        boundaryDuplicatesMerged: dedup.merged.length,
        durationFixed,
        // Crop/Speed engine finalize diagnostics (req).
        cropSections: { before: cropSpeedBefore.crop, after: cs.cropAfter },
        speedSections: { before: cropSpeedBefore.speed, after: cs.speedAfter },
        cropSpeedMerged: cs.merged,
        removedReasons: [
          ...dedup.merged,
          ...cs.merged,
          ...removed.map((r) => ({
            id: r.id,
            reason: onlyDuplicates ? "duplicate (allowed)" : "balancer-dropped (blocked)",
          })),
        ],
        // Per-moment timing diagnostics (req): start / end / duration.
        moments: finalMoments.map((m) => ({
          id: m.id,
          startTime: Number(m.startTime.toFixed(2)),
          endTime: Number(m.endTime.toFixed(2)),
          duration: Number((m.endTime - m.startTime).toFixed(2)),
        })),
      });
      await emitActivity(
        ref,
        "ok",
        `Finalize: ${preservedMoments.length} progressive → ${finalMoments.length} edits (+${added.length} added, ${removed.length} removed, ${dedup.merged.length} dup-merged).`
      );
    }

    // ── Layer guard (req: finalize must not re-add disabled layers) ──────────
    // Keep a moment only if its layer actually ran this analysis OR it was a
    // deliberately-preserved carry-over moment. This strips Gemini gap-fills /
    // visual moments that landed in a layer the user turned off (or, in "keep"
    // mode, a layer that already had edits). Runs AFTER the 20%-drop "Finalize
    // protection" guard above and never removes a preserved id, so it can't
    // false-trip that guard. Covers both finalize and direct paths.
    const preservedIds = new Set(preservedMoments.map((m) => m.id));
    const beforeLayerFilter = finalMoments.length;
    finalMoments = finalMoments.filter(
      (m) => ranLayers.has(layerForMoment(m)) || preservedIds.has(m.id)
    );
    const droppedDisabled = beforeLayerFilter - finalMoments.length;
    if (droppedDisabled > 0) {
      console.info("[analyze] layer filter", {
        projectId,
        ranLayers: [...ranLayers],
        existingEditMode: analysisOptions.existingEditMode,
        dropped: droppedDisabled,
      });
    }

    // ── THE AI EDITOR — editorial decision stage ────────────────────────────
    // Everything above produced the UNDERSTANDING and a pool of CANDIDATE
    // edits. Nothing above asked whether the resulting timeline is one a
    // professional editor would sign off on — the per-chunk engines each judge
    // a 30-second window in isolation, and their output reaches here intact
    // (progressive moments enter the balancer as `preserved`, bypassing its
    // whole selection pass). That is why edits felt random and over-applied.
    //
    // This stage is the missing judgment: every candidate must justify itself
    // or it does not exist, and the judgment is made across the WHOLE video so
    // rhythm, density and the intro→end distribution are consistent rather
    // than per-chunk.
    //
    // Placement is deliberate:
    //   · AFTER the finalize-protection guard, so that guard still does its job
    //     (catching a BALANCER regression) and never reverts a decision this
    //     engine made on purpose.
    //   · AFTER the layer guard, so disabled layers are already gone.
    //   · BEFORE overlay generation, so structural overlays the user explicitly
    //     toggled on (hook text, CTA, callouts) are never second-guessed.
    //   · BEFORE the Director stage, so a brief-led edit layers on top and is
    //     judged by the Director's own editorial engine instead of twice here.
    const editorialCtx: EditorialContext = {
      duration: dur,
      pacing,
      videoType: effectiveVideoType,
      narrativeStructure: sections.narrativeStructure,
      boringSections: sections.boringSections,
      attentionCurve: attention.curveQ8,
      attentionSampleRate: attention.sampleRate,
      sceneChanges: (visualAnalysis?.sceneChanges ?? []).map((s) => s.t),
      // Both real recorded clicks and CV-inferred ones ground an emphasis edit.
      clickTimes: [
        ...trustedInteractions.filter((e) => e.type === "click").map((e) => e.t),
        ...(visualAnalysis?.clickEvents ?? []).map((c) => c.t),
      ],
      silenceSegments: audioAnalysis?.silenceSegments,
    };
    const editorial = decideTimeline(finalMoments, editorialCtx);
    let editorialKept = editorial.kept;
    const editorialRejects = [...editorial.rejected];

    console.info("[ai-editor] deterministic", { projectId, ...editorial.log });

    // ── The semantic pass ────────────────────────────────────────────────────
    // The deterministic engine enforced grounding, rhythm and budget. This asks
    // what no heuristic can: is this edit actually meaningful to what the video
    // is SAYING here? It runs on the survivors and can only prune further —
    // never resurrect, never add — so a model failure degrades to the
    // deterministic verdict instead of changing the timeline's character.
    // Best-effort and deadline-bounded like every other Gemini step: this must
    // never be what pushes finalize past the platform kill.
    const judgedIds = new Set(
      editorial.verdicts.filter((v) => v.keep).map((v) => v.id)
    );
    const reviewable = editorialKept.filter((m) => judgedIds.has(m.id));
    if (geminiVideo && allowLabeling && reviewable.length > 0 && budgetRemainingMs() > 20_000) {
      try {
        const decisions = await withDeadline(
          reviewEditorialDecisions({
            video: geminiVideo,
            durationSeconds: dur,
            videoType: effectiveVideoType,
            videoSummary: sections.summary,
            candidates: reviewable.map((m) => ({
              id: m.id,
              startTime: m.startTime,
              endTime: m.endTime,
              effectType: String(m.effectType ?? "zoom"),
              reason: m.editorialReason ?? m.reason,
              confidence: m.confidenceScore,
              narrativeRole: sections.narrativeStructure?.find(
                (s) => m.startTime >= s.startTime && m.startTime < s.endTime
              )?.role,
              attention: attentionValueAt(
                attention.curveQ8,
                attention.sampleRate,
                m.startTime
              ),
            })),
          }),
          Math.min(90_000, Math.max(10_000, budgetRemainingMs() - 20_000)),
          "editorial review timed out"
        );
        const dropped = new Map(
          decisions.filter((d) => !d.keep).map((d) => [d.id, d.reason])
        );
        const rejustified = new Map(
          decisions.filter((d) => d.keep).map((d) => [d.id, d])
        );
        if (dropped.size > 0 || rejustified.size > 0) {
          const next: DetectedMoment[] = [];
          for (const m of editorialKept) {
            const drop = dropped.get(m.id);
            if (drop !== undefined) {
              editorialRejects.push({
                ...m,
                rejected: true,
                rejectedReason: "editor-review",
                editorialReason:
                  drop || "The editorial review found no reason for this edit to exist.",
              });
              continue;
            }
            const kept = rejustified.get(m.id);
            next.push(
              kept?.reason
                ? {
                    ...m,
                    editorialReason: kept.reason,
                    ...(isEditorialJustification(kept.justification)
                      ? { justification: kept.justification }
                      : {}),
                  }
                : m
            );
          }
          editorialKept = next;
        }
        console.info("[ai-editor] semantic", {
          projectId,
          reviewed: reviewable.length,
          droppedByModel: dropped.size,
          kept: editorialKept.length,
        });
      } catch (err) {
        // Non-fatal by design — the deterministic verdict already stands.
        console.warn("[ai-editor] semantic pass skipped", {
          projectId,
          error: err instanceof Error ? err.message : String(err),
        });
        await emitActivity(
          ref,
          "warn",
          "Editorial review unavailable — kept the edits the decision engine approved."
        );
      }
    }

    const editorialRemoved = finalMoments.length - editorialKept.length;
    finalMoments = editorialKept;
    if (editorialRemoved > 0) {
      await emitActivity(
        ref,
        "info",
        `AI Editor kept ${finalMoments.length} of ${finalMoments.length + editorialRemoved} candidate edits — the rest couldn't be justified.`
      );
    }

    // ── Phase-3 overlay generation (deterministic, whole-video) ─────────────
    // Turn the recipe's enabled overlay categories into real edits (hook text,
    // CTA, text labels, callouts, transitions) + a smart-crop output canvas.
    // Runs AFTER the layer guard so these additive edits are never dropped.
    // Idempotent: skips any category that already has a moment (manual or a
    // prior run), so re-analysis never duplicates or clobbers user overlays.
    const existingOutputCanvas =
      (project.effectsSettings as { outputCanvas?: unknown } | undefined)?.outputCanvas != null;
    const overlayGen = generateOverlayEdits({
      plan: editRecipePlan,
      moments: finalMoments,
      duration: dur,
      projectTitle: (project.title as string | undefined) ?? null,
      hasOutputCanvas: existingOutputCanvas,
      // Phase 4 — real transcript drives auto-captions + strengthens the hook.
      transcript,
      // Analyze-modal toggles — `false` SUPPRESSES that category (maps the UI
      // toggle names onto recipe categories; branding = CTA).
      allow: {
        hook_text: analysisOptions.generateHookText,
        text_overlay: analysisOptions.generateTextOverlays,
        smart_crop: analysisOptions.generateSmartCrop,
        callout: analysisOptions.generateCallouts,
        transition: analysisOptions.generateTransitions,
        branding: analysisOptions.generateCta,
      },
    });
    if (overlayGen.moments.length > 0) {
      finalMoments = [...finalMoments, ...overlayGen.moments].sort(
        (a, b) => a.startTime - b.startTime
      );
    }
    console.info("[edit-recipe:overlays]", {
      projectId,
      generated: overlayGen.log.generated,
      skipped: overlayGen.log.skipped,
      smartCropAspect: overlayGen.log.smartCropAspect,
      appliedOutputCanvas: !!overlayGen.outputCanvas,
    });

    // ── Captions are DECOUPLED from analysis ────────────────────────────────
    // Analysis NEVER generates captions (that lives behind the dedicated
    // "Generate AI Captions" action). It MUST preserve every EXISTING caption
    // moment — AI or manual — untouched across a re-analyze, regardless of the
    // chosen existingEditMode, so the balancer's layer filter can't drop them.
    const originalCaptions = (
      (project.analysis as { detectedMoments?: DetectedMoment[] } | undefined)?.detectedMoments ?? []
    ).filter((m) => m.effectType === "captions");
    const presentIds = new Set(finalMoments.map((m) => m.id));
    const reAddedCaptions = originalCaptions.filter((m) => !presentIds.has(m.id));
    if (reAddedCaptions.length > 0) {
      finalMoments = [...finalMoments, ...reAddedCaptions].sort(
        (a, b) => a.startTime - b.startTime
      );
    }
    console.info("[captions:analysis]", {
      projectId,
      decoupled: true,
      existingCaptions: originalCaptions.length,
      preserved: reAddedCaptions.length,
    });
    if (overlayGen.moments.length > 0) {
      await emitActivity(
        ref,
        "ok",
        `Added ${overlayGen.moments.length} overlay edit${overlayGen.moments.length === 1 ? "" : "s"} from the ${editRecipePlan.recipeName} recipe`
      );
    }

    // ── THE DIRECTOR STAGE ───────────────────────────────────────────────────
    // The last thing analysis does. Everything above produced the UNDERSTANDING
    // (transcript, moments, narrative beats, attention); the Director turns the
    // user's brief into real edits on top of it, choosing its designs from the
    // validated preset library. This is what makes "Direct my video" part of one
    // flow instead of a second pass the user has to remember to run.
    //
    // No brief (or the dialog's toggle turned it off) ⇒ none of this happens and
    // analysis behaves exactly as it always has.
    const directorBrief = project.directorBrief as ProjectDoc["directorBrief"];
    let directorState: DirectorState | undefined;
    let directorCanvas: OutputCanvas | undefined;

    if (shouldRunDirectorStage(directorBrief, analysisOptions.applyDirectorBrief)) {
      await setStage(ref, "analyzing" as ProjectStatus, "Directing your video");
      await emitActivity(ref, "info", "Applying your Director brief");

      // The Director plans against what analysis JUST learned, not what was on
      // disk when the request came in — so it sees this run's transcript, moments
      // and narrative structure rather than the previous run's.
      //
      // `audioAnalysis` MUST be the fresh one. `buildDirectorContext` derives its
      // DEAD ZONES (long pauses + silences) from it, and the planner is told to
      // remove silence ONLY from windows on that list. Passing the doc's stale
      // value — which on a first analysis is absent entirely — would leave the
      // list empty, and "remove the boring parts" would quietly do nothing while
      // reporting success. It only reaches the document in the terminal write
      // below, which happens AFTER this stage.
      const directedProject = {
        ...(materializeProject(projectId, project) as ProjectDoc),
        duration,
        visualAnalysis,
        analysis: {
          ...(project.analysis as ProjectDoc["analysis"]),
          detectedMoments: finalMoments,
          transcript,
          ...(audioAnalysis ? { audioAnalysis } : {}),
          narrativeStructure: sections.narrativeStructure,
          attentionCurve: attention.curveQ8,
          videoType: effectiveVideoType,
        },
        selectedVideoType,
      } as ProjectDoc;

      const effectsForDirector = {
        ...((project.effectsSettings as EffectsSettings | undefined) ?? {}),
        ...(overlayGen.outputCanvas ? { outputCanvas: overlayGen.outputCanvas } : {}),
      } as EffectsSettings;

      const directed = await runDirectorStage({
        project: directedProject,
        brief: directorBrief,
        moments: finalMoments,
        effects: effectsForDirector,
        prior: project.director as DirectorState | undefined,
        planOnly: analysisOptions.directorPlanOnly === true,
      });

      for (const line of directed.log) await emitActivity(ref, line.kind, line.text);

      directorState = directed.state;
      if (directed.applied) {
        finalMoments = directed.moments;
        directorCanvas = directed.outputCanvas;
      }
      // A Director failure does NOT sink the analysis: the understanding is real
      // and the user waited for it. The failed state is persisted so the panel
      // shows why, and the plain analysis timeline is what they keep.
    }

    // The Director's canvas WINS over the recipe's: a brief that says "make it
    // vertical for TikTok" is an explicit instruction, where the recipe's smart
    // crop is an inference. Explicit beats inferred.
    const finalOutputCanvas: OutputCanvas | undefined =
      directorCanvas ?? overlayGen.outputCanvas;

    const cleanMoments = stripUndefined(finalMoments);
    const cleanRawPool = stripUndefined(rawPool);
    // Editorial rejects join the recoverable pool rather than vanishing: the
    // engine's verdict is a judgement call, and `rejectedReason` +
    // `editorialReason` on each one is exactly the record needed to explain —
    // or undo — that call later. Capped like the balancer's own pool so a
    // heavily-pruned run can't bloat the document.
    const cleanRejectedPool = stripUndefined(
      [...balanced.rejectedPool, ...editorialRejects].slice(0, REJECTED_POOL_CAP)
    );

    // Build stage-by-stage click-pipeline diagnostics. Persisted so the
    // editor's Analysis Debug panel can show *exactly* which stage
    // dropped a click. Numbers are gathered from `loadDiag` (capture →
    // load), the local `totalClicks` / `clickMoments` / per-tier tally
    // (momentsFromEvents), and `balanced.stats.eventStats` (balancer).
    const clickPipeline: ClickPipelineDiagnostics = {
      interactionsPath,
      attemptedLoad: loadDiag.attemptedLoad,
      interactionsLoaded: loadDiag.interactionsLoaded,
      scope: effectiveScope,
      loadReason: loadDiag.loadReason,
      coordinatesTrusted,
      trustReason: resolvedScope.trustReason,
      scopeAssigned: resolvedScope.scopeAssigned,
      scopeValidated: resolvedScope.scopeValidated,
      scopeDecisionReason: resolvedScope.validationReason,
      captureDimensions,
      totalInteractions: interactions.length,
      totalClicks,
      eventMomentsEmitted: eventMoments.length,
      clickMomentsEmitted: clickMoments,
      clickMomentsByTier,
      eventCandidatesIn: balanced.stats.eventStats.eventCandidatesIn,
      eventDroppedByOverlap: balanced.stats.eventStats.eventDroppedByOverlap,
      eventDroppedTooClose: balanced.stats.eventStats.eventDroppedTooClose,
      eventDroppedTooManyZooms:
        balanced.stats.eventStats.eventDroppedTooManyZooms,
      eventDroppedTooDense: balanced.stats.eventStats.eventDroppedTooDense,
      eventKept: balanced.stats.eventStats.eventKept,
    };
    console.info("[analyze] clickPipeline", { projectId, ...clickPipeline });

    // Consolidated editing-funnel diagnostics: interactions → important →
    // generated → applied + coverage. Reporting-only; assembled from the
    // locals above (no recomputation, no Gemini). See edit-diagnostics.ts.
    const editDiagnostics = buildEditDiagnostics({
      interactions,
      visualAnalysis,
      clickMomentsByTier,
      rawPool,
      appliedMoments: balanced.moments,
      aiProposed: aiGapMoments.length + aiVisualMoments.length,
      stats: balanced.stats,
      computedAt: Date.now(),
    });
    console.info("[analyze] editDiagnostics", {
      projectId,
      coverageAdjusted: editDiagnostics.coverageAdjusted,
      coverageRaw: editDiagnostics.coverageRaw,
      importantDetected: editDiagnostics.importantDetected,
      timelineApplied: editDiagnostics.timelineApplied,
      suppressedDrops: editDiagnostics.suppressedDrops,
    });

    // Effect-type mix on the final timeline (friendly names). Reached by both
    // the direct and the chunked-finalize paths, so every analyze logs it.
    const effectDist = editDiagnostics.effectDistribution ?? {};
    console.info("[cv-effect-distribution]", {
      projectId,
      zoom: effectDist.zoom ?? 0,
      click: effectDist["click-highlight"] ?? 0,
      focus: effectDist["cursor-focus"] ?? 0,
      cut: effectDist.cut ?? 0,
      crop: effectDist.crop ?? 0,
      speed: effectDist["speed-up"] ?? 0,
    });

    await ref.set(
      {
        status: "analyzed" as ProjectStatus,
        // Persist the resolved user selection (top-level project field) so it
        // survives + stays the source of truth for a re-analysis.
        selectedVideoType,
        // smart_crop applies the vertical/social reframe via the output canvas.
        // Merge-write only the canvas so the user's other effects are untouched;
        // only set when the recipe generated one (user had no canvas of their own).
        ...(finalOutputCanvas ? { effectsSettings: { outputCanvas: finalOutputCanvas } } : {}),
        // The plan behind every `source: "ai-director"` edit in `detectedMoments`
        // above. Written in the SAME terminal write as the timeline it produced,
        // so the two can never be observed out of step.
        ...(directorState ? { director: stripUndefinedDeep(directorState) } : {}),
        analysis: {
          status: "complete",
          stage: "Complete",
          summary: sections.summary,
          detectedMoments: cleanMoments,
          rawMoments: cleanRawPool,
          rejectedPool: cleanRejectedPool,
          boringSections: sections.boringSections,
          recommendedPresetIds: sections.recommendedPresetIds,
          videoType: effectiveVideoType,
          editRecipe: editRecipePlan,
          // Phase 4 — persist the transcript + audio intelligence (stripUndefined
          // so optional fields never write literal `undefined` to Firestore).
          transcript: stripUndefined(transcript),
          ...(audioAnalysis ? { audioAnalysis: stripUndefined(audioAnalysis) } : {}),
          narrativeStructure: sections.narrativeStructure,
          attentionCurve: attention.curveQ8,
          attentionSampleRate: attention.sampleRate,
          clickPipeline: stripUndefined(clickPipeline),
          editDiagnostics: stripUndefined(editDiagnostics),
          completedAt: Date.now(),
          cancelRequested: false,
          // Re-assert the engine selection on the terminal write (the reset
          // value could otherwise be raced); powers the timeline's "Disabled
          // for this analysis" labels.
          lastRunOptions: analysisOptions,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // (Transcription is NOT dispatched here — captions are generated only by
    // the dedicated "Generate AI Captions" action, never by analysis.)

    // User-facing provenance summary — invariant 6 (trust).
    const pc = balanced.stats.provenanceCounts;
    const provenanceBits: string[] = [];
    if (pc.event > 0) provenanceBits.push(`${pc.event} from your clicks`);
    if (pc.cv > 0) provenanceBits.push(`${pc.cv} from motion`);
    if (pc.ai > 0 || pc["ai-override"] > 0) {
      const aiTotal = pc.ai + pc["ai-override"];
      const aiPct = balanced.moments.length > 0 ? (aiTotal / balanced.moments.length) * 100 : 0;
      provenanceBits.push(`${aiTotal} AI suggestion${aiTotal === 1 ? "" : "s"} (${aiPct.toFixed(0)}%)`);
    }
    if (pc.user > 0) provenanceBits.push(`${pc.user} from you`);
    await emitActivity(
      ref,
      "ok",
      `Analysis complete — ${balanced.moments.length} moment${
        balanced.moments.length === 1 ? "" : "s"
      }${provenanceBits.length > 0 ? ` (${provenanceBits.join(", ")})` : ""}`
    );

    void recordEvent(EVENTS.ANALYSIS_COMPLETED, {
      userId: uid,
      userEmail: decoded.email ?? null,
      projectId,
      metadata: { momentCount: balanced.moments.length },
    });

    return NextResponse.json({
      ok: true,
      momentCount: balanced.moments.length,
      summary: sections.summary,
      recommendedPresetIds: sections.recommendedPresetIds,
      provenanceCounts: pc,
    });
  } catch (err) {
    // uid is block-scoped to the try; recover it from the project doc ref.
    const errUid = ref?.parent.parent?.id ?? "";
    if (err instanceof CancelledError || err instanceof GeminiCancelled) {
      console.log("[analyze] cancelled by user");
      if (ref) await markCancelled(ref);
      void recordEvent(EVENTS.ANALYSIS_CANCELLED, { userId: errUid, projectId });
      return NextResponse.json({ ok: false, cancelled: true }, { status: 200 });
    }

    const msg = err instanceof Error ? err.message : "Analysis failed.";
    const kind = classifyError(msg);
    console.error("[analyze] failed", { kind, msg, err });

    if (ref) {
      // Never let the failure-state write throw out of the catch — that would
      // turn a clean JSON error into an unhandled non-JSON 500 (the opaque
      // "Finalize failed" the client then shows). The JSON response below must
      // always run so the real reason reaches the client.
      try {
        await bail(ref, kind, msg);
        await emitActivity(ref, "error", `Failed: ${msg.slice(0, 200)}`);
      } catch (writeErr) {
        console.error("[analyze] failure-state write threw (returning error anyway)", writeErr);
      }
    }
    void recordEvent(EVENTS.ANALYSIS_FAILED, {
      userId: errUid,
      projectId,
      metadata: { kind, message: msg.slice(0, 200) },
    });
    return NextResponse.json({ error: msg, kind }, { status: 500 });
  }
}
