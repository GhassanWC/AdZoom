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
import type { ContentMode, PrimaryIntent } from "./context";
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
]);

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
