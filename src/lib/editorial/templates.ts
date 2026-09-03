/**
 * Editing templates — editorial behaviour as data.
 *
 * A template answers, per edit category: is it allowed here, how eager should
 * generation be, how sure must it be, how often, how far apart, how strong.
 * Visual styling rides along but is the minor part.
 *
 * Phase 1 ships exactly TWO kinds:
 *
 *   • CLASSIC — one per legacy SelectedVideoType. A Classic template is a
 *     MARKER, not a behaviour spec: resolving it yields `mode: "classic"`,
 *     under which every engine uses the pre-Editorial-Engine constants and
 *     Gate D is a no-op (approved clarification #3). `tests/classic-parity`
 *     proves a Classic run is bit-identical to the pre-policy pipeline.
 *
 *   • TALKING HEAD / CLEAN PROFESSIONAL — the one real quality proof required
 *     by Phase 1: tight delivery, nothing decorative, the edit disappears.
 *
 * UI honesty (approved clarification: no planned-feature exposure): a
 * template's user-visible capabilities come from `templateCapabilities()`,
 * which only ever returns categories whose executors exist. The policy schema
 * may anticipate music/B-roll/etc.; the UI may not promise them.
 *
 * Pure data. Frozen. No I/O.
 */
import type { Pacing, SelectedVideoType } from "@/lib/firebase/schema";
import type { DirectorPlatform } from "@/lib/director/types";
import {
  IMPLEMENTED_CATEGORIES,
  type EditOperationCategory,
} from "@/lib/analysis/edit-recipe";
import { dominantMode, type ContentMode, type ContentProfile, type PrimaryIntent } from "./context";
import type {
  CompositionPolicy,
  DensityPolicy,
  EditCategoryId,
  EditPolicy,
  OverlayPolicy,
} from "./policy";

export type EditingFamilyId = "talking" | "screencast" | "promo" | "general";

/** Which contexts a template is offered for (evaluated on ContentProfile). */
export interface TemplateSelector {
  intents?: readonly PrimaryIntent[];
  dominantModes?: readonly ContentMode[];
  targets?: readonly DirectorPlatform[];
}

/** The behaviour spec an "enforce" template carries. */
export interface TemplateSpec {
  pacing?: Pacing;
  /**
   * Per-category policies. OMISSION MEANS DISABLED — exactly the rule the
   * recipes have always used ("Podcast has no zoom op, so zoom is off").
   */
  edits: Partial<Record<EditCategoryId, EditPolicy>>;
  density: DensityPolicy;
  composition: Omit<CompositionPolicy, "mode">;
  /** Overrides of the overlay generators' caps (absent = Classic caps). */
  overlays?: Partial<OverlayPolicy>;
}

export interface EditingTemplate {
  id: string;
  version: number;
  family: EditingFamilyId;
  name: string;
  /** One editorial sentence — what this template believes. */
  description: string;
  appliesTo: TemplateSelector;
  /** Present on Classic templates: reproduce this legacy type's shipped behaviour. */
  classicFor?: SelectedVideoType;
  /** Present on enforce templates: the behaviour spec. */
  spec?: TemplateSpec;
}

// ── Classic templates (compatibility anchors) ───────────────────────────────

const CLASSIC_FAMILY: Record<SelectedVideoType, EditingFamilyId> = {
  auto: "general",
  "reels-shorts": "promo",
  "talking-head": "talking",
  "podcast-clip": "talking",
  "product-demo": "screencast",
  tutorial: "screencast",
  vlog: "talking",
  "ad-promo": "promo",
  "screen-recording": "screencast",
};

export function classicTemplateIdFor(t: SelectedVideoType): string {
  return `classic-${t}`;
}

function classicTemplate(t: SelectedVideoType): EditingTemplate {
  return Object.freeze({
    id: classicTemplateIdFor(t),
    version: 1,
    family: CLASSIC_FAMILY[t],
    name: "Classic",
    description:
      "Framevo's original behaviour for this video type — the compatibility anchor.",
    appliesTo: {},
    classicFor: t,
  });
}

// ── Talking Head / Clean Professional — the Phase-1 quality proof ───────────

/**
 * Tight delivery, nothing decorative. Captions and dead-air cuts carry the
 * edit; zooms are rare, confident and widely spaced; cursor emphasis, speed
 * ramps, transitions and callouts do not exist here. Zero edits is a valid,
 * common outcome.
 */
export const TALKING_CLEAN_PRO: EditingTemplate = Object.freeze<EditingTemplate>({
  id: "talking-clean-pro",
  version: 1,
  family: "talking" as const,
  name: "Clean Professional",
  description: "Tight, credible delivery — the edit disappears.",
  appliesTo: {
    dominantModes: ["camera"] as const,
    intents: ["conversation", "story", "unknown"] as const,
  },
  spec: {
    pacing: "slow" as Pacing,
    edits: {
      // Pacing carries the edit.
      cut: { status: "encouraged", priority: 0.85, intensity: 0.55 },
      silence_removal: { status: "encouraged", priority: 0.9 },
      // Captions are an intent (analysis never runs ASR); recorded + reported.
      captions: { status: "encouraged", priority: 0.85 },
      // Zooms: rare, confident, widely spaced, subtle.
      zoom: {
        status: "allowed",
        priority: 0.5,
        minConfidence: 0.65,
        maxPerMinute: 1.5,
        minSpacingSec: 12,
        intensity: 0.3,
      },
      // Structure: one opening hook, one closing CTA — nothing else.
      hook_text: { status: "allowed", priority: 0.6, maxTotal: 1 },
      branding: { status: "allowed", priority: 0.55, maxTotal: 1 },
      smart_crop: { status: "allowed", priority: 0.6, params: { focus: "face" } },
      // EVERYTHING ELSE IS OMITTED = disabled. Notably: cursor_emphasis,
      // speed, transition, callout, text_overlay, blur_redaction.
    },
    density: {
      minTotal: 0, // silence is a valid edit
      maxTotal: 12,
      crossDensity: { windowS: 10, maxInWindow: 2 },
    },
    composition: {
      zoom: { minGapSeconds: 12, maxPerOutputMinute: 1.5 },
      cluster: { windowS: 8, maxInWindow: 2 },
      overlapEmphasis: true,
    },
  },
});

// ── The Phase-2 template set ────────────────────────────────────────────────
// Editorial behaviour as data, one card per editing outcome. Numbers follow
// the approved proposal (§G): budgets are ceilings, minTotal 0 everywhere —
// "no edit" stays a valid outcome — and every spec stays inside the category
// matrix (cursor emphasis only where screen content can exist). Planned
// categories (music, B-roll, freeze-frame, audio cleanup) are OMITTED from
// every spec: the schema anticipates them, but a template must never advertise
// a capability without an executor (templateCapabilities pins this).

export const TALKING_HIGH_ENERGY: EditingTemplate = Object.freeze<EditingTemplate>({
  id: "talking-high-energy",
  version: 1,
  family: "talking",
  name: "High Energy",
  description: "Social-paced delivery — faster cuts, bolder captions, justified punch-ins.",
  appliesTo: {
    dominantModes: ["camera"] as const,
    intents: ["conversation", "story", "promo", "unknown"] as const,
  },
  spec: {
    pacing: "fast" as Pacing,
    edits: {
      cut: { status: "encouraged", priority: 0.9, intensity: 0.8 },
      silence_removal: { status: "encouraged", priority: 0.9 },
      captions: { status: "encouraged", priority: 0.9 },
      zoom: {
        status: "encouraged",
        priority: 0.7,
        minConfidence: 0.5,
        maxPerMinute: 4,
        minSpacingSec: 6,
        intensity: 0.7,
      },
      hook_text: { status: "encouraged", priority: 0.85, maxTotal: 1 },
      text_overlay: { status: "allowed", priority: 0.6, maxPerMinute: 2 },
      transition: { status: "allowed", priority: 0.5, maxTotal: 4 },
      branding: { status: "allowed", priority: 0.6, maxTotal: 1 },
      smart_crop: { status: "allowed", priority: 0.6 },
    },
    density: { minTotal: 0, maxTotal: 20, crossDensity: { windowS: 8, maxInWindow: 3 } },
    composition: {
      zoom: { minGapSeconds: 6, maxPerOutputMinute: 4 },
      cluster: { windowS: 6, maxInWindow: 3 },
      overlapEmphasis: true,
    },
  },
});

export const TALKING_MINIMAL: EditingTemplate = Object.freeze<EditingTemplate>({
  id: "talking-minimal",
  version: 1,
  family: "talking",
  name: "Minimal",
  description: "Captions and dead-air cuts only — nothing moves but the words.",
  appliesTo: {
    dominantModes: ["camera"] as const,
    intents: ["conversation", "story", "tutorial", "unknown"] as const,
  },
  spec: {
    pacing: "slow" as Pacing,
    edits: {
      cut: { status: "encouraged", priority: 0.85, intensity: 0.5 },
      silence_removal: { status: "encouraged", priority: 0.9 },
      captions: { status: "encouraged", priority: 0.9 },
    },
    density: { minTotal: 0, maxTotal: 10 },
    composition: { cluster: { windowS: 10, maxInWindow: 2 }, overlapEmphasis: true },
  },
});

export const SCREEN_PRO_DEMO: EditingTemplate = Object.freeze<EditingTemplate>({
  id: "screen-pro-demo",
  version: 1,
  family: "screencast",
  name: "Professional Demo",
  description: "Guide the eye through the workflow — restrained everything else.",
  appliesTo: {
    dominantModes: ["screen"] as const,
    intents: ["demo", "tutorial", "unknown"] as const,
  },
  spec: {
    pacing: "moderate" as Pacing,
    edits: {
      zoom: {
        status: "core",
        priority: 0.85,
        minConfidence: 0.5,
        maxPerMinute: 5,
        minSpacingSec: 4,
        intensity: 0.8,
      },
      cursor_emphasis: { status: "core", priority: 0.8, minConfidence: 0.55 },
      callout: { status: "allowed", priority: 0.65, maxPerMinute: 2, minConfidence: 0.6 },
      text_overlay: { status: "allowed", priority: 0.6, maxPerMinute: 2 },
      captions: { status: "allowed", priority: 0.5 },
      cut: { status: "encouraged", priority: 0.75, intensity: 0.55 },
      silence_removal: { status: "allowed", priority: 0.6 },
      speed: { status: "encouraged", priority: 0.7, intensity: 0.6 },
      blur_redaction: { status: "allowed", priority: 0.7 },
      hook_text: { status: "discouraged", priority: 0.4, minConfidence: 0.8, maxTotal: 1 },
      branding: { status: "allowed", priority: 0.5, maxTotal: 1 },
      smart_crop: { status: "allowed", priority: 0.5 },
    },
    density: { minTotal: 0, maxTotal: 24, crossDensity: { windowS: 8, maxInWindow: 3 } },
    composition: {
      zoom: { minGapSeconds: 4, maxPerOutputMinute: 5 },
      cluster: { windowS: 6, maxInWindow: 3 },
      overlapEmphasis: true,
    },
  },
});

export const TUTORIAL_CLEAR: EditingTemplate = Object.freeze<EditingTemplate>({
  id: "tutorial-step-clear",
  version: 1,
  family: "screencast",
  name: "Step-by-Step Clear",
  description: "Clear pacing, useful captions, contextual focus — never sacrifice comprehension.",
  appliesTo: { intents: ["tutorial", "unknown"] as const },
  spec: {
    pacing: "slow" as Pacing,
    edits: {
      captions: { status: "encouraged", priority: 0.9 },
      text_overlay: { status: "core", priority: 0.8, maxPerMinute: 2 },
      zoom: {
        status: "encouraged",
        priority: 0.7,
        minConfidence: 0.55,
        maxPerMinute: 3,
        minSpacingSec: 5,
        intensity: 0.6,
      },
      cursor_emphasis: { status: "allowed", priority: 0.6, minConfidence: 0.6 },
      callout: { status: "allowed", priority: 0.65, maxPerMinute: 2, minConfidence: 0.6 },
      cut: { status: "allowed", priority: 0.55, intensity: 0.35 },
      silence_removal: { status: "encouraged", priority: 0.7 },
      branding: { status: "allowed", priority: 0.5, maxTotal: 1 },
      hook_text: { status: "allowed", priority: 0.55, maxTotal: 1 },
      smart_crop: { status: "disabled-by-default", priority: 0.4 },
    },
    density: { minTotal: 0, maxTotal: 20, crossDensity: { windowS: 10, maxInWindow: 3 } },
    composition: {
      zoom: { minGapSeconds: 5, maxPerOutputMinute: 3 },
      cluster: { windowS: 8, maxInWindow: 3 },
      overlapEmphasis: true,
    },
  },
});

export const PODCAST_CLIP_FACTORY: EditingTemplate = Object.freeze<EditingTemplate>({
  id: "podcast-clip-factory",
  version: 1,
  family: "talking",
  name: "Clip Factory",
  description: "Dead-air removal and captions — the conversation is the star.",
  appliesTo: {
    dominantModes: ["camera"] as const,
    intents: ["conversation", "unknown"] as const,
  },
  spec: {
    pacing: "slow" as Pacing,
    edits: {
      silence_removal: { status: "core", priority: 0.95 },
      cut: { status: "core", priority: 0.9, intensity: 0.5 },
      captions: { status: "encouraged", priority: 0.9 },
      text_overlay: { status: "allowed", priority: 0.5, maxTotal: 1 },
      smart_crop: { status: "encouraged", priority: 0.6, params: { focus: "speaker" } },
      branding: { status: "allowed", priority: 0.5, maxTotal: 1 },
    },
    density: { minTotal: 0, maxTotal: 12 },
    composition: { cluster: { windowS: 10, maxInWindow: 2 }, overlapEmphasis: true },
  },
});

export const VLOG_STORY: EditingTemplate = Object.freeze<EditingTemplate>({
  id: "vlog-story-driven",
  version: 1,
  family: "talking",
  name: "Story-Driven",
  description: "Beat cuts and movement — effects serve rhythm, not emphasis.",
  appliesTo: {
    dominantModes: ["camera"] as const,
    intents: ["story", "unknown"] as const,
  },
  spec: {
    pacing: "moderate" as Pacing,
    edits: {
      cut: { status: "core", priority: 0.9, intensity: 0.7 },
      speed: { status: "encouraged", priority: 0.7, intensity: 0.7 },
      transition: { status: "encouraged", priority: 0.7, maxPerMinute: 3 },
      smart_crop: { status: "allowed", priority: 0.5 },
      captions: { status: "allowed", priority: 0.5 },
      zoom: { status: "disabled-by-default", priority: 0.4, minConfidence: 0.75 },
      silence_removal: { status: "allowed", priority: 0.6 },
    },
    density: { minTotal: 0, maxTotal: 20, crossDensity: { windowS: 8, maxInWindow: 3 } },
    composition: { cluster: { windowS: 6, maxInWindow: 3 }, overlapEmphasis: true },
  },
});

export const PROMO_PUNCHY: EditingTemplate = Object.freeze<EditingTemplate>({
  id: "promo-punchy",
  version: 1,
  family: "promo",
  name: "Punchy Promo",
  description: "Hook → product → CTA. Every second earns attention.",
  appliesTo: { intents: ["promo", "unknown"] as const },
  spec: {
    pacing: "fast" as Pacing,
    edits: {
      hook_text: { status: "core", priority: 0.95, maxTotal: 1 },
      cut: { status: "core", priority: 0.9, intensity: 0.9 },
      zoom: {
        status: "encouraged",
        priority: 0.75,
        minConfidence: 0.5,
        maxPerMinute: 5,
        minSpacingSec: 4,
        intensity: 0.8,
      },
      captions: { status: "encouraged", priority: 0.85 },
      branding: { status: "core", priority: 0.9, maxTotal: 1 },
      transition: { status: "encouraged", priority: 0.6, maxTotal: 5 },
      speed: { status: "allowed", priority: 0.55, intensity: 0.6 },
      smart_crop: { status: "encouraged", priority: 0.7 },
      text_overlay: { status: "allowed", priority: 0.6, maxPerMinute: 2 },
      silence_removal: { status: "encouraged", priority: 0.8 },
    },
    density: { minTotal: 0, maxTotal: 24, crossDensity: { windowS: 6, maxInWindow: 3 } },
    composition: {
      zoom: { minGapSeconds: 4, maxPerOutputMinute: 5 },
      cluster: { windowS: 5, maxInWindow: 3 },
      overlapEmphasis: true,
    },
  },
});

// ── Registry ────────────────────────────────────────────────────────────────

const SELECTED_TYPES: SelectedVideoType[] = [
  "auto",
  "reels-shorts",
  "talking-head",
  "podcast-clip",
  "product-demo",
  "tutorial",
  "vlog",
  "ad-promo",
  "screen-recording",
];

const CLASSIC_TEMPLATES: EditingTemplate[] = SELECTED_TYPES.map(classicTemplate);

export const EDITING_TEMPLATES: readonly EditingTemplate[] = Object.freeze([
  ...CLASSIC_TEMPLATES,
  TALKING_CLEAN_PRO,
  TALKING_HIGH_ENERGY,
  TALKING_MINIMAL,
  SCREEN_PRO_DEMO,
  TUTORIAL_CLEAR,
  PODCAST_CLIP_FACTORY,
  VLOG_STORY,
  PROMO_PUNCHY,
]);

/**
 * The templates the setup surface offers for a profile. Unknown axes are
 * PERMISSIVE (an "auto" project sees every style; a declared talking head sees
 * talking styles) — the same "maybe, not no" rule the matrix uses. Classic
 * templates are not returned here; the caller offers Classic separately as the
 * compatibility choice.
 */
export function templatesForProfile(profile: ContentProfile): EditingTemplate[] {
  const dominant = dominantMode(profile);
  const modesKnown = profile.sources.modes !== "default";
  const intentKnown = profile.primaryIntent !== "unknown";

  return EDITING_TEMPLATES.filter((t) => {
    if (!t.spec) return false; // Classic handled by the caller
    const sel = t.appliesTo;
    const intentOk =
      !sel.intents || !intentKnown || sel.intents.includes(profile.primaryIntent);
    const modeOk =
      !sel.dominantModes || !modesKnown || sel.dominantModes.includes(dominant);
    return intentOk && modeOk;
  });
}

export function getTemplate(id: string | undefined | null): EditingTemplate | undefined {
  if (!id) return undefined;
  return EDITING_TEMPLATES.find((t) => t.id === id);
}

/** The template a run uses when none was chosen: Classic for the legacy type. */
export function defaultTemplateFor(t: SelectedVideoType): EditingTemplate {
  return getTemplate(classicTemplateIdFor(t)) ?? classicTemplate(t);
}

/**
 * The categories a template may ADVERTISE in UI — its generating categories
 * intersected with what actually executes today. `cursor_emphasis` rides the
 * camera engine (click-highlight / cursor-focus executors exist), so it maps
 * to the implemented `zoom` machinery for the check. A `planned`-only category
 * (music, broll_overlay, freeze_frame, audio_cleanup, …) can sit in a spec for
 * the future but never comes back from this function — which is exactly what
 * `tests/editorial-policy.test.ts` pins.
 */
export function templateCapabilities(template: EditingTemplate): EditCategoryId[] {
  if (!template.spec) return [];
  const out: EditCategoryId[] = [];
  for (const [category, policy] of Object.entries(template.spec.edits) as Array<
    [EditCategoryId, EditPolicy | undefined]
  >) {
    if (!policy) continue;
    if (policy.status === "disabled-by-default") continue;
    const implemented =
      category === "cursor_emphasis"
        ? IMPLEMENTED_CATEGORIES.has("zoom" as EditOperationCategory)
        : IMPLEMENTED_CATEGORIES.has(category as EditOperationCategory);
    if (implemented) out.push(category);
  }
  return out;
}
