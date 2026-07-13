/**
 * Preset layout — aspect-ratio adaptation and safe areas.
 *
 * The same design must work on a 16:9 YouTube frame, a 9:16 TikTok feed and a
 * 1:1 square. Naively reusing one layout across all three fails in three
 * specific, well-known ways:
 *
 *   1. TEXT SIZE. `fontScale` is a fraction of canvas HEIGHT. On 9:16 the canvas
 *      is tall, so the same fraction yields text that is enormous relative to the
 *      (narrow) width — and on 1:1 it lands somewhere in between. Each aspect
 *      needs its own multiplier or the text either overflows or turns to ants.
 *
 *   2. SAFE AREAS. Vertical feeds put their own UI over the frame: TikTok stacks
 *      the caption, handle and buttons across the bottom ~18% and down the right
 *      edge. Text drawn there is partly invisible to a real viewer even though it
 *      looks fine in our preview. 16:9 has the opposite problem — broadcast-style
 *      edge bleed — but a much smaller margin.
 *
 *   3. WRAP WIDTH. A line that reads as one row on 16:9 wraps to four on 9:16.
 *      Wrap width has to be a fraction of the SAFE area, not the canvas.
 *
 * This module resolves all three from ONE preset, so the library ships one
 * design per look rather than three near-duplicates (which the brief forbids).
 *
 * Pure. Shared by the renderer (so preview + export adapt identically), the
 * preset browser's previews, and the tests.
 */
import type { TextStyle, TextVPosition } from "../firebase/schema";
import type {
  FramevoPreset,
  PresetAspect,
  PresetPlacement,
} from "./types";

/**
 * The insets a platform's own UI eats, as fractions of the canvas. These are the
 * numbers that decide whether a caption is readable on a phone or hidden behind
 * a "Follow" button.
 */
export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Per-aspect safe areas.
 *
 * 9:16 is the aggressive one and deliberately so: the bottom 20% is where
 * TikTok/Reels/Shorts stack the caption + handle, and the right 12% is the
 * action rail (like / comment / share). Anything we draw there is competing with
 * the platform's own chrome.
 */
export const SAFE_AREAS: Record<PresetAspect, SafeArea> = {
  "16:9": { top: 0.05, bottom: 0.06, left: 0.05, right: 0.05 },
  "9:16": { top: 0.09, bottom: 0.2, left: 0.06, right: 0.12 },
  "1:1": { top: 0.07, bottom: 0.09, left: 0.06, right: 0.06 },
};

/**
 * Base font-scale multiplier per aspect.
 *
 * `fontScale` is a fraction of canvas HEIGHT (see text-style.ts). A 9:16 canvas
 * is 1.78× taller than it is wide, so a scale that reads well on 16:9 produces
 * text far too large for the narrow width — hence the reduction. 1:1 sits
 * between the two.
 */
export const ASPECT_FONT_MULTIPLIER: Record<PresetAspect, number> = {
  "16:9": 1,
  "9:16": 0.62,
  "1:1": 0.82,
};

/** Classify a canvas by its dimensions. Anything portrait counts as 9:16. */
export function aspectOf(canvasW: number, canvasH: number): PresetAspect {
  if (canvasW <= 0 || canvasH <= 0) return "16:9";
  const r = canvasW / canvasH;
  if (r < 0.9) return "9:16";
  if (r < 1.15) return "1:1";
  return "16:9";
}

export function safeAreaFor(aspect: PresetAspect): SafeArea {
  return SAFE_AREAS[aspect];
}

/** The safe box in canvas pixels. */
export function safeBox(
  canvasW: number,
  canvasH: number,
  aspect: PresetAspect = aspectOf(canvasW, canvasH)
): { x: number; y: number; width: number; height: number } {
  const s = SAFE_AREAS[aspect];
  const x = canvasW * s.left;
  const y = canvasH * s.top;
  return {
    x,
    y,
    width: Math.max(1, canvasW - x - canvasW * s.right),
    height: Math.max(1, canvasH - y - canvasH * s.bottom),
  };
}

/**
 * Turn a placement into a concrete `TextStyle` position, INSIDE the safe area.
 *
 * Returns a custom x/y (0..1 of canvas) rather than a named position, because a
 * named "bottom" means "wherever the renderer's bottom happens to be" — which is
 * exactly the thing that puts captions under TikTok's UI. Resolving against the
 * safe box is what makes the adaptation real.
 */
export function positionForPlacement(
  placement: PresetPlacement,
  aspect: PresetAspect
): { position: TextVPosition; customX: number; customY: number; align?: TextStyle["align"] } {
  const s = SAFE_AREAS[aspect];
  const top = s.top;
  const bottom = 1 - s.bottom;
  const height = bottom - top;

  const centreX = (s.left + (1 - s.right)) / 2;

  switch (placement) {
    case "top":
      return { position: "custom", customX: centreX, customY: top + height * 0.06 };
    case "upper-third":
      return { position: "custom", customX: centreX, customY: top + height * 0.25 };
    case "center":
    case "full":
      return { position: "custom", customX: centreX, customY: top + height * 0.5 };
    case "lower-third":
      return { position: "custom", customX: centreX, customY: top + height * 0.74 };
    case "bottom":
      return { position: "custom", customX: centreX, customY: bottom - height * 0.04 };
    case "bottom-left":
      return {
        position: "custom",
        customX: s.left + 0.02,
        customY: bottom - height * 0.05,
        align: "left",
      };
    case "bottom-right":
      return {
        position: "custom",
        customX: 1 - s.right - 0.02,
        customY: bottom - height * 0.05,
        align: "right",
      };
  }
}

/**
 * Resolve a preset into the concrete `TextStyle` to persist on the moment, for a
 * given aspect ratio.
 *
 * Order (later wins): preset base → the aspect override's textStyle → the
 * derived placement + font scale. The user's own edits are layered on TOP of
 * this later by `resolveTextStyleValues` (defaults ← legacy ← textStyle), so
 * customising a preset never fights with its adaptation.
 */
export function resolvePresetStyle(
  preset: FramevoPreset,
  aspect: PresetAspect
): TextStyle {
  const override = preset.aspects?.[aspect];

  const baseScale = preset.textStyle.fontScale ?? 0.05;
  const multiplier =
    override?.fontScaleMultiplier ?? ASPECT_FONT_MULTIPLIER[aspect];

  const placement = override?.placement ?? preset.placement;
  const pos = positionForPlacement(placement, aspect);

  return {
    ...preset.textStyle,
    ...(override?.textStyle ?? {}),
    fontScale: round(baseScale * multiplier, 4),
    position: pos.position,
    customX: round(pos.customX, 4),
    customY: round(pos.customY, 4),
    // A placement with an implied alignment (bottom-left / bottom-right) wins,
    // otherwise keep whatever the design asked for.
    ...(pos.align ? { align: pos.align } : {}),
  };
}

/**
 * The max text width IN PIXELS for a preset on this canvas — a fraction of the
 * SAFE area, never of the raw canvas. This is what stops a 9:16 title from
 * running under the action rail.
 */
export function resolveMaxWidthPx(
  preset: Pick<FramevoPreset, "maxWidthFraction" | "aspects">,
  canvasW: number,
  canvasH: number
): number {
  const aspect = aspectOf(canvasW, canvasH);
  const box = safeBox(canvasW, canvasH, aspect);
  const frac =
    preset.aspects?.[aspect]?.maxWidthFraction ?? preset.maxWidthFraction ?? 1;
  return Math.max(24, box.width * clamp01(frac));
}

/**
 * Clamp a text style's custom position back inside the safe area.
 *
 * Applied to any style — preset-made or hand-tuned — so a user who drags a
 * caption to the very bottom of a vertical video gets pulled back to where it
 * will actually be visible, rather than shipping a video with text under the
 * platform's buttons.
 */
export function clampToSafeArea(
  style: TextStyle,
  aspect: PresetAspect
): TextStyle {
  if (style.position !== "custom") return style;
  const s = SAFE_AREAS[aspect];
  const x = clamp(style.customX ?? 0.5, s.left, 1 - s.right);
  const y = clamp(style.customY ?? 0.5, s.top, 1 - s.bottom);
  if (x === style.customX && y === style.customY) return style;
  return { ...style, customX: round(x, 4), customY: round(y, 4) };
}

/** True when this style would draw outside the platform's safe area. */
export function isOutsideSafeArea(
  style: Pick<TextStyle, "position" | "customX" | "customY">,
  aspect: PresetAspect
): boolean {
  if (style.position !== "custom") return false;
  const s = SAFE_AREAS[aspect];
  const x = style.customX ?? 0.5;
  const y = style.customY ?? 0.5;
  return x < s.left || x > 1 - s.right || y < s.top || y > 1 - s.bottom;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 1;
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
