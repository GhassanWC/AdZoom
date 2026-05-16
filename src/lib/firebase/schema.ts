// Shared types for Firestore documents — used on both client and server.

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

export type EffectType = "zoom" | "click-highlight" | "cursor-focus" | "speed-up";

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
  /** True if a caption should be shown for this moment. */
  caption?: boolean;

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

  /**
   * Legacy field. New code reads `attentionScore`; falls back here for old projects.
   * @deprecated use attentionScore
   */
  importance?: number;
}

export interface NarrativeSegment {
  startTime: number;
  endTime: number;
  role: NarrativeRole;
  label: string;
}

export interface SuggestedCaption {
  startTime: number;
  text: string;
}

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
  | "tighten"; // a moment that runs longer than its action

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
  version: 1;
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
  /** Wall-clock the CV pass took, ms — surfaced for the honest report. */
  computeMs: number;
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
  suggestedCaptions: SuggestedCaption[];
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
}

export type CaptionStyle = "none" | "minimal" | "bold-pop" | "tutorial-tooltip" | "subtitle";
export type Pacing = "slow" | "moderate" | "fast";
export type TargetPlatform = "youtube" | "tiktok" | "reels" | "twitter" | "internal";
export type ExportFormat = "1080p" | "4K" | "TikTok 9:16" | "YouTube 16:9" | "Custom";

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
  // ── preset-driven ──
  captionStyle: CaptionStyle;
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
  captionStyle: "minimal",
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
}

export type ExportStatus = "queued" | "exporting" | "ready" | "failed";

export interface ExportDoc {
  id: string;
  projectId: string;
  projectTitle: string;
  format: ExportFormat;
  resolution: "1080p" | "4K";
  fps: 30 | 60;
  exportUrl?: string;
  storagePath?: string;
  fileSize?: number;
  status: ExportStatus;
  errorMessage?: string;
  createdAt: number;
  completedAt?: number;
}
