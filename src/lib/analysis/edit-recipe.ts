/**
 * AI Edit Recipe Engine.
 *
 * Maps a user-selected video type → a structured PLAN of edit operations. It is
 * a PLANNING layer: `resolveEditRecipe` returns an `EditRecipePlan` (which edits
 * to apply, why, and with what tuning) and NEVER mutates the timeline. The
 * existing zoom / cut / speed engines keep running exactly as before; this
 * engine records + reasons about the broader edit set (captions, crop, overlays,
 * transitions, music, clips, …) so those can be implemented later WITHOUT
 * changing this architecture — a new edit is just a new `EditOperationCategory`
 * plus a default op in `DEFAULT_RECIPES`.
 *
 * Pure + framework-neutral (types only) so it's shared by the analysis route,
 * the orchestrator, and the client UI.
 */
import type { SelectedVideoType, VideoType } from "@/lib/firebase/schema";

/**
 * Best-fit user-facing type for an AI-DETECTED type — used when the user chose
 * "Auto" so we can pick a concrete recipe from the detection. Inlined (not
 * imported from video-type.ts) so this module has ONLY type-only cross-file
 * imports and stays loadable by the native test runner. `undefined` for
 * ambiguous detections ("mixed") → the general recipe.
 */
function detectedToSelectedVideoType(
  detected: VideoType | undefined
): SelectedVideoType | undefined {
  switch (detected) {
    case "vertical-short":
      return "reels-shorts";
    case "talking-tutorial":
      return "talking-head";
    case "saas-demo":
      return "product-demo";
    case "onboarding-flow":
      return "screen-recording";
    case "coding-tutorial":
    case "presentation":
      return "tutorial";
    default:
      return undefined;
  }
}

/**
 * Every edit operation Framevo can plan. `cut` / `zoom` / `speed` are IMPLEMENTED
 * today (the current timeline engines); the rest are PLANNED — declared here so
 * recipes are complete and executors can be added incrementally. Extend by
 * adding a member here + a default op in the recipes; nothing else changes.
 */
export type EditOperationCategory =
  | "cut"
  | "zoom"
  | "speed"
  | "captions"
  | "smart_crop"
  | "text_overlay"
  | "hook_text"
  | "transition"
  | "silence_removal"
  | "audio_cleanup"
  | "freeze_frame"
  | "blur_redaction"
  | "branding"
  | "callout"
  | "music"
  | "broll_overlay";

/** Short display labels for each category (shared by the server + the UI summary). */
export const CATEGORY_LABELS: Record<EditOperationCategory, string> = {
  cut: "Cuts",
  zoom: "Zooms",
  speed: "Speed",
  captions: "Captions",
  smart_crop: "Smart Crop",
  text_overlay: "Text Overlays",
  hook_text: "Hook Text",
  transition: "Transitions",
  silence_removal: "Silence Removal",
  audio_cleanup: "Audio Cleanup",
  freeze_frame: "Freeze Frames",
  blur_redaction: "Blur / Redaction",
  branding: "Branding",
  callout: "Callouts",
  music: "Music",
  broll_overlay: "B-roll",
};

/**
 * Categories with a working timeline executor TODAY — they render + export.
 * Phase 3 promoted the Core AI Edit Pack: hook_text / text_overlay / callout /
 * branding / smart_crop / transition now have real generators + renderers.
 *
 * Still PLANNED: `captions` (needs a transcript pipeline — never faked),
 * `blur_redaction` (renders + is manually addable, but has no reliable
 * auto-detector so it is not auto-generated), and the audio / b-roll / freeze
 * categories (no executor yet).
 */
export const IMPLEMENTED_CATEGORIES: ReadonlySet<EditOperationCategory> = new Set([
  "cut",
  "zoom",
  "speed",
  "hook_text",
  "text_overlay",
  "callout",
  "branding",
  "smart_crop",
  "transition",
  // Phase 4 — real transcript-driven captions (only fire when a transcript exists).
  "captions",
]);

/**
 * Map an edit-recipe category onto the timeline `effectType` its executor emits.
 * `null` = no per-moment overlay (cut/zoom/speed are camera/timing; smart_crop
 * is applied via the output canvas, not a moment). Used by the overlay
 * generators + the UI's honest "applied" counting.
 */
export function categoryToEffectType(
  category: EditOperationCategory
): "hook-text" | "text-overlay" | "callout" | "branding-cta" | "transition" | "captions" | "blur-redaction" | null {
  switch (category) {
    case "hook_text":
      return "hook-text";
    case "text_overlay":
      return "text-overlay";
    case "callout":
      return "callout";
    case "branding":
      return "branding-cta";
    case "transition":
      return "transition";
    case "captions":
      return "captions";
    case "blur_redaction":
      return "blur-redaction";
    default:
      return null;
  }
}

/**
 * One planned edit. `params` is a deliberately-open bag so a future edit can
 * carry its own tuning (aspect ratio, aggressiveness, text kind, …) without a
 * type change here. `planned` = no executor yet (declared for the roadmap).
 */
export interface EditOperation {
  category: EditOperationCategory;
  /** Whether this op is part of the plan for THIS run (after signal resolution). */
  enabled: boolean;
  /** Relative importance for ordering / budgeting when executed (0..1). */
  priority: number;
  /** Category-specific tuning — free-form for extensibility. */
  params?: Record<string, unknown>;
  /** Why this op is on/off — surfaced in debug logs + (future) the UI. */
  reason?: string;
  /** True when no executor exists yet — the op is declared, not applied. */
  planned: boolean;
}

/** A default recipe for a video type (before signal-based resolution). */
export interface EditRecipe {
  videoType: SelectedVideoType;
  /** Human name, e.g. "Reels / Shorts". */
  name: string;
  /** One-line editorial intent. */
  summary: string;
  operations: EditOperation[];
}

/**
 * The resolved plan the engine returns — the recipe adapted to the signals
 * actually available for this project. Structured; never touches the timeline.
 */
export interface EditRecipePlan {
  /** What the user chose. */
  requestedVideoType: SelectedVideoType;
  /** The concrete type the recipe was built for (Auto → detected type). */
  effectiveVideoType: SelectedVideoType;
  recipeName: string;
  summary: string;
  operations: EditOperation[];
  enabledCategories: EditOperationCategory[];
  disabledCategories: EditOperationCategory[];
  /** category → reason it's on/off (debug + transparency). */
  reasons: Record<string, string>;
}

/** Signals the recipe engine consults to decide what's actually feasible. */
export interface RecipeSignals {
  /** A REAL transcript is available (captions / spoken-text overlays need it). */
  hasTranscript: boolean;
  /** Audio/silence analysis ran (silence removal / audio cleanup feasibility). */
  hasAudioAnalysis: boolean;
  /** The audio analysis found usable speech (gates captions relevance + silence removal). */
  hasUsableSpeech: boolean;
  /** How many silence segments the audio analysis found (silence-removal candidates). */
  silenceSegmentCount: number;
  /** Detected transcript language (BCP-47), when known. */
  transcriptLanguage?: string;
  /** Scene-change data is available (beat cuts / transitions land better). */
  hasSceneData: boolean;
  /** Visual moments / CV data is available (zoom + callout targets). */
  hasVisualMoments: boolean;
  /** Cursor / click interaction data is available (cursor emphasis). */
  hasInteractionData: boolean;
  /** The source is a screen recording (cursor emphasis, blur redaction). */
  isScreenRecording: boolean;
  durationSeconds?: number;
}

export interface RecipeInput {
  selectedVideoType: SelectedVideoType;
  /** The AI's detected type — used to pick a concrete recipe when the user chose Auto. */
  detectedVideoType?: VideoType;
  signals: RecipeSignals;
}

// ── Default recipes ─────────────────────────────────────────────────────────

function op(
  category: EditOperationCategory,
  priority: number,
  params?: Record<string, unknown>,
  reason?: string
): EditOperation {
  return {
    category,
    enabled: true,
    priority,
    ...(params ? { params } : {}),
    ...(reason ? { reason } : {}),
    planned: !IMPLEMENTED_CATEGORIES.has(category),
  };
}

/**
 * A default edit recipe for every video type. "auto" is the general fallback.
 *
 * For the IMPLEMENTED categories (cut/zoom/speed) each op carries an
 * `intensity` (0..1, 0.5 = baseline behavior) that the generation engines
 * consume — higher = more aggressive/denser, lower = subtler/sparser. A category
 * that a type shouldn't use is simply OMITTED (→ disabled). e.g. Podcast + Vlog
 * have no `zoom` op, so zoom is off for them; Talking Head keeps speed low.
 */
export const DEFAULT_RECIPES: Record<SelectedVideoType, EditRecipe> = {
  auto: {
    videoType: "auto",
    name: "Auto",
    summary: "Balanced first-draft edit — cuts, zooms, and speed on the detected content.",
    operations: [
      op("cut", 0.8, { style: "clean", intensity: 0.5 }),
      op("zoom", 0.7, { intensity: 0.5 }),
      op("speed", 0.6, { intensity: 0.5 }),
      op("captions", 0.6),
      op("smart_crop", 0.4),
    ],
  },
  "reels-shorts": {
    videoType: "reels-shorts",
    name: "Reels / Shorts",
    summary: "Fast, punchy social edit for vertical feeds.",
    operations: [
      op("cut", 0.95, { style: "aggressive", intensity: 0.9 }, "Aggressive cuts keep a vertical feed edit fast."),
      op("silence_removal", 0.9),
      op("captions", 0.9, { style: "burned-in" }),
      op("smart_crop", 0.9, { aspect: "9:16" }),
      op("hook_text", 0.85),
      op("zoom", 0.7, { style: "punch-in", intensity: 0.8 }, "Punch-in zooms emphasize high-attention moments."),
      op("speed", 0.65, { style: "ramp", intensity: 0.7 }, "Short speed-ups compress the slow parts."),
      op("transition", 0.6, { style: "quick" }),
      op("text_overlay", 0.7, { kind: "cta" }),
    ],
  },
  "talking-head": {
    videoType: "talking-head",
    name: "Talking Head",
    summary: "Tighten a single speaker: trim dead air, keep them centered.",
    operations: [
      op("silence_removal", 0.9),
      op("cut", 0.8, { style: "jump", intensity: 0.55 }, "Clean jump cuts tighten the delivery."),
      op("captions", 0.85),
      op("hook_text", 0.6, {}, "A short title/hook for the opening line."),
      op("smart_crop", 0.85, { focus: "face" }),
      op("zoom", 0.5, { style: "subtle", intensity: 0.3 }, "Subtle zooms keep the speaker centered without distraction."),
      op("speed", 0.3, { intensity: 0.25 }, "Minimal speed changes — avoid distracting the viewer."),
      op("audio_cleanup", 0.75),
    ],
  },
  "podcast-clip": {
    videoType: "podcast-clip",
    name: "Podcast Clip",
    summary: "Pull the best moments from a long conversation as shareable clips.",
    operations: [
      op("cut", 0.85, { style: "best-moments", multiClip: true, intensity: 0.5 }, "Cuts follow the strongest conversation moments."),
      op("silence_removal", 0.8),
      op("captions", 0.9),
      op("text_overlay", 0.8, { kind: "headline" }),
      op("smart_crop", 0.7, { focus: "speaker" }),
      op("speed", 0.35, { intensity: 0.3 }, "Light trimming only — avoid flashy speed edits."),
      op("branding", 0.55, { kind: "cta" }, "Simple end-card CTA."),
      op("audio_cleanup", 0.6),
      // No `zoom` → zoom is disabled for podcasts (fewer, non-flashy edits).
    ],
  },
  "product-demo": {
    videoType: "product-demo",
    name: "Product Demo",
    summary: "Guide the eye through a walkthrough: zoom the action, label it, keep it clean.",
    operations: [
      op("zoom", 0.85, { target: "actions", intensity: 0.85 }, "Zooms are the star — emphasize each important action."),
      op("callout", 0.8, { kind: "cursor-highlight" }),
      op("text_overlay", 0.7, { kind: "labels" }),
      op("captions", 0.6),
      op("cut", 0.7, { style: "clean", intensity: 0.55 }, "Clean cuts remove waiting / loading."),
      op("speed", 0.6, { target: "waiting", intensity: 0.6 }, "Compress slow / loading stretches."),
      op("text_overlay", 0.6, { kind: "cta" }),
    ],
  },
  tutorial: {
    videoType: "tutorial",
    name: "Tutorial / Educational",
    summary: "Structured teaching: chapters, key points, and focus on each step.",
    operations: [
      op("text_overlay", 0.75, { kind: "chapters" }),
      op("captions", 0.85),
      op("text_overlay", 0.7, { kind: "key-point" }),
      op("zoom", 0.7, { intensity: 0.6 }, "Zooms focus the viewer on the current explanation."),
      op("cut", 0.5, { style: "gentle", intensity: 0.35 }, "Gentle cuts — preserve clarity, avoid over-cutting."),
      op("speed", 0.35, { intensity: 0.3 }, "Minimal speed changes — keep steps easy to follow."),
      op("freeze_frame", 0.55),
      op("callout", 0.7),
    ],
  },
  vlog: {
    videoType: "vlog",
    name: "Vlog / Lifestyle",
    summary: "Cinematic story pacing — beat cuts, ramps, music.",
    operations: [
      op("cut", 0.8, { style: "beat", intensity: 0.7 }, "Beat-driven cuts carry the story pacing."),
      op("speed", 0.7, { style: "ramp", intensity: 0.7 }, "Speed ramps for energy over slow stretches."),
      op("transition", 0.7),
      op("music", 0.6),
      op("smart_crop", 0.55, { style: "cinematic" }),
      // No `zoom` → avoid screen-recording-style zoom behavior for lifestyle video.
    ],
  },
  "ad-promo": {
    videoType: "ad-promo",
    name: "Ad / Promo",
    summary: "Hook fast, highlight the product, drive the CTA, brand it.",
    operations: [
      op("hook_text", 0.9),
      op("cut", 0.9, { style: "fast", intensity: 0.9 }, "Fast cuts keep a promo punchy."),
      op("zoom", 0.8, { target: "product-highlights", intensity: 0.8 }, "Punchy zooms highlight the product."),
      op("smart_crop", 0.8, { aspect: "9:16" }, "Vertical 9:16 crop for social feeds."),
      op("captions", 0.8),
      op("speed", 0.6, { intensity: 0.6 }, "Tight pacing over slower moments."),
      op("transition", 0.7, { style: "quick" }, "Snappy transitions between beats."),
      op("text_overlay", 0.85, { kind: "cta" }),
      op("branding", 0.7, { kind: "logo" }),
    ],
  },
  "screen-recording": {
    videoType: "screen-recording",
    name: "Screen Recording",
    summary: "Software workflow: cinematic zooms, cursor/click emphasis, redact + trim.",
    operations: [
      op("zoom", 0.85, { intensity: 0.85 }, "Strong cinematic zooms on the important interactions."),
      op("callout", 0.8, { kind: "cursor-click" }),
      op("text_overlay", 0.6, { kind: "labels" }),
      op("captions", 0.5),
      op("blur_redaction", 0.7),
      op("cut", 0.7, { style: "clean", intensity: 0.5 }, "Clean cuts on dead sections."),
      op("speed", 0.7, { target: "idle", intensity: 0.6 }, "Speed up waiting / loading."),
    ],
  },
};

// ── Per-type generation defaults (drives the Analyze modal) ──────────────────

/**
 * The auto-generation toggles shown in the "What should Framevo generate?"
 * modal — ONLY the IMPLEMENTED automatic edit types (blur/audio are excluded:
 * blur is manual-only, audio has no executor). Keys match `AnalysisOptions`.
 */
export interface GenerationToggles {
  /** Zooms & focus (zoom / click-highlight / cursor-focus). */
  generateCameraEdits: boolean;
  generateCut: boolean;
  generateSpeed: boolean;
  generateCaptions: boolean;
  generateHookText: boolean;
  generateTextOverlays: boolean;
  generateSmartCrop: boolean;
  generateCallouts: boolean;
  generateTransitions: boolean;
  generateCta: boolean;
}

/** Ordered toggle keys — the single list the modal + tests iterate over. */
export const GENERATION_TOGGLE_KEYS: (keyof GenerationToggles)[] = [
  "generateCameraEdits",
  "generateCut",
  "generateSpeed",
  "generateCaptions",
  "generateHookText",
  "generateTextOverlays",
  "generateSmartCrop",
  "generateCallouts",
  "generateTransitions",
  "generateCta",
];

/**
 * Smart defaults for a video type: ON for every implemented category the type's
 * recipe includes. `captions` defaults ON where the recipe wants speech text —
 * it's still skipped at runtime when no transcript exists (honest, never faked).
 */
export function recipeGenerationDefaults(videoType: SelectedVideoType): GenerationToggles {
  // Auto Detect: be PERMISSIVE. The concrete type isn't known until analysis
  // resolves the DETECTED recipe, so pre-suppressing overlays here would wrongly
  // hide edits the detected recipe wants (e.g. Auto → Reels losing hook/CTA/
  // transitions). All-on lets the resolved recipe decide — it still gates by type
  // (an enabled toggle can't force a category the recipe doesn't include).
  if (videoType === "auto") {
    return {
      generateCameraEdits: true,
      generateCut: true,
      generateSpeed: true,
      generateCaptions: true,
      generateHookText: true,
      generateTextOverlays: true,
      generateSmartCrop: true,
      generateCallouts: true,
      generateTransitions: true,
      generateCta: true,
    };
  }
  const recipe = DEFAULT_RECIPES[videoType] ?? DEFAULT_RECIPES.auto;
  const has = (c: EditOperationCategory) => recipe.operations.some((o) => o.category === c);
  const hasCta =
    has("branding") ||
    recipe.operations.some((o) => o.category === "text_overlay" && o.params?.kind === "cta");
  return {
    generateCameraEdits: has("zoom"),
    generateCut: has("cut"),
    generateSpeed: has("speed"),
    generateCaptions: has("captions"),
    generateHookText: has("hook_text"),
    generateTextOverlays: has("text_overlay"),
    generateSmartCrop: has("smart_crop"),
    generateCallouts: has("callout"),
    generateTransitions: has("transition"),
    generateCta: hasCta,
  };
}

/** The 3 core-engine toggle keys (persisted per-user); overlays default per type. */
export type CoreGenerationPrefs = Pick<
  GenerationToggles,
  "generateCameraEdits" | "generateCut" | "generateSpeed"
>;

/**
 * The Analyze modal's STARTING toggle state. Core engines: last run → remembered
 * user prefs → recipe default. Overlays: last run → recipe default (they're
 * type-driven, not globally remembered). This is what makes Re-analyze respect
 * what the user turned off, while a fresh run follows the video-type recipe.
 */
export function resolveInitialGenerationToggles(input: {
  recipeDefaults: GenerationToggles;
  lastRun?: Partial<GenerationToggles> | null;
  corePrefs?: Partial<CoreGenerationPrefs> | null;
}): GenerationToggles {
  const { recipeDefaults, lastRun, corePrefs } = input;
  const core = (k: keyof CoreGenerationPrefs): boolean =>
    lastRun?.[k] ?? corePrefs?.[k] ?? recipeDefaults[k];
  const overlay = (k: keyof GenerationToggles): boolean => lastRun?.[k] ?? recipeDefaults[k];
  return {
    generateCameraEdits: core("generateCameraEdits"),
    generateCut: core("generateCut"),
    generateSpeed: core("generateSpeed"),
    generateCaptions: overlay("generateCaptions"),
    generateHookText: overlay("generateHookText"),
    generateTextOverlays: overlay("generateTextOverlays"),
    generateSmartCrop: overlay("generateSmartCrop"),
    generateCallouts: overlay("generateCallouts"),
    generateTransitions: overlay("generateTransitions"),
    generateCta: overlay("generateCta"),
  };
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Signals a category REQUIRES to be feasible. Missing → the op is disabled with a
 * reason. Categories not listed have no hard prerequisite (always feasible/planned).
 */
function unmetRequirement(
  category: EditOperationCategory,
  s: RecipeSignals
): string | null {
  switch (category) {
    case "captions":
      return s.hasTranscript ? null : "no transcript available yet";
    case "silence_removal":
      // Needs REAL usable speech + detected silence to remove.
      return s.hasUsableSpeech && s.silenceSegmentCount > 0
        ? null
        : "no removable silence detected yet";
    case "audio_cleanup":
      // Planned category — no executor yet; only "feasible" once audio ran.
      return s.hasAudioAnalysis ? null : "no audio analysis available yet";
    case "blur_redaction":
      return s.isScreenRecording ? null : "only for screen recordings";
    case "callout":
      return s.isScreenRecording || s.hasInteractionData
        ? null
        : "needs screen-recording / cursor data";
    default:
      return null;
  }
}

/**
 * Build the concrete edit plan for a project. Picks the recipe for the selected
 * type (Auto → the AI-detected type), then disables ops whose required signal is
 * missing — so the plan reflects what's actually feasible for THIS video. Pure:
 * returns a structured plan, never mutates the timeline.
 */
export function resolveEditRecipe(input: RecipeInput): EditRecipePlan {
  const { selectedVideoType, detectedVideoType, signals } = input;

  // Auto → use the AI-detected type's recipe when we have one, else the general
  // "auto" recipe.
  const effectiveVideoType: SelectedVideoType =
    selectedVideoType !== "auto"
      ? selectedVideoType
      : detectedToSelectedVideoType(detectedVideoType) ?? "auto";

  const recipe = DEFAULT_RECIPES[effectiveVideoType] ?? DEFAULT_RECIPES.auto;

  const reasons: Record<string, string> = {};
  const operations = recipe.operations.map((base): EditOperation => {
    const unmet = unmetRequirement(base.category, signals);
    const enabled = unmet === null;
    const reason = enabled
      ? base.reason ?? `part of the ${recipe.name} recipe`
      : unmet;
    reasons[base.category] = reason;
    return { ...base, enabled, reason };
  });

  const enabledCategories = operations.filter((o) => o.enabled).map((o) => o.category);
  const disabledCategories = operations.filter((o) => !o.enabled).map((o) => o.category);

  const plan: EditRecipePlan = {
    requestedVideoType: selectedVideoType,
    effectiveVideoType,
    recipeName: recipe.name,
    summary: recipe.summary,
    operations,
    enabledCategories,
    disabledCategories,
    reasons,
  };
  return plan;
}

/**
 * Debug log for a resolved plan: selected type, chosen recipe, enabled/disabled
 * categories, and the reason for each decision. One structured line so a recipe
 * decision is fully explainable from the console alone.
 */
export function logEditRecipePlan(
  plan: EditRecipePlan,
  extra?: Record<string, unknown>
): void {
  console.info("[edit-recipe]", {
    requestedVideoType: plan.requestedVideoType,
    effectiveVideoType: plan.effectiveVideoType,
    recipe: plan.recipeName,
    enabled: plan.enabledCategories,
    disabled: plan.disabledCategories,
    reasons: plan.reasons,
    ...extra,
  });
}

// ── Generation controls (drives the real cut / zoom / speed engines) ─────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Per-implemented-category control the generation engines consume. */
export interface CategoryControl {
  /** Whether to generate this category at all. */
  enabled: boolean;
  /** Intensity 0..1 — 0.5 = baseline (current) behavior; higher = more
   *  aggressive/denser, lower = subtler/sparser. */
  intensity: number;
  reason: string;
}

/** The concrete knobs the orchestrator + cut/zoom/speed engines read for a run. */
export interface EditGenerationControls {
  requestedVideoType: SelectedVideoType;
  effectiveVideoType: SelectedVideoType;
  recipeName: string;
  cut: CategoryControl;
  zoom: CategoryControl;
  speed: CategoryControl;
  /** False when derived from a missing plan (baseline / old behavior). */
  fromRecipe: boolean;
}

const BASELINE_INTENSITY = 0.5;

/**
 * Reduce a recipe plan to the gate + intensity knobs the IMPLEMENTED engines
 * (cut/zoom/speed) consume. A category is enabled only if the plan has an
 * enabled op for it; its intensity comes from `params.intensity` (default 0.5).
 *
 * FALLBACK: a missing plan → baseline controls (all enabled, intensity 0.5) so
 * existing projects / the no-recipe path behave EXACTLY as before.
 */
export function editGenerationControls(
  plan: EditRecipePlan | null | undefined
): EditGenerationControls {
  if (!plan) {
    const baseline = (reason: string): CategoryControl => ({
      enabled: true,
      intensity: BASELINE_INTENSITY,
      reason,
    });
    return {
      requestedVideoType: "auto",
      effectiveVideoType: "auto",
      recipeName: "Default",
      cut: baseline("no recipe — baseline cuts"),
      zoom: baseline("no recipe — baseline zooms"),
      speed: baseline("no recipe — baseline speed"),
      fromRecipe: false,
    };
  }

  const control = (category: EditOperationCategory): CategoryControl => {
    const found = plan.operations.find((o) => o.category === category);
    if (!found || !found.enabled) {
      return {
        enabled: false,
        intensity: 0,
        reason: found
          ? found.reason ?? "disabled by recipe"
          : `not part of the ${plan.recipeName} recipe`,
      };
    }
    const raw = found.params?.intensity;
    const intensity = typeof raw === "number" ? clamp01(raw) : BASELINE_INTENSITY;
    return { enabled: true, intensity, reason: found.reason ?? `${plan.recipeName} recipe` };
  };

  return {
    requestedVideoType: plan.requestedVideoType,
    effectiveVideoType: plan.effectiveVideoType,
    recipeName: plan.recipeName,
    cut: control("cut"),
    zoom: control("zoom"),
    speed: control("speed"),
    fromRecipe: true,
  };
}

/** True when the recipe would generate NO implemented edits (fallback trigger). */
export function disablesAllImplementedEdits(c: EditGenerationControls): boolean {
  return !c.cut.enabled && !c.zoom.enabled && !c.speed.enabled;
}
