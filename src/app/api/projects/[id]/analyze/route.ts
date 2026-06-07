import { NextResponse, type NextRequest } from "next/server";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import { stripUndefined } from "@/lib/firebase/sanitize";
import {
  classifyVideoSections,
  labelMoments,
  proposeGapFills,
  proposeVisualMoments,
  uploadVideoToGemini,
  waitForGeminiFileActive,
  GeminiCancelled,
  type GeminiVideoRef,
} from "@/lib/gemini";
import {
  classifyError,
  estimateAnalysisSeconds,
} from "@/lib/analysis-stages";
import { balanceTimeline, distributionScore } from "@/lib/timeline-balancer";
import { buildEditDiagnostics } from "@/lib/diagnostics/edit-diagnostics";
import { momentsFromEvents } from "@/lib/attention/events";
import { attentionCurve } from "@/lib/attention/score";
import { cursorIntent } from "@/lib/attention/cursor-intent";
import { classifyClick, type ClickTier } from "@/lib/attention/click-classifier";
import { canUseAiFeature } from "@/lib/usage/ai-features";
import { canUsePreset } from "@/lib/usage/gating";
import type { Interaction } from "@/lib/recording/types";
import {
  resolveScopeAndTrust,
  type CaptureDimensions,
} from "@/lib/recording/scope-detect";
import {
  AI_MOMENT_QUOTA,
  type AnalysisActivityEvent,
  type AnalysisErrorKind,
  type ClickPipelineDiagnostics,
  type DetectedMoment,
  type MomentProvenance,
  type Pacing,
  type ProjectStatus,
  type VisualAnalysis,
} from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const INLINE_BYTE_LIMIT = 18 * 1024 * 1024;

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
 * Finalize crop + speed sections WITHOUT dropping data: merge adjacent same-type
 * AI sections (a boring run / stable region split across chunk boundaries) and
 * let user sections always win. Camera moments are returned untouched.
 */
function mergeCropSpeedSections(moments: DetectedMoment[]): {
  moments: DetectedMoment[];
  merged: Array<{ id: string; reason: string }>;
  cropBefore: number;
  cropAfter: number;
  speedBefore: number;
  speedAfter: number;
} {
  const GAP = 1.0; // seconds — sections within this gap (or overlapping) merge.
  const merged: Array<{ id: string; reason: string }> = [];
  const camera = moments.filter(
    (m) => m.effectType !== "crop" && m.effectType !== "speed-up"
  );
  const crops = dropAiOverlappingUser(
    moments.filter((m) => m.effectType === "crop"),
    merged
  ).sort((a, b) => a.startTime - b.startTime);
  const speeds = dropAiOverlappingUser(
    moments.filter((m) => m.effectType === "speed-up"),
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

  return {
    moments: [...camera, ...mergedCrops, ...mergedSpeeds].sort(
      (a, b) => a.startTime - b.startTime
    ),
    merged,
    cropBefore: crops.length,
    cropAfter: mergedCrops.length,
    speedBefore: speeds.length,
    speedAfter: mergedSpeeds.length,
  };
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id: projectId } = await params;
  let ref: DocumentReference | null = null;

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
    const reqBody = (await req
      .json()
      .catch(() => null)) as { mode?: string; chunkCount?: number; progressiveCount?: number } | null;
    const isFinalize = reqBody?.mode === "finalize";
    const finalizeChunkCount =
      typeof reqBody?.chunkCount === "number" ? reqBody.chunkCount : undefined;
    const progressiveMoments =
      (project.analysis as { detectedMoments?: DetectedMoment[] } | undefined)
        ?.detectedMoments ?? [];
    const dedup = isFinalize
      ? dedupeBoundaryDuplicates(progressiveMoments)
      : { kept: [] as DetectedMoment[], merged: [] as Array<{ id: string; reason: string }> };
    const preservedMoments: DetectedMoment[] = isFinalize ? dedup.kept : [];

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
          // the AI pass runs; a direct run clears them for a fresh timeline.
          ...(isFinalize ? {} : { detectedMoments: [] }),
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

    // 5. Prepare a Gemini video reference. The new refinement-only pipeline
    // calls Gemini up to three times (sections → gap-fill → labels), so we
    // upload once via the Files API for non-inline videos and reuse the URI.
    const useInline = buffer.length <= INLINE_BYTE_LIMIT;
    let geminiVideo: GeminiVideoRef;
    if (useInline) {
      geminiVideo = { kind: "inline", buffer, mimeType };
      await emitActivity(ref, "info", `Using inline video (${sizeMB} MB)`);
    } else {
      await setStage(ref, "uploading_to_gemini", "Uploading to Gemini");
      await emitActivity(ref, "info", "Uploading video to Gemini Files API");
      const uploaded = await uploadVideoToGemini(buffer, mimeType);
      await emitActivity(ref, "ok", `Uploaded — file id ${uploaded.name.split("/").pop()}`);
      await ensureNotCancelled(ref);
      await setStage(ref, "extracting_frames", "Extracting frames");
      await waitForGeminiFileActive(uploaded.name, {
        timeoutMs: 180_000,
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

    // 6. Phase A — Section classification (videoType, narrative, summary,
    // preset recommendations). NO moments proposed here.
    await setStage(ref, "analyzing", "Classifying recording");
    await emitActivity(ref, "info", "Asking Gemini for structure (sections + classification)");
    const sections = await classifyVideoSections({
      video: geminiVideo,
      hintedDuration: duration,
    });
    await emitActivity(
      ref,
      "ok",
      `Classified as ${sections.videoType.replace(/-/g, " ")}${
        sections.narrativeStructure.length > 0
          ? ` · ${sections.narrativeStructure.length} narrative segments`
          : ""
      }`
    );

    await ensureNotCancelled(ref);

    // 7. Phase B — Build the deterministic candidate pool. Real events first,
    // CV candidates as a backstop. Gemini contributes ZERO moments at this
    // stage (invariant 1).
    await setStage(ref, "generating_timeline", "Building zoom timeline");

    const existingPacing = (project.effectsSettings as { pacing?: Pacing } | undefined)?.pacing;
    const pacing: Pacing = existingPacing ?? "moderate";
    const visualAnalysis = project.visualAnalysis as VisualAnalysis | undefined;

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
      videoType: sections.videoType,
      visualAnalysis,
      eventMoments,
      // Finalize: the progressive moments ARE the CV result — don't regenerate
      // CV candidates (that's what pruned 17 → 6–7). Direct runs still do.
      useCvCandidates: !isFinalize,
      boringSections: sections.boringSections,
      interactions,
      preserved: preservedMoments,
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
    } else if (gaps.length > 0 && aiBudget > 0) {
      await emitActivity(
        ref,
        "info",
        `Asking Gemini to fill ${gaps.length} coverage gap${
          gaps.length === 1 ? "" : "s"
        } (budget ${aiBudget})`
      );
      try {
        const proposals = await proposeGapFills({
          video: geminiVideo,
          gaps,
          maxMoments: aiBudget,
          boringSections: sections.boringSections,
        });
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
    if (!isFinalize && eventMoments.length === 0 && allowVisualMoments && dur > 0) {
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
      videoType: sections.videoType,
      visualAnalysis,
      eventMoments,
      // Finalize keeps progressive moments as `preserved`; don't regenerate CV.
      useCvCandidates: !isFinalize,
      boringSections: sections.boringSections,
      interactions,
      preserved: preservedMoments,
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
    } else if (needsLabeling.length > 0) {
      await emitActivity(ref, "info", `Asking Gemini to label ${needsLabeling.length} moment${needsLabeling.length === 1 ? "" : "s"}`);
      try {
        const labels = await labelMoments({ video: geminiVideo, moments: needsLabeling });
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

    const cleanMoments = stripUndefined(finalMoments);
    const cleanRawPool = stripUndefined(rawPool);
    const cleanRejectedPool = stripUndefined(balanced.rejectedPool);

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

    await ref.set(
      {
        status: "analyzed" as ProjectStatus,
        analysis: {
          status: "complete",
          stage: "Complete",
          summary: sections.summary,
          detectedMoments: cleanMoments,
          rawMoments: cleanRawPool,
          rejectedPool: cleanRejectedPool,
          boringSections: sections.boringSections,
          recommendedPresetIds: sections.recommendedPresetIds,
          videoType: sections.videoType,
          narrativeStructure: sections.narrativeStructure,
          attentionCurve: attention.curveQ8,
          attentionSampleRate: attention.sampleRate,
          clickPipeline: stripUndefined(clickPipeline),
          editDiagnostics: stripUndefined(editDiagnostics),
          completedAt: Date.now(),
          cancelRequested: false,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

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

    return NextResponse.json({
      ok: true,
      momentCount: balanced.moments.length,
      summary: sections.summary,
      recommendedPresetIds: sections.recommendedPresetIds,
      provenanceCounts: pc,
    });
  } catch (err) {
    if (err instanceof CancelledError || err instanceof GeminiCancelled) {
      console.log("[analyze] cancelled by user");
      if (ref) await markCancelled(ref);
      return NextResponse.json({ ok: false, cancelled: true }, { status: 200 });
    }

    const msg = err instanceof Error ? err.message : "Analysis failed.";
    const kind = classifyError(msg);
    console.error("[analyze] failed", { kind, msg, err });

    if (ref) {
      await bail(ref, kind, msg);
      await emitActivity(ref, "error", `Failed: ${msg.slice(0, 200)}`);
    }
    return NextResponse.json({ error: msg, kind }, { status: 500 });
  }
}
