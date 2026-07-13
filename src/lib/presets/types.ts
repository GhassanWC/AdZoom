/**
 * Framevo preset library — the type system.
 *
 * A preset is DATA, not a component: a `TextStyle` (the existing shared styling
 * model), a `PresetAnimation` (the declarative motion model), a layout intent,
 * and enough metadata to browse and validate it. Applying one produces an
 * ordinary `DetectedMoment` on the ordinary timeline — so a preset is editable,
 * movable, splittable and deletable like anything else the user made, and it
 * renders through `overlay-draw.ts`, which preview and every export path share.
 *
 * There is no preset renderer, no preset preview path and no preset export path,
 * because a preset is not a new kind of edit — it is a well-designed
 * configuration of the edits Framevo already has.
 *
 * Pure types + frozen constants. No React, no I/O.
 */
import type { EffectType, TextStyle, TransitionStyle } from "../firebase/schema";
import type { PresetAnimation } from "./animation";

/** Bumped when the preset shape changes in a way applied presets can't replay. */
export const PRESET_SCHEMA_VERSION = 1;

/** Browse categories — the user's own list, in the order the browser shows them. */
export const PRESET_CATEGORIES = [
  "captions",
  "titles",
  "hooks",
  "ctas",
  "callouts",
  "transitions",
  "intros",
  "outros",
  "text-animations",
] as const;
export type PresetCategory = (typeof PRESET_CATEGORIES)[number];

export const PRESET_CATEGORY_LABEL: Record<PresetCategory, string> = {
  captions: "Captions",
  titles: "Titles",
  hooks: "Hooks",
  ctas: "CTAs",
  callouts: "Callouts",
  transitions: "Transitions",
  intros: "Intros",
  outros: "Outros",
  "text-animations": "Text animations",
};

/** The tone a preset reads as — the axis the AI Director selects on. */
export const PRESET_TONES = [
  "energetic",
  "professional",
  "calm",
  "cinematic",
  "minimal",
  "playful",
] as const;
export type PresetTone = (typeof PRESET_TONES)[number];

/** Where a preset anchors. Resolved against the aspect ratio's safe area. */
export const PRESET_PLACEMENTS = [
  "top",
  "upper-third",
  "center",
  "lower-third",
  "bottom",
  "bottom-left",
  "bottom-right",
  "full",
] as const;
export type PresetPlacement = (typeof PRESET_PLACEMENTS)[number];

/** The aspect ratios the library adapts to. */
export const PRESET_ASPECTS = ["16:9", "9:16", "1:1"] as const;
export type PresetAspect = (typeof PRESET_ASPECTS)[number];

/**
 * Where a design came from. Every preset MUST carry this — it is what makes
 * THIRD_PARTY_LICENSES.md verifiable rather than a claim, and it is how we know
 * which upstream file to re-check if a licence ever changes.
 */
export interface PresetAttribution {
  /** "remotion-templates" | "clippkit" | "framevo" (ours, no third-party origin). */
  source: "remotion-templates" | "clippkit" | "framevo";
  /** The upstream file this design is derived from, e.g. "templates/bounce-text.tsx". */
  file?: string;
  /** SPDX id of the upstream licence. */
  license?: "MIT";
  /** One line on what was taken — the design, never the code. */
  note?: string;
}

/**
 * Per-aspect overrides.
 *
 * A design tuned for a 16:9 title card is wrong on a 9:16 feed: the text is too
 * small to read on a phone, it sits under TikTok's UI chrome, and it wraps at
 * the wrong width. Rather than shipping three near-duplicate presets (which the
 * brief explicitly forbids), ONE preset declares how it adapts.
 *
 * Anything omitted falls back to the preset's base values.
 */
export interface PresetAspectOverride {
  /** Multiplied into the base fontScale. Vertical usually needs bigger text. */
  fontScaleMultiplier?: number;
  placement?: PresetPlacement;
  /** Max text width as a fraction of the SAFE area (not the canvas). */
  maxWidthFraction?: number;
  textStyle?: Partial<TextStyle>;
}

/** The preset itself. */
export interface FramevoPreset {
  /** Stable, validated id. The AI Director may only reference ids that exist. */
  id: string;
  name: string;
  category: PresetCategory;
  /** One line, shown in the browser. */
  description: string;
  /** The EXISTING Framevo edit type this compiles to. Never a new one. */
  effectType: EffectType;
  tone: PresetTone;
  /** Free-text search terms, lowercase. */
  tags: readonly string[];

  /** Base look — merged over DEFAULT_TEXT_STYLE at draw time. */
  textStyle: TextStyle;
  animation?: PresetAnimation;
  placement: PresetPlacement;
  /** Max text width as a fraction of the safe area. Default 1. */
  maxWidthFraction?: number;

  /**
   * For `effectType: "transition"` — WHICH of Framevo's real transition styles
   * this design compiles to. Without it every transition preset would render as
   * the default black dip, which would make four distinct designs look identical
   * (and would have shipped a "film burn" that flashes black instead of white).
   */
  transitionStyle?: TransitionStyle;

  /** Suggested length when applied. The user can resize it on the timeline. */
  defaultDurationSeconds: number;
  /** Editable starting copy. Never fabricated data — a prompt, not a claim. */
  defaultText?: string;

  /** How this design changes shape per aspect ratio. */
  aspects?: Partial<Record<PresetAspect, PresetAspectOverride>>;

  attribution: PresetAttribution;
}

/** The back-link stamped on a moment produced by a preset. */
export interface PresetRef {
  id: string;
  /** `PRESET_SCHEMA_VERSION` at apply time. */
  version: number;
}

/**
 * The user's preset-library state. Persisted in workspace settings (not on the
 * project) — favourites and recents follow the PERSON, not one video.
 */
export interface PresetLibraryState {
  favouriteIds: string[];
  /** Most-recent first, capped. */
  recentIds: string[];
}

export const MAX_RECENT_PRESETS = 12;
