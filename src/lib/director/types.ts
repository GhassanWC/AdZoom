/**
 * AI Director — the plan type system.
 *
 * THE CENTRAL IDEA: the Director never returns timeline mutations. It returns a
 * `DirectorPlan` — a structured, validated, persisted document that is the SINGLE
 * source of truth. The executor is the only thing that turns a plan into edits,
 * and the edits it produces are ordinary `DetectedMoment`s on
 * `analysis.detectedMoments` — the exact array the timeline, the preview
 * resolvers (`resolveCameraFrame` / `drawOutputOverlays`) and the export recipe
 * (`buildRenderRecipe`) already read.
 *
 * That is what makes preview/export parity structural rather than something to
 * keep in sync: there is no second interpretation of the AI's response anywhere.
 * The UI renders the plan, the executor compiles the plan, and both preview and
 * export consume the compiled moments.
 *
 * Pure types + frozen constants only. No React, no Firebase, no Gemini — this
 * module is imported by the client, the server route, and the node test runner
 * alike.
 */
import type {
  CalloutStyle,
  CaptionPosition,
  DetectedMoment,
  EffectType,
  FocusRegion,
  OverlayTextPreset,
  SmartCropAspect,
  SmartCropFocus,
  TextStyle,
  TransitionStyle,
} from "../firebase/schema";

/** Bumped when the plan shape changes in a way old plans can't be replayed under. */
export const DIRECTOR_PLAN_VERSION = 1;

// ════════════════════════════════════════════════════════════════════════════
// The edit-type allowlist — the Director can NEVER invent an edit type
// ════════════════════════════════════════════════════════════════════════════

/**
 * The ONLY effect types the Director may emit. Every member is an existing
 * Framevo `EffectType` with a working generator, timeline lane, preview resolver
 * and export renderer — so a Director edit and a hand-made edit are the same
 * thing to every downstream system.
 *
 * Deliberately EXCLUDED:
 *   • `crop`            — legacy manual-only edit, superseded by `smart-crop`
 *                         + the global sourceCrop tool.
 *   • `blur-redaction`  — no reliable auto-detector exists. Auto-placing a blur
 *                         would either miss real PII (worse than useless) or
 *                         cover the wrong thing. It stays a manual edit.
 *
 * The validator rejects anything outside this list, so a hallucinated edit type
 * from the model becomes a reported failure, never a silently-dropped or
 * silently-wrong edit.
 */
export const DIRECTOR_EDIT_TYPES = [
  "zoom",
  "click-highlight",
  "cursor-focus",
  "speed-up",
  "cut",
  "captions",
  "hook-text",
  "text-overlay",
  "callout",
  "transition",
  "branding-cta",
  "smart-crop",
] as const;

export type DirectorEditType = (typeof DIRECTOR_EDIT_TYPES)[number];

/** Compile-time proof that every Director edit type is a real Framevo EffectType. */
const _DIRECTOR_TYPES_ARE_EFFECT_TYPES: readonly EffectType[] = DIRECTOR_EDIT_TYPES;
void _DIRECTOR_TYPES_ARE_EFFECT_TYPES;

const DIRECTOR_EDIT_TYPE_SET: ReadonlySet<string> = new Set(DIRECTOR_EDIT_TYPES);

export function isDirectorEditType(t: unknown): t is DirectorEditType {
  return typeof t === "string" && DIRECTOR_EDIT_TYPE_SET.has(t);
}

// ════════════════════════════════════════════════════════════════════════════
// Request — what the user asked for
// ════════════════════════════════════════════════════════════════════════════

export const DIRECTOR_GOALS = [
  "product-demo",
  "tutorial",
  "social-clips",
  "promo",
  "clean-up",
  "custom",
] as const;
export type DirectorGoal = (typeof DIRECTOR_GOALS)[number];

export const DIRECTOR_PLATFORMS = [
  "tiktok",
  "reels",
  "shorts",
  "youtube",
  "linkedin",
  "x",
  "internal",
] as const;
export type DirectorPlatform = (typeof DIRECTOR_PLATFORMS)[number];

export const DIRECTOR_ASPECTS = ["9:16", "1:1", "4:5", "16:9"] as const;
export type DirectorAspect = (typeof DIRECTOR_ASPECTS)[number];

export const DIRECTOR_STYLES = [
  "energetic",
  "professional",
  "calm",
  "cinematic",
  "minimal",
] as const;
export type DirectorStyle = (typeof DIRECTOR_STYLES)[number];

export const DIRECTOR_CAPTION_STYLES = [
  "none",
  "clean",
  "bold_social",
  "minimal",
  "podcast",
  "tutorial",
] as const;
export type DirectorCaptionStyle = (typeof DIRECTOR_CAPTION_STYLES)[number];

export const DIRECTOR_CTA_MODES = ["auto", "always", "never"] as const;
export type DirectorCtaMode = (typeof DIRECTOR_CTA_MODES)[number];

/**
 * THE BRIEF — what the user asked for, persisted as an INPUT to analysis.
 *
 * Deliberately separate from `DirectorState`, which is a record of a run that
 * HAPPENED. The brief exists before any run does: it is the thing the analysis
 * pipeline reads when it starts, so "Direct my video" stops being a second pass
 * bolted on afterwards and becomes part of the one flow.
 *
 * Stored raw (prompt + form) rather than as a parsed `DirectorRequest` so that
 * re-parsing it later picks up improvements to the parser, and so the panel can
 * round-trip exactly what the user typed.
 */
export interface DirectorBrief {
  /** Verbatim natural-language prompt. Empty string = no brief. */
  prompt: string;
  form: {
    goal?: DirectorGoal;
    platform?: DirectorPlatform;
    targetDurationSeconds?: number;
    aspectRatio?: DirectorAspect;
    style?: DirectorStyle;
    captionStyle?: DirectorCaptionStyle;
    cta?: DirectorCtaMode;
    ctaText?: string;
  };
  updatedAt: number;
}

/** A brief is only worth running when the user actually said something. */
export function hasDirectorBrief(b: DirectorBrief | undefined | null): boolean {
  return Boolean(b && b.prompt.trim().length > 0);
}

/**
 * Should this analysis run the Director at all?
 *
 * Opt-OUT, not opt-in: a saved brief means the user wants their video directed,
 * and making them re-confirm on every run would be a trap — they'd get a plain
 * analysis and wonder where their instructions went. Only an explicit `false`
 * (the analysis dialog's toggle) suppresses it.
 *
 * Lives here, in the pure module, rather than beside the stage that uses it: the
 * stage imports Gemini (`server-only`), and this predicate is the thing the
 * client, the route AND the tests all need to agree on.
 */
export function shouldRunDirectorStage(
  brief: DirectorBrief | undefined,
  applyDirectorBrief: boolean | undefined
): brief is DirectorBrief {
  return hasDirectorBrief(brief) && applyDirectorBrief !== false;
}

/** The normalized request — the parser's output, persisted with the plan. */
export interface DirectorRequest {
  /** Verbatim natural-language prompt the user typed. */
  prompt: string;
  goal: DirectorGoal;
  platform: DirectorPlatform;
  /** Absent = "as long as it needs to be". */
  targetDurationSeconds?: number;
  aspectRatio: DirectorAspect;
  style: DirectorStyle;
  captionStyle: DirectorCaptionStyle;
  cta: DirectorCtaMode;
  /** Free-text CTA copy the user supplied, if any. */
  ctaText?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Evidence — every decision must be grounded in something real
// ════════════════════════════════════════════════════════════════════════════

export const DIRECTOR_EVIDENCE_KINDS = [
  "transcript",
  "click",
  "moment",
  "silence",
  "scene",
  "narrative",
  "attention",
  "user-request",
  "heuristic",
] as const;
export type DirectorEvidenceKind = (typeof DIRECTOR_EVIDENCE_KINDS)[number];

/**
 * Why the Director believes something. `ref` points at the real datum (a moment
 * id, a transcript segment id, …) so a reviewer can check the claim instead of
 * trusting it.
 */
export interface DirectorEvidence {
  kind: DirectorEvidenceKind;
  detail: string;
  /** Id of the source datum (moment id / transcript segment id) when there is one. */
  ref?: string;
  /** Source timestamp the evidence sits at, when meaningful. */
  at?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Story structure
// ════════════════════════════════════════════════════════════════════════════

/**
 * The narrative spine. The final video must read as ONE connected piece, so the
 * planner assigns every kept second to a section and the validator enforces that
 * the sections appear in this canonical order.
 */
export const DIRECTOR_SECTION_KINDS = [
  "hook",
  "context",
  "demo",
  "result",
  "cta",
] as const;
export type DirectorSectionKind = (typeof DIRECTOR_SECTION_KINDS)[number];

/** Canonical story order — index in this array IS the required ordering. */
export const DIRECTOR_SECTION_ORDER: Record<DirectorSectionKind, number> = {
  hook: 0,
  context: 1,
  demo: 2,
  result: 3,
  cta: 4,
};

export const DIRECTOR_SECTION_LABEL: Record<DirectorSectionKind, string> = {
  hook: "Hook",
  context: "Context",
  demo: "Main demonstration",
  result: "Result",
  cta: "Call to action",
};

export interface DirectorSection {
  id: string;
  kind: DirectorSectionKind;
  /** Short human title, e.g. "Payment flow". */
  title: string;
  /** SOURCE-time window this section is drawn from. */
  startTime: number;
  endTime: number;
  reason: string;
  confidence: number;
  evidence: DirectorEvidence[];
}

// ════════════════════════════════════════════════════════════════════════════
// Operations — every one carries id / window / reason / confidence /
// evidence / priority, and names an EXACT existing Framevo edit type
// ════════════════════════════════════════════════════════════════════════════

/**
 * Why an edit earned its place — the editorial judgment's internal answer to
 * "what is this edit actually doing for the viewer". Not necessarily shown to
 * the user verbatim (the human-readable `reason` is what they see); this is the
 * category the decision engine used to decide the edit was worth keeping.
 */
export const DIRECTOR_JUSTIFICATION_KINDS = [
  /** Emphasizes an important point. */
  "emphasis",
  /** Maintains pacing (speed changes, transitions). */
  "pacing",
  /** Guides the viewer's attention (callouts, cursor/click focus). */
  "attention",
  /** Highlights a real action the viewer performed on screen. */
  "action",
  /** Improves clarity (captions, text overlays that explain). */
  "clarity",
  /** Increases engagement (hooks, CTAs). */
  "engagement",
  /** Structural — the narrative spine itself (story sections, framing). */
  "structure",
] as const;
export type DirectorJustificationKind = (typeof DIRECTOR_JUSTIFICATION_KINDS)[number];

/** Shared shape — the spec's per-operation requirements, in one place. */
export interface DirectorOperationBase {
  /** Stable id. Deterministic across retries of the same request → no duplicates. */
  id: string;
  startTime: number;
  endTime: number;
  /** Plain-English justification, shown in the UI on the edit itself. */
  reason: string;
  /** 0..1 — how sure the Director is. Low-confidence ops are reported, not hidden. */
  confidence: number;
  /** 0..1 — what to sacrifice first when the target duration forces cuts. */
  priority: number;
  evidence: DirectorEvidence[];
  /** The story section this op serves. */
  sectionId?: string;
  /**
   * Set by the editorial judgment pass once an edit has been judged worth
   * keeping. An operation that reaches the executor without one either predates
   * the decision engine or is a clip/audio op the engine doesn't classify.
   */
  justification?: DirectorJustificationKind;
}

/**
 * Clip-level structure.
 *
 * `keep`   — protect this window from removal (never cut).
 * `remove` — drop this window entirely (executed as a real `cut` moment).
 * `trim`   — tighten a window's edges (executed as `cut`s on the trimmed edges).
 * `reorder`— NOT SUPPORTED. `buildTimelineMap` is strictly monotonic in source
 *            time, so a reordered clip cannot be rendered by the preview, the
 *            browser exporter, the Cloud Run worker OR Remotion. The validator
 *            REJECTS reorder ops with `unsupported_operation` and the review
 *            surfaces a warning. It is declared here (rather than omitted) so a
 *            model that asks for it gets an honest, explicit refusal instead of
 *            a silently-dropped op or a mis-rendered video.
 */
export const DIRECTOR_CLIP_OP_KINDS = ["keep", "remove", "trim", "reorder"] as const;
export type DirectorClipOpKind = (typeof DIRECTOR_CLIP_OP_KINDS)[number];

export interface DirectorClipOperation extends DirectorOperationBase {
  kind: DirectorClipOpKind;
  /** Only meaningful for `reorder` (which is rejected — see above). */
  order?: number;
}

/** Category-specific tuning. Typed, not an open bag — the Director can't smuggle. */
export interface DirectorEditParams {
  /** hook-text / text-overlay / callout copy. */
  text?: string;
  /** branding-cta copy. */
  ctaText?: string;
  /** speed-up multiplier (>1). */
  speedMultiplier?: number;
  transitionStyle?: TransitionStyle;
  calloutStyle?: CalloutStyle;
  /** smart-crop framing. */
  aspectRatio?: SmartCropAspect;
  focusTarget?: SmartCropFocus;
  /**
   * A preset id from Framevo's library, named explicitly by the plan.
   *
   * This is how the Director asks for a DESIGN THAT EXISTS instead of inventing
   * one: the planner reads the real catalogue and returns an id from it. The id
   * is resolved through `resolveDirectorPreset` before anything is applied — an
   * id that isn't in the registry is REPORTED and the deterministic scorer picks
   * the slot's look instead. It is never coerced into "something close".
   *
   * Absent means "you choose" — the scorer picks on tone/platform/aspect.
   */
  presetId?: string;
}

export interface DirectorEditOperation extends DirectorOperationBase {
  /** The EXACT existing Framevo effect type this compiles to. Allowlisted. */
  editType: DirectorEditType;
  /** Where to point the camera / callout. 0..1 frame coords. */
  focusRegion?: FocusRegion;
  /** 0..1 camera strength. */
  intensity?: number;
  params?: DirectorEditParams;
}

/**
 * Audio-driven pacing. Both removal kinds compile to real `cut` moments — the
 * one mechanism the whole render pipeline already honors — so "remove pauses"
 * genuinely shortens preview AND export, rather than being cosmetic.
 */
export const DIRECTOR_AUDIO_OP_KINDS = [
  "remove-silence",
  "remove-filler",
  "keep-audio",
] as const;
export type DirectorAudioOpKind = (typeof DIRECTOR_AUDIO_OP_KINDS)[number];

export interface DirectorAudioOperation extends DirectorOperationBase {
  kind: DirectorAudioOpKind;
}

export interface DirectorCaptionInstructions {
  enabled: boolean;
  stylePreset: OverlayTextPreset;
  position: CaptionPosition;
  /** Concrete styling — this is how "energetic" or "professional" becomes real. */
  textStyle?: TextStyle;
  /** A caption preset id from the library. Validated; see `DirectorEditParams.presetId`. */
  presetId?: string;
  reason: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Review rules
// ════════════════════════════════════════════════════════════════════════════

export const DIRECTOR_REVIEW_RULES = [
  "caption-safe-area",
  "text-covers-ui",
  "overlay-overlap",
  "zoom-density",
  "abrupt-cut",
  "tiny-clip",
  "silent-section",
  "duplicate-clip",
  "missing-captions",
  "missing-cta",
  "smart-crop-mismatch",
  "out-of-bounds",
  "target-duration",
  "preview-export-parity",
] as const;
export type DirectorReviewRuleId = (typeof DIRECTOR_REVIEW_RULES)[number];

export interface DirectorReviewRule {
  id: DirectorReviewRuleId;
  enabled: boolean;
  /** Whether the review engine may fix this automatically (safe fixes only). */
  autoFix: boolean;
}

export type DirectorReviewSeverity = "error" | "warning" | "info";

export interface DirectorReviewFinding {
  id: string;
  rule: DirectorReviewRuleId;
  severity: DirectorReviewSeverity;
  message: string;
  /** Moments this finding is about — the UI links straight to them. */
  momentIds: string[];
  at?: number;
  /** Set when the review engine fixed it automatically. */
  fixed: boolean;
  /** What the auto-fix did, in plain English. */
  fixDetail?: string;
}

export interface DirectorReviewResult {
  findings: DirectorReviewFinding[];
  autoFixed: number;
  warnings: number;
  errors: number;
  /** True when preview data === export data (recomputed, not asserted). */
  parityOk: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// The plan
// ════════════════════════════════════════════════════════════════════════════

export interface DirectorPlan {
  planVersion: number;
  /** The user's goal, restated by the Director in its own words. */
  goal: string;
  platform: DirectorPlatform;
  targetDurationSeconds?: number;
  aspectRatio?: DirectorAspect;
  tone?: string;
  storyStructure: DirectorSection[];
  clipOperations: DirectorClipOperation[];
  editOperations: DirectorEditOperation[];
  audioOperations: DirectorAudioOperation[];
  captionInstructions: DirectorCaptionInstructions;
  reviewRules: DirectorReviewRule[];
  /** Why the Director made these choices — shown to the user. */
  explanation: string;
  /** e.g. "gemini-2.5-flash" or "heuristic-v1". Persisted for reproducibility. */
  modelVersion: string;
  createdAt: number;
}

/** Every review rule on, auto-fixing only what is unambiguously safe. */
export const DEFAULT_REVIEW_RULES: DirectorReviewRule[] = DIRECTOR_REVIEW_RULES.map(
  (id) => ({
    id,
    enabled: true,
    // Auto-fix ONLY where a correct fix is unambiguous. Anything editorial
    // (a missing CTA, a silent stretch, an over-long cut) is the user's call —
    // we warn instead of quietly rewriting their video.
    autoFix:
      id === "caption-safe-area" ||
      id === "out-of-bounds" ||
      id === "tiny-clip" ||
      id === "overlay-overlap" ||
      id === "zoom-density" ||
      id === "duplicate-clip",
  })
);

// ════════════════════════════════════════════════════════════════════════════
// Execution results
// ════════════════════════════════════════════════════════════════════════════

/** The back-link stamped onto every Director-made `DetectedMoment`. */
export interface DirectorMomentRef {
  /** The `DirectorOperationBase.id` that produced this edit. */
  operationId: string;
  planVersion: number;
  /** Which revision applied it (0 = the initial run). */
  revision: number;
  sectionId?: string;
}

export const DIRECTOR_FAILURE_REASONS = [
  "unsupported_edit_type",
  "unsupported_operation",
  "invalid_window",
  "out_of_bounds",
  "duplicate_operation",
  "missing_params",
  "no_transcript",
  // The plan named a preset id that isn't in the library (or is in the wrong
  // category). Reported, never coerced into a lookalike — the edit still lands,
  // wearing the design the deterministic scorer picked instead.
  "unknown_preset",
  // The editorial judgment pass could not justify this edit — no reason, no
  // evidence, confidence too low to trust, or it lost out to a stronger edit
  // competing for the same moment. A structurally valid op can still fail here;
  // this is the "would a professional editor actually keep this" gate.
  "weak_justification",
  "executor_error",
] as const;
export type DirectorFailureReason = (typeof DIRECTOR_FAILURE_REASONS)[number];

/**
 * One operation that did NOT make it onto the timeline, and why. Surfaced to the
 * user verbatim. A plan with failures still applies everything else — one bad
 * edit type never sinks the run.
 */
export interface DirectorFailure {
  operationId: string;
  /** The edit type / op kind that failed, for display. */
  subject: string;
  reason: DirectorFailureReason;
  detail: string;
}

/**
 * A design the Director actually applied, and why.
 *
 * Recorded per SLOT (not per moment) because that is the decision the user cares
 * about — "captions are Bold Pop" — and it keeps the record O(slots) instead of
 * O(600 caption moments). `momentCount` says how far the choice reached.
 */
export interface DirectorPresetChoice {
  /** The kit slot this filled: captions | hook | cta | title | callout | … */
  slot: string;
  /** The registry category the preset came from. */
  category: string;
  presetId: string;
  presetName: string;
  /** Whether the plan NAMED this id, or the deterministic scorer chose it. */
  chosenBy: "plan" | "scorer";
  /** How many timeline moments wear this look. */
  momentCount: number;
}

export interface DirectorSummary {
  sourceDurationSeconds: number;
  outputDurationSeconds: number;
  removedSeconds: number;
  pausesRemoved: number;
  hookSeconds: number;
  sectionsCreated: number;
  /** Per-edit-type counts of what actually landed on the timeline. */
  counts: Partial<Record<DirectorEditType, number>>;
  /** The library designs this run applied. Empty when it applied no styled edit. */
  presets?: DirectorPresetChoice[];
  /** The human-readable bullets the UI shows ("Reduced 6:20 → 1:15"). */
  lines: string[];
}

export interface DirectorExecution {
  /** The FULL timeline: preserved user + non-director edits, plus Director edits. */
  moments: DetectedMoment[];
  /** Set when the plan changes the output canvas (smart crop / aspect). */
  outputCanvas?: import("../firebase/schema").OutputCanvas;
  appliedOperationIds: string[];
  failures: DirectorFailure[];
  summary: DirectorSummary;
}

// ════════════════════════════════════════════════════════════════════════════
// Persisted state
// ════════════════════════════════════════════════════════════════════════════

/**
 * The processing stages, in order. Persisted so a page refresh mid-run resumes
 * showing the right stage instead of losing the run.
 */
export const DIRECTOR_STAGES = [
  "understanding",
  "finding-moments",
  "planning",
  "applying",
  "reviewing",
  "finalizing",
] as const;
export type DirectorStage = (typeof DIRECTOR_STAGES)[number];

export const DIRECTOR_STAGE_LABEL: Record<DirectorStage, string> = {
  understanding: "Understanding the video",
  "finding-moments": "Finding important moments",
  planning: "Planning the story",
  applying: "Applying edits",
  reviewing: "Reviewing the result",
  finalizing: "Finalizing the timeline",
};

export type DirectorStatus = "idle" | "running" | "complete" | "failed";

export interface DirectorRevisionEntry {
  id: string;
  /** 0 = the initial direct; 1+ = follow-up revisions. */
  index: number;
  /** The natural-language command. Empty string for the initial run. */
  command: string;
  createdAt: number;
  /**
   * The plan AS OF this revision. Undo = drop this entry and re-execute the
   * previous entry's plan. Because the executor is pure and deterministic,
   * replaying a stored plan reproduces that timeline EXACTLY — so history stays
   * small (a plan, not a timeline snapshot) while restore stays exact.
   */
  plan: DirectorPlan;
  summary: DirectorSummary;
  review: DirectorReviewResult;
  appliedOperationIds: string[];
  failures: DirectorFailure[];
}

export interface DirectorState {
  /** The original natural-language prompt. */
  prompt: string;
  request: DirectorRequest;
  status: DirectorStatus;
  /** Which stage is running now (persisted → survives refresh). */
  stage?: DirectorStage;
  /** The CURRENT plan — the single source of truth for the Director's edits. */
  plan?: DirectorPlan;
  summary?: DirectorSummary;
  review?: DirectorReviewResult;
  failures?: DirectorFailure[];
  /** Full history. `revisions[revisions.length - 1]` corresponds to `plan`. */
  revisions: DirectorRevisionEntry[];
  errorMessage?: string;
  modelVersion?: string;
  planVersion?: number;
  startedAt?: number;
  completedAt?: number;
  /**
   * Hash of (request + source fingerprint). Re-running the SAME request is a
   * no-op re-apply rather than a second set of duplicate edits.
   */
  requestHash?: string;
}
