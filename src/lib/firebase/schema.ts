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
  | "user";

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
  /** v1 = CV-only, ad-hoc attentionCurve. v2 = hybrid-ready (curve from src/lib/attention/score.ts). */
  version: 1 | 2;
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
  /**
   * Cinematic vignette — a soft radial darkening at the frame edges,
   * baked into the exported video when enabled. Preview honors this too
   * so what you see is what you get. Optional + defaults to `false`
   * (no migration needed for older docs — they decode as undefined and
   * the consumer treats that as off).
   */
  vignette?: boolean;
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
   * video. Absent for uploads and for in-tab recordings with zero events.
   */
  interactionsPath?: string;
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
