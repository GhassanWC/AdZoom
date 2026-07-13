/**
 * Preset selection for the AI Director.
 *
 * The Director may reference a preset ONLY by an id that exists in the registry.
 * `resolveDirectorPreset` is the single gate: an unknown id is rejected and
 * REPORTED, never coerced into "something close" — a Director that silently
 * substitutes a different look is worse than one that says it couldn't find the
 * one it wanted.
 *
 * Selection is scored, not random, on the axes the brief names: video type,
 * platform, aspect ratio and tone. It is also DETERMINISTIC — the same request
 * against the same video picks the same presets, which is what makes the
 * Director's "re-run is idempotent" guarantee hold for presets too.
 *
 * Pure. No model call: choosing a look from a validated catalogue is a scoring
 * problem, and asking an LLM to pick from a list it could hallucinate outside of
 * is strictly worse than scoring the list ourselves.
 */
import type { SelectedVideoType } from "../firebase/schema";
import { getPreset, presetsByCategory } from "./registry";
import type {
  FramevoPreset,
  PresetAspect,
  PresetCategory,
  PresetTone,
} from "./types";

/** The Director's platform vocabulary → the tone a platform's audience expects. */
const PLATFORM_TONE: Record<string, PresetTone> = {
  tiktok: "energetic",
  reels: "energetic",
  shorts: "energetic",
  youtube: "professional",
  linkedin: "professional",
  x: "minimal",
  internal: "minimal",
};

/** Video type → the tone that suits the content. */
const VIDEO_TYPE_TONE: Partial<Record<SelectedVideoType, PresetTone>> = {
  "reels-shorts": "energetic",
  "ad-promo": "energetic",
  "product-demo": "professional",
  tutorial: "professional",
  "screen-recording": "minimal",
  "talking-head": "calm",
  "podcast-clip": "calm",
  vlog: "cinematic",
};

export interface PresetSelectionContext {
  category: PresetCategory;
  /** The Director's requested tone (from the style control / prompt). */
  tone?: PresetTone;
  platform?: string;
  aspect?: PresetAspect;
  videoType?: SelectedVideoType;
  /** Presets already chosen this run — avoids picking the same look twice. */
  exclude?: readonly string[];
}

/**
 * Score a preset against what the Director is trying to make.
 *
 * The tone axes are weighted highest because tone is the thing a viewer actually
 * perceives: an "energetic TikTok demo" with a calm, minimal caption preset reads
 * as wrong even if every other property is right.
 */
export function scorePreset(
  preset: FramevoPreset,
  ctx: PresetSelectionContext
): number {
  let score = 0.5;

  const requested = ctx.tone;
  const platformTone = ctx.platform ? PLATFORM_TONE[ctx.platform] : undefined;
  const typeTone = ctx.videoType ? VIDEO_TYPE_TONE[ctx.videoType] : undefined;

  // The explicit request dominates — the user chose this.
  if (requested) score += preset.tone === requested ? 0.35 : -0.1;
  // Then the platform's own idiom.
  if (platformTone) score += preset.tone === platformTone ? 0.18 : 0;
  // Then the content's nature.
  if (typeTone) score += preset.tone === typeTone ? 0.12 : 0;

  // A preset that explicitly declares an adaptation for this aspect was designed
  // with it in mind — prefer it over one that merely falls back to the defaults.
  if (ctx.aspect && preset.aspects?.[ctx.aspect]) score += 0.08;

  // Vertical feeds are hostile to fussy, low-contrast looks: the video is small,
  // it plays at arm's length, and the platform's UI competes with it. Presets
  // with a plate or a stroke survive that; bare thin text does not.
  if (ctx.aspect === "9:16") {
    const hasPlate =
      preset.textStyle.background === "pill" || preset.textStyle.background === "box";
    const hasStroke = (preset.textStyle.strokeWidth ?? 0) > 0;
    const heavy = (preset.textStyle.fontWeight ?? 400) >= 700;
    if (hasPlate || hasStroke || heavy) score += 0.06;
  }

  return score;
}

/**
 * Pick the best preset for a slot, or `null` when the category is empty.
 *
 * Ties break on id so the choice is stable across runs — a Director that picked
 * a different caption style on every identical re-run would make its own
 * idempotence guarantee a lie.
 */
export function selectPreset(ctx: PresetSelectionContext): FramevoPreset | null {
  const exclude = new Set(ctx.exclude ?? []);
  const pool = presetsByCategory(ctx.category).filter((p) => !exclude.has(p.id));
  if (!pool.length) return null;

  let best: FramevoPreset | null = null;
  let bestScore = -Infinity;
  for (const p of pool) {
    const s = scorePreset(p, ctx);
    if (s > bestScore || (s === bestScore && best && p.id < best.id)) {
      best = p;
      bestScore = s;
    }
  }
  return best;
}

/** Why a Director preset reference was refused. */
export type PresetRejection = "unknown_id" | "wrong_category";

export interface PresetResolution {
  preset: FramevoPreset | null;
  rejection?: PresetRejection;
  detail?: string;
}

/**
 * THE GATE. Resolve a preset id the Director asked for.
 *
 * An id that isn't in the registry is REJECTED with a reason the user can read.
 * We never fall back to a similar preset: the Director's plan is a contract, and
 * quietly delivering a different look than the one it promised is precisely the
 * kind of drift that makes an AI feature untrustworthy.
 */
export function resolveDirectorPreset(
  id: string,
  expectedCategory?: PresetCategory
): PresetResolution {
  const preset = getPreset(id);
  if (!preset) {
    return {
      preset: null,
      rejection: "unknown_id",
      detail: `"${id}" isn't a preset in Framevo's library, so nothing was applied for it.`,
    };
  }
  if (expectedCategory && preset.category !== expectedCategory) {
    return {
      preset: null,
      rejection: "wrong_category",
      detail: `"${id}" is a ${preset.category} preset, but a ${expectedCategory} preset was expected.`,
    };
  }
  return { preset };
}

/**
 * The full preset kit for a Director run — one pick per slot it can fill.
 *
 * Returns only the categories that genuinely apply: no CTA preset when the user
 * didn't ask for a CTA, no caption preset when there's no transcript to caption.
 * A kit entry is a COMMITMENT that the Director will apply that look.
 *
 * There is ONE slot per preset category, so every category in the library is
 * reachable by the Director. A category with no slot is a category the Director
 * can never choose — which is indistinguishable, from the user's side, from the
 * design not existing at all.
 */
export interface DirectorPresetKit {
  captions?: FramevoPreset;
  hook?: FramevoPreset;
  cta?: FramevoPreset;
  title?: FramevoPreset;
  callout?: FramevoPreset;
  transition?: FramevoPreset;
  intro?: FramevoPreset;
  outro?: FramevoPreset;
  textAnimation?: FramevoPreset;
}

/** Kit slot ⇄ registry category. The one place the mapping is stated. */
export const KIT_SLOT_CATEGORY: Record<keyof DirectorPresetKit, PresetCategory> = {
  captions: "captions",
  hook: "hooks",
  cta: "ctas",
  title: "titles",
  callout: "callouts",
  transition: "transitions",
  intro: "intros",
  outro: "outros",
  textAnimation: "text-animations",
};

export type DirectorPresetSlot = keyof DirectorPresetKit;

/** The inverse of `KIT_SLOT_CATEGORY`. Derived, so the two can never disagree. */
export const CATEGORY_SLOT: Record<PresetCategory, DirectorPresetSlot> = Object.freeze(
  Object.fromEntries(
    Object.entries(KIT_SLOT_CATEGORY).map(([slot, category]) => [category, slot])
  ) as Record<PresetCategory, DirectorPresetSlot>
);

/**
 * Which look a `text-overlay` edit should wear.
 *
 * `text-overlay` is one Framevo effect type but FOUR distinct design jobs, and
 * the library has a category for each. The story section the operation serves
 * tells us which job it is — an overlay in the hook is an intro card, an overlay
 * in the CTA section is an end card — so the choice is derived from the plan the
 * Director already committed to, never guessed and never asked of the model.
 *
 * A short overlay in the body of the video is an emphasis beat rather than a
 * title, which is exactly what the `text-animations` category is for.
 */
export const TEXT_ANIMATION_MAX_SECONDS = 2;

export function textOverlayCategory(input: {
  sectionKind?: string;
  durationSeconds: number;
}): PresetCategory {
  if (input.sectionKind === "hook") return "intros";
  if (input.sectionKind === "cta") return "outros";
  if (input.durationSeconds <= TEXT_ANIMATION_MAX_SECONDS) return "text-animations";
  return "titles";
}

export function selectPresetKit(input: {
  tone?: PresetTone;
  platform?: string;
  aspect?: PresetAspect;
  videoType?: SelectedVideoType;
  wantCaptions: boolean;
  wantHook: boolean;
  wantCta: boolean;
  wantTransitions: boolean;
  wantTitle?: boolean;
  wantCallout?: boolean;
  wantIntro?: boolean;
  wantOutro?: boolean;
  wantTextAnimation?: boolean;
  /**
   * Preset ids the plan named explicitly, per slot. Already resolved + validated
   * by the caller — an id that failed the gate must NOT reach here, so that a
   * rejected id falls back to the scorer rather than pinning a bad look.
   */
  pinned?: Partial<Record<DirectorPresetSlot, FramevoPreset>>;
}): DirectorPresetKit {
  const base = {
    tone: input.tone,
    platform: input.platform,
    aspect: input.aspect,
    videoType: input.videoType,
  };
  const kit: DirectorPresetKit = {};
  const used: string[] = [];

  const fill = (slot: DirectorPresetSlot, want: boolean | undefined) => {
    if (!want) return;
    // A validated, explicitly-requested preset always wins over the scorer: the
    // plan asked for this look by name and the id passed the registry gate.
    const pin = input.pinned?.[slot];
    if (pin) {
      kit[slot] = pin;
      used.push(pin.id);
      return;
    }
    const p = selectPreset({ ...base, category: KIT_SLOT_CATEGORY[slot], exclude: used });
    if (p) {
      kit[slot] = p;
      used.push(p.id);
    }
  };

  // Pinned slots first, so an explicitly-named preset is never excluded by a
  // scorer pick that happened to land on the same id earlier in the loop.
  const slots: DirectorPresetSlot[] = [
    "captions",
    "hook",
    "cta",
    "title",
    "callout",
    "transition",
    "intro",
    "outro",
    "textAnimation",
  ];
  const wants: Record<DirectorPresetSlot, boolean | undefined> = {
    captions: input.wantCaptions,
    hook: input.wantHook,
    cta: input.wantCta,
    title: input.wantTitle,
    callout: input.wantCallout,
    transition: input.wantTransitions,
    intro: input.wantIntro,
    outro: input.wantOutro,
    textAnimation: input.wantTextAnimation,
  };
  for (const slot of slots) if (input.pinned?.[slot]) fill(slot, wants[slot]);
  for (const slot of slots) if (!kit[slot]) fill(slot, wants[slot]);

  return kit;
}

/**
 * The catalogue handed to the planning model.
 *
 * The model does not get to describe a design in prose — it gets a list of ids
 * that exist and picks from it. That is the whole mechanism by which "the AI
 * invented a look we can't render" stops being possible: an id it did not read
 * here will not survive `resolveDirectorPreset`, and an id it did read here is
 * by construction renderable by every export path.
 *
 * Kept deliberately terse (id · name · tone · one line) — it is prompt budget,
 * and the model only needs enough to choose, not to redesign.
 */
export function presetCatalogueForModel(): string {
  const lines: string[] = [];
  for (const category of Object.values(KIT_SLOT_CATEGORY)) {
    const pool = presetsByCategory(category);
    if (!pool.length) continue;
    lines.push(`${category}:`);
    for (const p of pool) {
      lines.push(`  - ${p.id} · ${p.name} · ${p.tone} · ${p.description}`);
    }
  }
  return lines.join("\n");
}
