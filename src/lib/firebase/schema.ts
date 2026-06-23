// Shared types for Firestore documents — used on both client and server.

import type { CaptureDimensions } from "@/lib/recording/scope-detect";
import type { SourceCrop } from "@/lib/recording/types";

export type { SourceCrop };

export type ProjectStatus =
  | "uploading"
  | "uploaded"
  | "scanning_frames"
  | "preparing"
  | "uploading_to_gemini"
  | "extracting_frames"
  | "analyzing"
  | "generating_timeline"
  | "generating_presets"
  | "analyzed" // legacy alias for "completed"
  | "completed"
  | "exporting"
  | "exported"
  | "cancelled"
  | "failed";

export type AnalysisStatus =
  | "idle"
  | "queued"
  | "analyzing"
  | "complete"
  | "cancelled"
  | "failed";

export type AnalysisErrorKind =
  | "gemini_timeout"
  | "gemini_quota"
  | "gemini_unsupported"
  | "gemini_invalid_argument"
  | "upload_failed"
  | "video_too_large"
  | "network_interruption"
  | "unknown";

export interface AnalysisActivityEvent {
  ts: number;
  kind: "info" | "ok" | "warn" | "error";
  text: string;
}

export type EffectType =
  | "zoom"
  | "click-highlight"
  | "cursor-focus"
  | "speed-up"
  | "cut"
  | "crop";

// ── Manual Crop/Reframe + Speed settings (additive) ─────────────────────────
// Crop/Reframe and Speed are manual timeline effects. They extend
// `DetectedMoment` without a parallel type so existing projects decode
// unchanged. The crop BOX reuses the moment's `focusRegion`; `crop` holds the
// extra framing controls. Speed reuses the existing `"speed-up"` effectType.
export type CropAspect = "original" | "16:9" | "9:16" | "1:1" | "4:5" | "custom";
export type CropPosition =
  | "center"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "custom";
export type SpeedAudioMode = "mute" | "keep" | "pitch-correct";
/** "ramp" is a placeholder — treated as a hard cut until smooth ramps ship. */
export type SpeedTransition = "cut" | "ramp";

export interface CropSettings {
  /** Target output aspect the box is shaped to (UI helper; box lives in focusRegion). */
  aspectRatio: CropAspect;
  /** Extra zoom into the crop box (1 = fit the box to the output). */
  scale: number;
  /** Preset placement of the box; "custom" once the user drags it. */
  position: CropPosition;
  /** "instant" holds the framing for the whole section; otherwise the camera eases. */
  easing: EaseKind | "instant";
}

export interface SpeedSettings {
  /** Playback multiplier during the section (e.g. 2 = 2× → half the output time). */
  multiplier: number;
  audioMode: SpeedAudioMode;
  transition: SpeedTransition;
}

/**
 * A Cut is a removed time range (effectType "cut"). Detected by the cut engine
 * (dead / idle / loading / long-pause sections) or added by the user. `active`
 * false = "restored" — the range is kept in the output and the cut stays on the
 * timeline (dimmed) so it can be re-applied. NOTE: this iteration is
 * timeline-only — cuts are reviewable but do NOT yet remove time from
 * preview/export (that's a follow-up).
 */
export interface CutSettings {
  /** True = the range is cut (removed). False = restored (kept). */
  active: boolean;
}

export type UIContext =
  | "button"
  | "modal"
  | "dialog"
  | "form"
  | "code"
  | "navigation"
  | "scroll"
  | "result"
  | "media"
  | "text"
  | "menu"
  | "other";

export type NarrativeRole =
  | "intro"
  | "setup"
  | "action"
  | "explanation"
  | "result"
  | "transition"
  | "filler";

export type VideoType =
  | "coding-tutorial"
  | "saas-demo"
  | "talking-tutorial"
  | "presentation"
  | "vertical-short"
  | "onboarding-flow"
  | "mixed";

export interface AttentionFactors {
  /** How much the visible frame changed (0..1). Modal opening = high, hover = low. */
  changeMagnitude: number;
  /** Cursor / UI motion intensity in the moment window (0..1). */
  motionIntensity: number;
  /** How important this beat is to the recording's story (0..1). */
  semanticWeight: number;
  /** Probability a viewer would miss this without emphasis (0..1). */
  viewerConfusionRisk: number;
}

export interface FocusRegion {
  x: number; // 0..1
  y: number; // 0..1
  width: number; // 0..1
  height: number; // 0..1
}

/** Where a timeline edit came from — drives UI affordances + the AI/human split. */
export type MomentSource = "ai" | "user";

/**
 * Detailed origin of a moment in the hybrid pipeline. Distinct from
 * `MomentSource`: `source` answers "did the user make this", while
 * `provenance` answers "which signal produced it".
 *
 * Priority order baked into selection: EVENT > CV > AI. `ai-override` exists
 * only when an AI proposal won over a low-confidence event candidate — it
 * stays visibly labelled in the UI so the user can revert.
 */
export type MomentProvenance =
  | "event"
  | "cv"
  | "ai"
  | "ai-override"
  | "user";

/** Selection-time rank used by the balancer. EVENT > CV > AI. */
export const PROVENANCE_RANK: Record<MomentProvenance, number> = {
  user: 4,
  event: 3,
  cv: 2,
  "ai-override": 1,
  ai: 1,
};

/** Maximum share of `detectedMoments` that may have `provenance: "ai"`. */
export const AI_MOMENT_QUOTA = 0.15;

/**
 * Identifies which underlying signal produced a moment's confidence score.
 * Surfaced in the inspector + debug overlay so every moment is explainable.
 */
export type ConfidenceSource =
  | "real-click"
  | "real-double-click"
  | "real-right-click"
  | "real-typing-burst"
  | "real-scroll-pause"
  | "real-hover-settle"
  | "cursor-intent-hesitation"
  | "cursor-intent-settle"
  | "cv-motion-peak"
  | "cv-scene-change"
  | "cv-click-heuristic"
  | "cv-no-target-fallback"
  | "ai-section-anchor"
  | "ai-gap-fill"
  | "ai-rescue-rebalance"
  | "user-manual";

/**
 * Where the `focusRegion` of a moment came from. Used so the inspector /
 * debug overlay can show whether the camera target is grounded in a real
 * signal (click coords, motion centroid, UI region) or is a generic default
 * the balancer should treat as low-confidence.
 */
export type TargetRegionSource =
  | "click-event"
  | "motion-centroid"
  | "ui-region"
  | "ai-proposal"
  | "default"
  | "user"
  /** CV: a cursor-dwell + post-action UI change grounded this region (tight bbox). */
  | "cv-inferred-click";

/**
 * Compact record of a candidate that was rejected near a surviving moment.
 * Kept short so it doesn't blow up Firestore doc size — capped at 5 per
 * surviving moment and 50 in `analysis.rejectedPool`.
 */
export interface RejectedCandidateRef {
  ts: number;
  reason: string;
  provenance: MomentProvenance;
  effectType?: EffectType;
}

export type EaseKind = "linear" | "ease-in" | "ease-out" | "ease-in-out";

/**
 * A single keyframe inside a moment. Minimal by design — position + zoom +
 * easing — but extensible (add fields without breaking older docs).
 *
 * When a moment has ≥1 keyframe, the camera animates *through* them across the
 * moment's window. With 0 keyframes the moment uses its static `focusRegion`.
 */
export interface MomentKeyframe {
  /** Position within the moment, 0..1 (0 = startTime, 1 = endTime). */
  t: number;
  /** Camera focus centre X in frame coords (0..1). */
  x: number;
  /** Camera focus centre Y in frame coords (0..1). */
  y: number;
  /** Zoom intensity at this keyframe (0..1). */
  scale: number;
  /** Easing used when interpolating *into* this keyframe from the previous one. */
  ease?: EaseKind;
}

export interface DetectedMoment {
  id: string;
  startTime: number;
  endTime: number;
  label: string;
  reason: string;
  focusRegion: FocusRegion;
  effectType: EffectType;
  /** User-tuned override of intensity (0..1). Falls back to project effectsSettings. */
  intensity?: number;
  /** True if the user added/edited this moment (vs raw AI output). */
  edited?: boolean;
  /**
   * Origin of this edit. "ai" = from analysis, "user" = manually inserted.
   * Defaults to "ai" when absent (older docs). `edited` still tracks whether
   * an AI moment was subsequently tweaked.
   */
  source?: MomentSource;
  /**
   * Optional keyframes. When present (≥1), the camera animates through them
   * across the moment window instead of holding a static focusRegion.
   */
  keyframes?: MomentKeyframe[];

  /**
   * Manual Crop/Reframe settings — present when `effectType === "crop"`. The
   * crop BOX is the moment's `focusRegion`; this holds aspect/scale/position/
   * easing. The camera frames the box into the output (baked into export).
   */
  crop?: CropSettings;
  /**
   * Manual Speed settings — present when `effectType === "speed-up"`. Drives
   * `playbackRate` in preview + real-time export (shortening output duration).
   */
  speed?: SpeedSettings;
  /**
   * Cut settings — present when `effectType === "cut"`. The removed range is
   * the moment's `[startTime, endTime]`; `cut.active` toggles applied/restored.
   */
  cut?: CutSettings;

  // ── Attention-aware fields (Gemini-supplied, post-processed by balancer) ──
  /** Composite priority (0..1) — replaces importance going forward. */
  attentionScore?: number;
  /** Sub-factors that fed into attentionScore. */
  attentionFactors?: AttentionFactors;
  /** What kind of UI element is involved. */
  uiContext?: UIContext;
  /** True if this moment is a scene transition (page change, modal open, tab switch). */
  sceneChange?: boolean;
  /** Where this moment sits in the recording's story. */
  narrativeRole?: NarrativeRole;
  /** Gemini's per-moment intensity recommendation (0..1). Used by the editor + export. */
  recommendedIntensity?: number;

  // ── Hybrid pipeline provenance + confidence (V2) ──
  /**
   * Which signal produced this moment. EVENT > CV > AI > USER in selection
   * priority. Absent on projects analyzed before the hybrid engine shipped —
   * readers should fall back to `source` and treat as "ai".
   */
  provenance?: MomentProvenance;
  /** Back-pointer to raw `Interaction.id`(s) that fed this moment. */
  eventIds?: string[];
  /** Composite confidence in this moment (0..1). Events ~0.9+, CV ~0.5-0.8, AI ~0.3-0.6. */
  confidenceScore?: number;
  /** Dominant signal class behind `confidenceScore`. */
  confidenceSource?: ConfidenceSource;
  /** One-line, user-facing explanation of why this moment exists. */
  confidenceReason?: string;

  /**
   * Legacy field. New code reads `attentionScore`; falls back here for old projects.
   * @deprecated use attentionScore
   */
  importance?: number;

  // ── Explainability (V3) — populated by the balancer / events.ts / Gemini ──
  /** One-line explanation of why the balancer kept this moment. */
  whySelected?: string;
  /** One-line explanation of why this `effectType` was chosen. */
  whyEffectType?: string;
  /** Where the `focusRegion` value originated. */
  targetRegionSource?: TargetRegionSource;
  /**
   * Short tags of the signals that fed this moment, in fired-order.
   * Examples: ["click@12.42", "hover-settle@12.18", "cursor-hesitation@0.72"].
   */
  sourceSignals?: string[];
  /**
   * Set by the balancer when this candidate was dropped from the active
   * timeline. The candidate is still kept in `rawMoments` so a preset change
   * (e.g. denser pacing) can un-reject it without re-calling Gemini.
   */
  rejected?: boolean;
  /** Short tag explaining the rejection (e.g. `"boring-section"`, `"in-idle"`, `"no-target"`). */
  rejectedReason?: string;
  /** Candidates that competed with this moment in the same time neighbourhood and lost. */
  rejectedCandidates?: RejectedCandidateRef[];
}

/**
 * Coarse UI region detected by the lightweight CV layer. Shape + motion stats,
 * NOT semantic — `labelGuess` is a hint to the AI refinement layer, never an
 * authoritative class. Confidence is clamped ≤ 0.7 unless a click landed
 * inside the region.
 */
export interface UIRegion {
  id: string;
  /** Time window this region was active in (seconds). */
  t0: number;
  t1: number;
  /** Normalized rect in frame coords (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Coarse shape guess — NOT semantic vision. */
  labelGuess:
    | "button"
    | "card"
    | "modal"
    | "input"
    | "sidebar"
    | "toolbar"
    | "menu"
    | "dialog"
    | "unknown";
  /** 0..1 — clamped ≤ 0.7 without click corroboration. */
  confidence: number;
}

export interface NarrativeSegment {
  startTime: number;
  endTime: number;
  role: NarrativeRole;
  label: string;
}

// NOTE (V1): caption generation was removed to refocus Framevo on attention /
// zoom direction. If/when captions return as an optional plugin they should
// live in their own subcollection (e.g. `projects/{id}/captions/{id}`) rather
// than being inlined into `Analysis`, so the core pipeline stays minimal.

export interface BoringSection {
  startTime: number;
  endTime: number;
  reason: string;
}

/** What an AI suggestion proposes — drives the icon + accept behaviour. */
export type SuggestionKind =
  | "add-emphasis" // a busy stretch with no zoom moment
  | "add-focus" // an interaction the camera doesn't follow
  | "pacing-gap" // a long dead stretch between moments
  | "too-aggressive" // an edit that may feel heavy-handed
  | "tighten" // a moment that runs longer than its action
  // ── Future manual-effect suggestions (declared only; never generated or
  //    auto-applied yet — the user always adds crop/speed manually). ──
  | "suggest-speed-up"
  | "suggest-crop"
  | "suggest-reframe"
  | "suggest-remove-idle";

/**
 * A non-destructive AI recommendation. The AI proposes; the user accepts or
 * dismisses. Derived from the analysis + CV signals — never auto-applied.
 *
 * `id` is deterministic so a dismissal persists across reloads.
 */
export interface AiSuggestion {
  id: string;
  kind: SuggestionKind;
  /** Short headline, e.g. "This section may need emphasis". */
  title: string;
  /** One-sentence rationale. */
  detail: string;
  /** Timeline position the suggestion points at (seconds). */
  atTime: number;
  /** Moment this refers to, when it's a tweak rather than an insertion. */
  momentId?: string;
  /** For insert-kind suggestions — the moment to add when accepted. */
  insert?: DetectedMoment;
  /** For tweak-kind suggestions — the patch to apply to `momentId` when accepted. */
  patch?: Partial<DetectedMoment>;
}

/** A sparse, timestamped CV event (scene change or inferred click). */
export interface VisualEvent {
  /** Seconds into the video. */
  t: number;
  /** Confidence / magnitude of the event (0..1). */
  strength: number;
}

/**
 * A CV-inferred click (v3): a cursor dwell followed by a localized UI change.
 * Carries the tight changed-region rect (0..1 normalized) so the moment
 * generator can frame a precise zoom instead of a generic box.
 */
export interface InferredClick {
  /** Seconds into the video (the moment of the UI change). */
  t: number;
  /** Confidence 0..1 (cursor-dwell quality × UI-change magnitude). */
  strength: number;
  /** Changed-region rect, normalized 0..1 — the zoom focus target. */
  region: { x: number; y: number; w: number; h: number };
}

/**
 * A detected cursor dwell (v3) — where the cursor settled. Persisted (capped)
 * for dev tuning visibility only; not consumed by the editing pipeline.
 */
export interface VisualDwell {
  t: number;
  x: number;
  y: number;
}

/**
 * Compact, downsampled output of the client-side computer-vision pass.
 *
 * Produced in the browser by `src/lib/cv/pipeline.ts` from the actual decoded
 * video frames, then fused with Gemini's semantic output in the balancer.
 *
 * All per-second arrays are **8-bit quantized** (0..255) to keep the Firestore
 * doc small — divide by 255 to get a 0..1 value (see `dequantize` in
 * `src/lib/cv/resample.ts`). At 1 Hz a 3-min video is ~12 KB.
 *
 * Honest naming: `centroidX/Y` is a *motion-activity hotspot*, NOT a real
 * cursor — it tracks where inter-frame change concentrates.
 */
export interface VisualAnalysis {
  /**
   * v1 = CV-only, ad-hoc attentionCurve. v2 = hybrid-ready (curve from
   * src/lib/attention/score.ts). v3 = visual editing engine: adds a cursor
   * track + UI-change-grounded inferred clicks + populated uiRegions.
   */
  version: 1 | 2 | 3;
  /** Samples per second of the per-second arrays. v1 = 1 (0.5 for very long videos). */
  sampleRate: number;
  /** Length of the per-second arrays. */
  sampleCount: number;
  /** Per-second motion intensity (fraction of pixels changing), 8-bit. */
  motion: number[];
  /** Per-second mean frame-to-frame change magnitude, 8-bit. */
  delta: number[];
  /** Per-second visual density (edge energy — busy IDE vs empty slide), 8-bit. */
  density: number[];
  /** Per-second motion-hotspot X (0..1 → 0..255). */
  centroidX: number[];
  /** Per-second motion-hotspot Y (0..1 → 0..255). */
  centroidY: number[];
  /** Detected scene cuts (page switches, modal opens, hard transitions). */
  sceneChanges: VisualEvent[];
  /** Inferred click-like interactions (motion spike followed by a pause). */
  clickEvents: VisualEvent[];
  /** Per-second smoothed, normalized fused attention curve, 8-bit. */
  attentionCurve: number[];
  /**
   * Visual editing engine (v3). Per-second visual cursor estimate from
   * localized-motion blob tracking — `cursorX/Y` are 8-bit (0..255 → 0..1)
   * like `centroidX/Y`; `cursorConf` is the 8-bit confidence the estimate is a
   * real cursor (low → fell back to the motion hotspot). Optional/back-compat.
   */
  cursorX?: number[];
  cursorY?: number[];
  cursorConf?: number[];
  /**
   * Visual editing engine (v3). Click-like moments grounded by a cursor dwell
   * followed by a localized UI change — distinct from `clickEvents` (raw
   * motion-spike heuristic). Each carries the changed-region center as `{x,y}`
   * so the moment generator can frame a tight zoom. Capped for doc size.
   */
  inferredClicks?: InferredClick[];
  /** Cursor dwells (v3) — dev-tuning visibility only, capped. */
  dwells?: VisualDwell[];
  /** Wall-clock the CV pass took, ms — surfaced for the honest report. */
  computeMs: number;
  /**
   * Detected UI regions (V2). Optional — absent on projects analyzed before
   * region detection shipped. Shape + motion stats, not semantic.
   */
  uiRegions?: UIRegion[];
}

export interface Analysis {
  status: AnalysisStatus;
  stage?: string;
  summary?: string;
  detectedMoments: DetectedMoment[];
  /**
   * Unfiltered moments Gemini returned, before the balancer pruned clusters.
   * Kept so we can re-balance on preset change without re-calling Gemini.
   */
  rawMoments?: DetectedMoment[];
  boringSections: BoringSection[];
  /** Preset ids Gemini thinks fit this recording best (built-in or user). */
  recommendedPresetIds?: string[];
  /** AI-classified video type — drives default pacing / effect biasing. */
  videoType?: VideoType;
  /** AI-segmented narrative structure (intro / action / result / etc). */
  narrativeStructure?: NarrativeSegment[];
  /**
   * Suggestion-ids the user has dismissed. The suggestions themselves are
   * derived on the client with deterministic ids, so only dismissals persist.
   */
  dismissedSuggestionIds?: string[];
  errorMessage?: string;
  errorKind?: AnalysisErrorKind;
  /** Live activity feed (appended to as the server makes progress). */
  activity?: AnalysisActivityEvent[];
  /** Best-effort time estimate when analysis started, in seconds. */
  estimateSeconds?: number;
  /** Wall clock when analysis began. */
  startedAt?: number;
  completedAt?: number;
  /** Set by the client when the user clicks Cancel. */
  cancelRequested?: boolean;
  /**
   * Snapshot of the engine selection used for the most recent (re)analysis, so
   * the timeline can show "Disabled for this analysis" on a layer the user
   * turned off. Structurally identical to `AnalysisOptions` in
   * `src/lib/analysis/engine-layers.ts` (kept inline so this schema stays
   * import-free).
   */
  lastRunOptions?: {
    generateCameraEdits: boolean;
    generateCut: boolean;
    generateSpeed: boolean;
    existingEditMode: "keep" | "replace-selected" | "clear-all";
    chunkMode?: "fast" | "balanced" | "detailed" | "very-detailed" | "custom";
    chunkSizeSeconds?: number;
    chunkCount?: number;
  };

  // ── Hybrid pipeline (V2) ──
  /**
   * Per-bucket attention score (0..255, 8-bit quantized — divide by 255).
   * Canonical importance signal across the product. Produced by
   * `src/lib/attention/score.ts`; consumed via `getAttentionAt(t)`.
   */
  attentionCurve?: number[];
  /**
   * Samples per second for `attentionCurve`. Defaults to `visualAnalysis.sampleRate`
   * when both are present.
   */
  attentionSampleRate?: number;
  /**
   * Flat mirror of candidates rejected by the balancer's reject pass, capped
   * at 50. Surface for the debug overlay so the user can see what was
   * filtered out and why. The full list lives in `rawMoments` with
   * `rejected: true` so rebalance can re-introduce them under denser presets.
   */
  rejectedPool?: DetectedMoment[];
  /**
   * Stage-by-stage diagnostics for the click → zoom pipeline. Populated
   * by the analyze route on every run so the editor's Analysis Debug
   * panel can show exactly where a user's clicks were lost between
   * `interactions.json` and the final timeline.
   *
   * Layout: capture → load → momentsFromEvents → balancer (overlap +
   * greedy) → final. Each stage records its in/out counts so a missing
   * click is locatable to a specific stage.
   */
  clickPipeline?: ClickPipelineDiagnostics;
  /**
   * Consolidated editing-funnel diagnostics. Answers "out of N meaningful
   * interactions, how many did we actually edit?" by joining the interaction
   * counts, the candidate pool, and the final timeline into one record.
   * Reporting-only — NEVER read by the editing/balancing code. Built by
   * `buildEditDiagnostics` in `src/lib/diagnostics/edit-diagnostics.ts`.
   */
  editDiagnostics?: EditDiagnostics;
}

// ── Progressive chunked analysis ────────────────────────────────────────────
// Long videos (> CHUNKED_ANALYSIS_THRESHOLD_S) are analyzed progressively: the
// video is split into fixed-size chunks, each analyzed independently on the
// client (CV + interaction events), with its moments appended to the timeline
// the instant it finishes. Job + chunk state lives at
//   users/{uid}/analysisJobs/{jobId}
//   users/{uid}/analysisJobs/{jobId}/chunks/{chunkId}
// so a refresh resumes without losing progress. The whole-video AI pass runs
// once at the end via the existing analyze route.

export type AnalysisJobStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

/** Which CV engine processed the job — informational + diagnostics. */
export type CvEngineKind = "webcodecs" | "hidden-video";

export interface AnalysisJob {
  id: string;
  projectId: string;
  projectTitle: string;
  status: AnalysisJobStatus;
  engine: CvEngineKind;
  /** Whole-video duration in seconds. */
  duration: number;
  /** Target chunk length in seconds (the resolved analysis-detail size). */
  chunkSize: number;
  /** Analysis-detail preset that produced `chunkSize` — drives the processing
   *  UI label (e.g. "custom 10s chunks"). Inline union to keep schema.ts
   *  import-free; matches `ChunkMode` in lib/analysis/chunk-config.ts. */
  chunkMode?: "fast" | "balanced" | "detailed" | "very-detailed" | "custom";
  chunkCount: number;
  // Denormalized chunk counters so the Jobs page renders without a sub-read.
  queuedCount: number;
  processingCount: number;
  completedCount: number;
  failedCount: number;
  /** 0..1 — completedCount / chunkCount. */
  progress: number;
  /** Moments appended across completed chunks so far (pre-final-merge). */
  momentsSoFar: number;
  /** Rolling estimate of remaining wall-clock, ms. */
  estimateRemainingMs?: number;
  /** Set when the user cancels — the orchestrator polls this between chunks. */
  cancelRequested?: boolean;
  errorMessage?: string;
  startedAt: number;
  completedAt?: number;
  updatedAt: number;
}

export type AnalysisChunkStatus =
  | "queued"
  | "cv-running"
  | "completed"
  | "failed";

export interface AnalysisChunk {
  id: string;
  index: number;
  /** Absolute seconds. */
  startTime: number;
  endTime: number;
  status: AnalysisChunkStatus;
  /** 0..1 within this chunk's CV pass. */
  progress: number;
  /** Deterministic (CV + event) moments this chunk produced — absolute time. */
  moments: DetectedMoment[];
  /**
   * Window-local CV result. Persisted (≈1KB at 1Hz) so a mid-job refresh can
   * run the final merge without re-decoding completed chunks.
   */
  va?: VisualAnalysis;
  attempts: number;
  errorMessage?: string;
  updatedAt: number;
}

export interface ClickPipelineDiagnostics {
  /** Storage path the route attempted to load (`users/<uid>/projects/<id>/interactions.json`). */
  interactionsPath?: string;
  /** Did the route try to load? False if the project has no `interactionsPath` or scope is external. */
  attemptedLoad: boolean;
  /** Did the JSON parse + decode succeed? */
  interactionsLoaded: boolean;
  /** Recording capture scope ("tab" enables real click targets; "external" forces heuristic). */
  scope?: "tab" | "external";
  /** Why the load was skipped or failed (e.g. "scope=external", "no interactionsPath", "404"). */
  loadReason?: string;
  /**
   * Whether the loaded coordinates are trusted to map onto the recorded frame.
   * Loading is now independent of trust: an external recording loads (so its
   * clicks are counted) but its coordinates are NOT used for camera zooms.
   */
  coordinatesTrusted?: boolean;
  /** One-line justification for the trust decision (e.g. "self-tab capture …"). */
  trustReason?: string;
  /** Scope as originally assigned at capture time. */
  scopeAssigned?: "tab" | "external";
  /** Scope after the analyzer's validation (equal to assigned unless overridden). */
  scopeValidated?: "tab" | "external";
  /** How the validated scope was derived (e.g. which dims check fired, or why external). */
  scopeDecisionReason?: string;
  /** Capture geometry the scope decision was based on (absent on uploads / legacy takes). */
  captureDimensions?: CaptureDimensions;
  /** Total interaction events parsed (clicks + hovers + idles + …). */
  totalInteractions: number;
  /** click + dblclick + rightclick events. */
  totalClicks: number;
  /** Moments emitted by `momentsFromEvents` (covers clicks, typing, scroll-pauses, …). */
  eventMomentsEmitted: number;
  /** Subset of `eventMomentsEmitted` derived from click / dblclick / rightclick. */
  clickMomentsEmitted: number;
  /** Per-tier histogram of how click-classifier sized each click moment. */
  clickMomentsByTier: {
    "primary-cta": number;
    icon: number;
    nav: number;
    form: number;
    background: number;
  };
  /** Balancer entrance count for events (after reject pass — events skip it, so == eventMomentsEmitted). */
  eventCandidatesIn: number;
  /** Events collapsed by `resolveOverlaps` (event-vs-event same-target). */
  eventDroppedByOverlap: number;
  /** Events dropped by greedy `EVENT_MIN_SPACING` (0.8s). */
  eventDroppedTooClose: number;
  /** Events dropped by zoomCooldown (should be 0 — regression alarm). */
  eventDroppedTooManyZooms: number;
  /** Events dropped by quartile cap or target-count cap. */
  eventDroppedTooDense: number;
  /** Event moments present in the final timeline. */
  eventKept: number;
}

/** Why a candidate moment never made it onto the final timeline. */
export type EditDropClass =
  /** Correct-by-design drop (collapse/de-dupe/quota). Not a coverage failure. */
  | "intentional"
  /** A genuinely lost edit (boring/idle/no-target/empty-quartile). */
  | "suppressed";

/** Which stage of the funnel is the dominant bottleneck for a recording. */
export type EditBottleneck =
  | "understanding" // interactions captured but few classified important
  | "planning" // important moments but few edit instructions generated
  | "execution" // edits generated but few applied to the timeline
  | "coverage" // edits applied but spread thin despite available candidates
  | "user-expectation" // pipeline healthy; mismatch is the user's mental model
  | "healthy"; // no clear bottleneck

/** One row of the diagnostics drill-down table (a single candidate moment). */
export interface EditDiagnosticRow {
  id: string;
  /** Seconds into the video (moment.startTime). */
  ts: number;
  /** Human label for what was detected (moment.label or effect/provenance). */
  detectedEvent: string;
  provenance?: MomentProvenance;
  /** 0..1 importance — attentionScore ?? confidenceScore ?? 0. */
  importanceScore: number;
  /** Was an AI edit instruction generated for this moment? */
  aiGenerated: boolean;
  /** Did this moment land on the final timeline? */
  timelineApplied: boolean;
  /** Why it was dropped (from `rejectedReason`), if it was. */
  rejectedReason?: string;
  /** Bucket for the drop — only present when not applied. */
  dropClass?: EditDropClass;
}

/**
 * Consolidated editing-funnel diagnostics for one analyzed recording.
 * Reporting-only; assembled from already-computed analyze locals. See
 * `buildEditDiagnostics` in `src/lib/diagnostics/edit-diagnostics.ts`.
 */
export interface EditDiagnostics {
  schemaVersion: 1;
  /** Wall-clock when these diagnostics were computed (staleness marker). */
  computedAt: number;

  // ── Raw interaction funnel (from interactions.json, in-scope events) ──
  /** Per-type interaction tally (click, scroll, hover, …). String-keyed. */
  interactionCounts: Record<string, number>;
  totalInteractions: number;
  totalClicks: number;
  totalScroll: number;
  totalScrollPause: number;
  totalHover: number;
  /** Navigation headline — CV scene changes (page switches / modal opens). */
  navScene: number;
  /** Navigation sub-line — clicks the classifier tagged as "nav" tier. */
  navClick: number;

  // ── Visual editing engine (v3) ──
  /** Did the CV cursor tracker find a confident cursor anywhere in the take? */
  cursorTrackFound?: boolean;
  /** Number of UI-change-grounded inferred clicks the visual engine produced. */
  inferredClickCount?: number;
  /** CV candidate moments the visual engine added to the pool. */
  cvMomentsEmitted?: number;

  // ── Detection → generation → application funnel ──
  /** Candidates deemed important (coverage denominator). See `important()`. */
  importantDetected: number;
  /** All candidates that entered the balancer (== stats.inputCount). */
  candidatesProposed: number;
  /** AI gap-fill moments proposed by Gemini (== aiGapMoments.length). */
  aiProposed: number;
  /** Moments on the final timeline (== detectedMoments.length). */
  timelineApplied: number;

  // ── Drop accounting (reused from balancer stats) ──
  /** Correct-by-design drops (collapse/de-dupe/quota). */
  intentionalDrops: number;
  /** Genuinely lost edits (boring/idle/no-target). */
  suppressedDrops: number;
  /** Quartiles left empty after rejection (a coverage gap). */
  quartileLeftEmpty: number;
  dropBreakdown: {
    eventOverlapsResolved: number;
    droppedTooClose: number;
    quotaDropped: number;
    aiRejectedBoring: number;
    aiRejectedIdle: number;
    aiRejectedNoTarget: number;
  };

  // ── Coverage ──
  /** Literal `applied / important` (user's formula; can look low when healthy). */
  coverageRaw: number;
  /** `applied / (important − intentionalDrops)` — the honest headline. */
  coverageAdjusted: number;

  /**
   * Effect-type mix on the final timeline — counts keyed by `EffectType`
   * (absent key = 0). Surfaces how diverse the generated edits are
   * (zoom vs click-highlight vs cursor-focus vs crop vs speed-up).
   */
  effectDistribution?: Partial<Record<EffectType, number>>;

  /** Drill-down rows (capped ~200), sorted by ts. */
  rows: EditDiagnosticRow[];
}

export type Pacing = "slow" | "moderate" | "fast";
export type TargetPlatform = "youtube" | "tiktok" | "reels" | "twitter" | "internal";
// "Source" preserves the captured viewport's aspect ratio exactly — no
// crop, no letterbox. It is the safe default so an export never silently
// drops content at the edges. "TikTok 9:16" and "YouTube 16:9" are
// explicit CROP presets: they force a fixed container aspect and
// center-crop the source (via object-fit: cover) to fill it. See
// `resolveOutputDims` for the single source of truth on output sizing.
export type ExportFormat =
  | "Source"
  | "1080p"
  | "4K"
  | "TikTok 9:16"
  | "YouTube 16:9"
  | "Custom";

// ── Global output canvas (Canvas Fit / Resize) ───────────────────────────────
// Decides how the WHOLE source video sits inside the chosen export aspect
// ratio. This is the OUTER layer: the canvas layout is applied first, then the
// per-moment camera (AI zoom / crop / speed) composes inside it. Distinct from
// the per-moment `CropSettings` (a timeline effect). See `canvas-layout.ts` for
// the placement math and `resolveOutputCanvas` for back-compat resolution.

/** Output aspect ratio. "custom" uses the explicit width/height. */
export type AspectRatioId = "16:9" | "9:16" | "1:1" | "4:5" | "custom";

/**
 * How the source fills the output canvas:
 *  - "fit"       → contain the whole video (letterbox; background fills the gap)
 *  - "fill"      → cover the canvas (crop the overflowing edges) — today's default
 *  - "smart-fit" → cover + auto-pan to keep the important content in frame
 *  - "manual"    → user-positioned (drag) + scaled video over the background
 */
export type FitMode = "fit" | "fill" | "smart-fit" | "manual";

/** Background shown behind the video when "fit"/"manual" leaves empty space. */
export type BackgroundMode = "blur" | "solid" | "dark" | "light";

export interface OutputCanvas {
  aspectRatio: AspectRatioId;
  /** Output pixel size — derived for presets, user-set for "custom". */
  width: number;
  height: number;
  fitMode: FitMode;
  /** MANUAL only — extra layout zoom on top of the fit (1 = base fit). */
  scale: number;
  /** MANUAL only — drag offset, CANVAS-NORMALIZED (0 = centred, ±1 = clamp). */
  offsetX: number;
  offsetY: number;
  backgroundMode: BackgroundMode;
  /** Only meaningful when `backgroundMode === "solid"`. */
  backgroundColor?: string;
}

export interface EffectsSettings {
  autoZoom: number;
  cursorSize: number;
  cursorSmoothing: number;
  zoomSpeed: number;
  motionSensitivity: number;
  clickHighlightSize: number;
  clickHighlightStyle: "ring" | "pulse" | "burst";
  verticalExport: boolean;
  clickHighlights: boolean;
  motionTracking: boolean;
  /**
   * Cinematic vignette — a soft radial darkening at the frame edges,
   * baked into the exported video when enabled. Preview honors this too
   * so what you see is what you get. Optional + defaults to `false`
   * (no migration needed for older docs — they decode as undefined and
   * the consumer treats that as off).
   */
  vignette?: boolean;
  /**
   * Global output-canvas layout (Canvas Fit / Resize). Optional + absent on
   * older docs — `resolveOutputCanvas` in `canvas-layout.ts` is the single
   * source of truth that maps absent/legacy (`verticalExport`,
   * `defaultExportFormat`) state onto a concrete canvas (or `null` for the
   * full-frame "Source" path). Not added to DEFAULT_EFFECTS_SETTINGS for the
   * same reason: the resolver owns the default so there's one code path.
   */
  outputCanvas?: OutputCanvas;
  // ── preset-driven ──
  pacing: Pacing;
  targetPlatform: TargetPlatform;
  defaultExportFormat: ExportFormat;
}

export const DEFAULT_EFFECTS_SETTINGS: EffectsSettings = {
  autoZoom: 72,
  cursorSize: 50,
  cursorSmoothing: 65,
  zoomSpeed: 55,
  motionSensitivity: 70,
  clickHighlightSize: 60,
  clickHighlightStyle: "ring",
  verticalExport: false,
  clickHighlights: true,
  motionTracking: true,
  pacing: "moderate",
  targetPlatform: "youtube",
  defaultExportFormat: "YouTube 16:9",
};

/** Top-level preset categories surfaced to users. */
export type PresetCategory =
  | "Creator"
  | "Tutorial"
  | "SaaS"
  | "Coding"
  | "Short-form"
  | "Product Demo";

export type PresetVibe =
  | "mrbeast"
  | "cinematic"
  | "tutorial"
  | "tiktok"
  | "coding"
  | "product"
  | "saas"
  | "youtube"
  | "vlog"
  | "podcast"
  | "demo"
  | "shorts";

export interface Preset {
  id: string;
  name: string;
  category: PresetCategory;
  description: string;
  useCase: string;
  /** Visual identity for the synthetic thumbnail. */
  vibe: PresetVibe;
  effects: EffectsSettings;
  /** Set when this is a user-created preset. */
  isCustom?: boolean;
  /** Owning uid for custom presets (omitted on built-ins). */
  ownerUid?: string;
  /** If duplicated from a built-in, the original id. */
  basedOn?: string;
  createdAt?: number;
  updatedAt?: number;
  /**
   * Minimum plan tier required to apply this preset. Absent = available on
   * all tiers (including free). Custom presets never carry a `requiredPlan`
   * — they're authored by the user and tied to their own tier.
   */
  requiredPlan?: "free" | "creator" | "pro";
}

/**
 * Per-user, per-month export usage counter. Stored at
 * `users/{uid}/usage/{YYYY-MM}`. Written only by the server via
 * `incrementExportUsage()` in src/lib/usage/usage.ts; the client can read
 * its own to render "X of Y exports this month".
 */
export interface MonthlyUsage {
  exportCount: number;
  /** Epoch ms of the most recent export permit. */
  lastExportAt?: number;
  updatedAt: number;
  /**
   * Cloud-export minutes RESERVED by in-flight jobs this month (paid plans
   * only). Double-entry with `cloudMinutesConsumed`: a job reserves its
   * estimate at enqueue, then on a terminal state either settles the reservation
   * into `cloudMinutesConsumed` (success) or releases it (failure/cancel).
   * `remaining = limit − reserved − consumed`. Server-written; read-only to the
   * client. Absent ⇒ 0. See src/lib/usage/cloud-minutes.ts.
   */
  cloudMinutesReserved?: number;
  /** Cloud-export minutes CONSUMED by successful jobs this month. */
  cloudMinutesConsumed?: number;
  /** Epoch ms of the most recent cloud-export settlement. */
  lastCloudExportAt?: number;
}

export interface ProjectDoc {
  id: string;
  userId: string;
  title: string;
  originalVideoUrl: string;
  storagePath: string;
  duration?: number;
  width?: number;
  height?: number;
  fileSize?: number;
  mimeType?: string;
  status: ProjectStatus;
  analysis?: Analysis;
  /**
   * Client-side computer-vision pass output. Written by the browser before the
   * server analyze route runs, then read by the route and fused in the
   * balancer. Top-level (not under `analysis`) so the route's `analysis` reset
   * never clobbers it. Absent on projects analyzed before CV shipped.
   */
  visualAnalysis?: VisualAnalysis;
  effectsSettings: EffectsSettings;
  /** The preset that was last applied. May be a built-in id or a custom preset id. */
  selectedPresetId?: string;
  exportUrl?: string;
  /**
   * "tab" when the recording surface was the Framevo tab itself (events are
   * authoritative). "external" for any other surface (browser-captured events
   * are noise — pipeline relies on CV only). Absent on uploads, treated as
   * "external" by the analyzer.
   */
  interactionScope?: "tab" | "external";
  /**
   * Storage path of the serialized `Interaction[]` JSON, written next to the
   * video. Absent for uploads and for recordings with zero captured events.
   */
  interactionsPath?: string;
  /**
   * Capture geometry recorded at scope-decision time. Lets the analyzer
   * independently re-validate `interactionScope` instead of trusting the
   * capture-time call. Absent on plain uploads and pre-existing recordings.
   */
  captureDimensions?: CaptureDimensions;
  /**
   * Global source-frame crop (the "Frame Crop" tool). Seeded at project
   * creation when the green-band detector fires on a `displaySurface ===
   * "browser"` recording (a bottom-only rect, `reason:"browser-bar-cleanup"`),
   * or drawn manually in the editor. Read by every render/analysis path via
   * `resolveSourceRect`. Absent / disabled ⇒ full frame (no crop).
   */
  sourceCrop?: SourceCrop;
  /**
   * Cloud-export NORMALIZED-source cache. The worker transcodes a "risky"
   * source (non-H.264 video or non-AAC/undecodable audio) to a worker-safe
   * H.264+AAC MP4 once, stores it at `users/{uid}/projects/{pid}/normalized/
   * source.mp4`, and reuses it for future exports of this project.
   * `normalizedSourceKey` is the original object's identity (`generation:md5Hash`)
   * — when the source is re-uploaded the key changes and the cache is rebuilt.
   * `normalizedAudioDropped` records whether the normalized file was built with
   * `-an` (unsupported audio) so the silent-export warning stays consistent on
   * reuse. All absent until the first risky export with normalization enabled.
   */
  normalizedSourcePath?: string;
  normalizedSourceKey?: string;
  normalizedAudioDropped?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UserDoc {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Active plan tier. Mirrored from `subscriptions/{uid}.plan` by the
   * Lemon Squeezy webhook so the client (sidebar, gating) can read it from
   * the user doc without joining. Absent = treat as "free".
   */
  plan?: "free" | "creator" | "pro";
}

/**
 * Per-user workspace settings — persisted at
 * `users/{uid}/settings/workspace`. Lives in its own doc (not on `UserDoc`)
 * so the user can write freely without auth coupling, and so reads from
 * the settings page don't fetch the full user record.
 *
 * Fields are all optional so older accounts decode as defaults instead
 * of failing the type-check. The settings page resolves missing fields
 * to `DEFAULT_WORKSPACE_SETTINGS` below.
 */
export interface WorkspaceSettings {
  /** Default preset id applied to new projects. */
  defaultPresetId?: string;
  /** Default export container/aspect applied to new projects. */
  defaultExportFormat?: ExportFormat;
  /** Per-channel notification preferences. */
  notifications?: NotificationPreferences;
  /**
   * Remembered defaults for the three analysis engines, shown pre-toggled in
   * the "Analysis options" dialog. The `existingEditMode` is intentionally NOT
   * persisted — it's a per-run safety choice that always re-defaults.
   */
  analysisEngines?: {
    generateCameraEdits?: boolean;
    generateCut?: boolean;
    generateSpeed?: boolean;
  };
  /** Remembered analysis-detail (chunk-granularity) choice for the dialog. */
  analysisDetail?: {
    chunkMode?: "fast" | "balanced" | "detailed" | "very-detailed" | "custom";
    chunkSizeSeconds?: number;
  };
  updatedAt?: number;
}

export interface NotificationPreferences {
  /** Push a bell entry when an export finishes or fails. */
  renderComplete?: boolean;
  /** Stats / shareable highlights digest. Reserved — no producer yet. */
  weeklyDigest?: boolean;
  /** Product changelog. Reserved — no producer yet. */
  productNews?: boolean;
}

export const DEFAULT_WORKSPACE_SETTINGS: Required<
  Omit<WorkspaceSettings, "updatedAt">
> & { updatedAt?: number } = {
  defaultPresetId: "preset-cinematic",
  defaultExportFormat: "YouTube 16:9",
  notifications: {
    renderComplete: true,
    weeklyDigest: false,
    productNews: true,
  },
  analysisEngines: {
    generateCameraEdits: true,
    generateCut: true,
    generateSpeed: true,
  },
  analysisDetail: {
    chunkMode: "balanced",
    chunkSizeSeconds: 30,
  },
};

/**
 * Public API key metadata — persisted at
 * `users/{uid}/apiKeys/{keyId}`. The plaintext key is shown to the user
 * ONCE at creation time and never stored. We persist a SHA-256 hash and
 * a short prefix so the dashboard can preview which key is which without
 * being able to authenticate as the user.
 *
 * For server-side validation, a parallel `apiKeyIndex/{sha256(key)}` doc
 * stores `{ uid, keyId }` so a bearer token can be resolved without a
 * collection-group query.
 */
export interface ApiKeyDoc {
  id: string;
  /** Human-friendly label set by the user. */
  name: string;
  /**
   * First 12 chars of the plaintext key. Includes the `ak_test_` / `ak_live_`
   * prefix so the dashboard can show e.g. `ak_live_8f6c…` without exposing
   * anything secret.
   */
  keyPrefix: string;
  /** SHA-256 hex of the full plaintext key. Server-only check material. */
  keyHash: string;
  type: "test" | "live";
  createdAt: number;
  /**
   * Last time the validation helper resolved this key. Updated
   * fire-and-forget on each validate call; may lag by a few seconds.
   */
  lastUsedAt?: number;
  /**
   * Soft-delete flag. When true, the validation helper rejects the
   * key and the parallel index doc is removed. Kept on the user's
   * record so the dashboard can still show "revoked on …" if desired.
   */
  revoked?: boolean;
  revokedAt?: number;
}

/**
 * Global index doc at `apiKeyIndex/{sha256(plaintext)}`. Read by the
 * server-side `validateApiKey` helper to resolve a bearer token to a
 * `{ uid, keyId }` pair without scanning every user's subcollection.
 * Created at key issuance, deleted at revocation. Client never reads
 * or writes — Firestore rules MUST restrict it to server (admin SDK).
 */
export interface ApiKeyIndexDoc {
  uid: string;
  keyId: string;
  type: "test" | "live";
  createdAt: number;
}

/**
 * Lifecycle status of a Lemon Squeezy subscription, normalised to our
 * internal vocabulary. Maps to LS `status` strings with a small switch in
 * `src/lib/lemonsqueezy/webhook.ts`.
 */
export type SubscriptionStatus =
  | "active"
  | "on_trial"
  | "paused"
  | "past_due"
  | "unpaid"
  | "cancelled"
  | "expired";

/**
 * Live subscription state for one user. Stored at top-level
 * `subscriptions/{userId}`. The plan tier is mirrored to `users/{uid}.plan`
 * for cheap client reads; this doc is the source of truth.
 */
export interface Subscription {
  userId: string;
  plan: "free" | "creator" | "pro";
  status: SubscriptionStatus;
  lemonCustomerId: string;
  lemonSubscriptionId: string;
  variantId: string;
  /** Next renewal time, epoch ms. */
  renewsAt?: number;
  /** When access actually ends (set after a cancel — until then, plan stays paid). */
  endsAt?: number;
  /** Trial period end, epoch ms. */
  trialEndsAt?: number;
  /** LS-hosted customer portal URL — kept fresh from each subscription_* event. */
  customerPortalUrl?: string;
  /** LS-hosted payment update URL. */
  updateUrl?: string;
  /**
   * Epoch ms of the most recent successful payment, written by
   * `subscription_payment_success`. Independent from `status`/`plan` so a
   * payment receipt event can never clobber the authoritative subscription
   * state (which only the subscription_* state events drive).
   */
  lastPaymentAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Export lifecycle:
 *   permitted → exporting → ready  (happy path)
 *   permitted → failed              (render error after permit issued)
 *
 * `permitted` is set by /api/billing/export-permit BEFORE the client
 * renders. Resolution / format / fps / applyWatermark are immutable from
 * that moment onward — the Firestore rules forbid touching them.
 */
export type ExportStatus =
  | "queued"
  | "permitted"
  | "exporting"
  | "ready"
  | "failed";

export interface ExportDoc {
  id: string;
  projectId: string;
  projectTitle: string;
  format: ExportFormat;
  resolution: "1080p" | "4K";
  fps: 30 | 60;
  /** Output container — "webm" (default) or "mp4". Absent on pre-MP4 docs. */
  container?: "webm" | "mp4";
  exportUrl?: string;
  storagePath?: string;
  fileSize?: number;
  status: ExportStatus;
  errorMessage?: string;
  createdAt: number;
  completedAt?: number;
  /**
   * Whether the client must render this export with a free-tier watermark.
   * Set by the permit endpoint based on the user's plan at issue time —
   * locked in until completion so a mid-render upgrade can't strip it.
   */
  applyWatermark?: boolean;
  /**
   * Exact Storage path the client must upload to. Returned by the permit
   * endpoint so the client doesn't construct it. Storage rules separately
   * enforce that the upload lands under the user's prefix.
   */
  expectedStoragePath?: string;
  /** Month bucket ("YYYY-MM") this export counted against. */
  monthlyBucket?: string;
}

// ── Cloud export jobs (server-side render) ──────────────────────────────────
// The browser `ExportDoc` above is the Free / fallback path (client renders +
// uploads). PAID cloud MP4 export instead creates an `ExportJobDoc` that a
// Cloud Run worker picks up, renders with FFmpeg + the shared render core, and
// uploads. Kept in a SEPARATE collection (`users/{uid}/exportJobs/{jobId}`) so
// the audited `exports` rule stays untouched and the writer model can invert
// (worker writes status; client only requests cancel via the API).

/**
 * The DOM-free, serializable render inputs persisted on an export job. The
 * worker feeds these straight into `buildRenderRecipe` (src/lib/render/recipe),
 * the SAME function the browser exporter calls — storing RAW inputs (full
 * `moments` + `effects` + `sourceCrop`) rather than pre-bucketed cut/speed/
 * camera lists is what guarantees preview/export parity.
 */
export interface SerializedRenderRecipe {
  sourceWidth: number;
  sourceHeight: number;
  fps: 30 | 60;
  resolution: "1080p" | "4K";
  format: ExportFormat;
  /** Full SOURCE duration in seconds (pre cuts/speed). */
  sourceDuration: number;
  moments: DetectedMoment[];
  effects: EffectsSettings;
  visualAnalysis?: VisualAnalysis;
  sourceCrop?: SourceCrop | null;
  /** Always false for paid cloud exports (Free has no cloud export). */
  applyWatermark: boolean;
}

/**
 * Cloud-export job lifecycle:
 *   queued → batch_submitted → rendering → uploading → ready   (Batch happy path)
 *   queued → rendering → uploading → ready                     (VM/Cloud Run path)
 *   queued|batch_submitted|rendering → failed   (system error; minutes refunded)
 *   queued|rendering → canceled                 (cancelRequested honored; refunded)
 *
 * `batch_submitted` is the Google Cloud Batch transition: the job doc is created
 * (`queued`) inside the reserve+create transaction, then a Batch task is submitted
 * and the doc flips to `batch_submitted` (container is provisioning, not yet
 * rendering). The one-shot worker claims it → `rendering`. On the legacy VM/poll
 * path the job goes straight `queued → rendering` (no Batch step).
 *
 * Created by `POST /api/export/cloud` with `status:"queued"` AFTER plan + minutes
 * gating. Every transition after that is written server-side (worker / Batch
 * submitter, Admin SDK). The client only ever sets `cancelRequested` via
 * `POST /api/export/cancel`.
 */
export type ExportJobStatus =
  | "queued"
  | "batch_submitted"
  | "rendering"
  | "uploading"
  | "ready"
  | "failed"
  | "canceled";

/** Fine-grained worker stage, surfaced in the UI alongside `progress`. */
export type ExportJobStage =
  | "queued"
  | "downloading"
  | "normalizing"
  | "decoding"
  | "rendering"
  /** Long-video chunked render in progress (see `chunkIndex`/`chunkTotal`). */
  | "rendering_chunks"
  /** Concatenating rendered chunks into the final MP4. */
  | "merging"
  | "encoding"
  | "uploading";

export interface ExportJobDoc {
  id: string;
  userId: string;
  projectId: string;
  projectTitle: string;
  status: ExportJobStatus;
  /** Plan at job-creation time (Free can't reach this path). */
  plan: "pro" | "creator";
  /** Queue tier — creator → "priority", pro → "normal". */
  priority: "normal" | "priority";
  /** Source video Storage path (users/{uid}/projects/{pid}/original/<file>). */
  sourceStoragePath: string;
  /** Storage path the worker writes the MP4 to. */
  outputPath: string;
  /** Public download URL — set once the upload finishes. */
  downloadUrl?: string;
  format: "mp4";
  outputWidth: number;
  outputHeight: number;
  fps: 30 | 60;
  /** OUTPUT duration in seconds (post cuts/speed) — what minutes bill on. */
  durationSeconds: number;
  estimatedExportMinutes: number;
  /** Settled only on success; mirrors `cloudMinutesConsumed` for this job. */
  consumedExportMinutes?: number;
  /** 0..1 for the active stage. */
  progress: number;
  stage?: ExportJobStage;
  errorMessage?: string;
  errorCode?: string;
  /** Set by /api/export/cancel; the worker polls it between frames. */
  cancelRequested?: boolean;
  /** Non-fatal worker notices (e.g. "source has no audio — exported silent"). */
  warnings?: string[];
  /**
   * Preflight summary the worker recorded for this job (observability — shown in
   * the admin exports view). `normalized` ⇒ the worker rendered from the
   * transcoded H.264+AAC copy rather than the raw source.
   */
  preflight?: {
    videoCodec: string;
    audioCodec: string;
    risky: boolean;
    normalized: boolean;
  };
  /** Month bucket ("YYYY-MM") this job reserved/consumed minutes against. */
  monthlyBucket: string;
  /** Raw render inputs the worker feeds to `buildRenderRecipe`. */
  renderRecipe: SerializedRenderRecipe;
  // ── Multi-VM claim + heartbeat (atomic claim lets many VM workers share the
  //    queue safely; these record WHICH worker took the job + liveness). ──────
  /** Id of the VM worker that claimed the job (EXPORT_WORKER_ID or hostname). */
  workerId?: string;
  /** Epoch ms when a worker claimed the job. */
  claimedAt?: number;
  /** Epoch ms of the worker's last heartbeat — drives the "taking longer than
   *  expected" / stale detection in the UI (independent of `updatedAt`). */
  lastHeartbeatAt?: number;
  /** Epoch ms the single-job (Batch) worker bumps every 30s. Mirrors
   *  `lastHeartbeatAt`; kept distinct for the Batch liveness contract. */
  heartbeatAt?: number;
  /** Best-effort queue position recorded at enqueue (active jobs created before
   *  this one). Shown while `status === "queued"`; not updated live. */
  queuePosition?: number;
  /** Friendly, UI-facing stage label written by the worker alongside `stage`:
   *  "queued" | "preparing" | "rendering" | "uploading" | "ready". The raw
   *  `stage` stays for diagnostics; this is what the dialog renders. */
  progressStage?: ExportUiStage;
  /**
   * Which engine produced this job. Always "cloud" for docs in this collection
   * (browser exports live in the separate `exports` collection), but stamped
   * explicitly so the two paths can never be confused in the UI or logs.
   */
  exportPath?: "cloud" | "browser";
  /**
   * Deterministic dedup key (see `computeSettingsHash`): project + source +
   * format/resolution/fps + canvas + vignette + timeline content. Used to detect
   * a repeated export of identical settings and return the existing ACTIVE job
   * instead of creating a duplicate.
   */
  settingsHash?: string;
  /** Worker build/version that last touched this job (observability + bug reports). */
  buildVersion?: string;
  // ── Google Cloud Batch attribution (paid export runs as a one-shot Batch task) ─
  /** Batch job id we submitted (`export-<jobId>-<suffix>`, RFC1035). */
  batchJobId?: string;
  /** Fully-qualified Batch job resource name
   *  (`projects/{p}/locations/{region}/jobs/{batchJobId}`). */
  batchJobName?: string;
  /** Epoch ms when the Batch task was submitted (status → batch_submitted). */
  batchSubmittedAt?: number;
  // ── Chunked render progress (long videos; only when chunking is enabled) ──────
  /** 1-based index of the chunk currently rendering. */
  chunkIndex?: number;
  /** Total number of chunks for this export (1 when not chunked). */
  chunkTotal?: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  /** When the job entered `failed` (distinct from completedAt for success). */
  failedAt?: number;
  canceledAt?: number;
}

/** Friendly progress stages the export dialog shows (maps from status + stage). */
export type ExportUiStage =
  | "queued"
  | "preparing"
  | "rendering"
  | "merging"
  | "uploading"
  | "ready";
