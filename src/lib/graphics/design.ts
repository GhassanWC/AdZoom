/**
 * Graphic designs as DATA — the compositions Framevo's AI (and the Add menu)
 * start from. Every design is an array of editable parts (see GraphicSettings
 * in schema.ts): text, rectangles and lines with their own position, style,
 * z-order and staggered entrance. Nothing here draws; overlay-draw.ts renders
 * the parts identically in the preview and every exporter.
 *
 * Pure and deterministic — tested in tests/graphic-design.test.ts.
 */

import type { GraphicPart, GraphicSettings, TextStyle } from "@/lib/firebase/schema";
import type { PresetAnimation } from "@/lib/presets/animation";

export type GraphicTone = "clean" | "premium" | "bold";

const EASE_IN_UP = (dur = 0.5): PresetAnimation => ({
  in: { durationSeconds: dur, ease: "ease-out", translateY: [0.03, 0], opacity: [0, 1] },
  out: { durationSeconds: 0.35, ease: "ease-in", opacity: [1, 0] },
});
const GROW_RIGHT = (dur = 0.45): PresetAnimation => ({
  in: { durationSeconds: dur, ease: "ease-out", scale: [0.01, 1], opacity: [0, 1] },
  out: { durationSeconds: 0.3, ease: "ease-in", opacity: [1, 0] },
});
const FADE = (dur = 0.4): PresetAnimation => ({
  in: { durationSeconds: dur, ease: "ease-out", opacity: [0, 1] },
  out: { durationSeconds: 0.3, ease: "ease-in", opacity: [1, 0] },
});

const TONES: Record<GraphicTone, { accent: string; text: string; sub: string; plate: string; titleWeight: number; titleScale: number; upper: boolean; family: TextStyle["fontFamily"] }> = {
  clean: { accent: "#f97316", text: "#ffffff", sub: "#e5e7eb", plate: "#000000", titleWeight: 700, titleScale: 0.052, upper: false, family: "sans" },
  premium: { accent: "#d4af37", text: "#fff8e7", sub: "#f3e9d2", plate: "#0b0b0b", titleWeight: 600, titleScale: 0.058, upper: true, family: "serif" },
  bold: { accent: "#ff3d5a", text: "#ffffff", sub: "#ffffff", plate: "#000000", titleWeight: 800, titleScale: 0.064, upper: true, family: "sans" },
};

/**
 * A dish label: accent line → title → price/sub, revealed in that order.
 * `anchor` is where the block's left edge sits (0..1); it defaults to the
 * lower-left safe area so it doesn't cover a subject on the right.
 */
export function dishLabelParts(
  title: string,
  sub: string | undefined,
  opts: { tone?: GraphicTone; x?: number; y?: number } = {}
): GraphicPart[] {
  const tone = TONES[opts.tone ?? "clean"];
  const x = clamp01(opts.x ?? 0.07);
  const y = clamp01(opts.y ?? 0.78);
  const parts: GraphicPart[] = [
    {
      id: "accent",
      kind: "line",
      x,
      y: y - 0.085,
      x2: x + 0.06,
      y2: y - 0.085,
      color: tone.accent,
      thickness: 0.006,
      z: 1,
      delay: 0,
      animation: GROW_RIGHT(0.45),
    },
    {
      id: "title",
      kind: "text",
      text: title,
      x,
      y,
      z: 2,
      delay: 0.18,
      maxWidth: 0.5,
      animation: EASE_IN_UP(0.5),
      style: {
        fontFamily: tone.family,
        fontScale: tone.titleScale,
        fontWeight: tone.titleWeight,
        color: tone.text,
        align: "left",
        uppercase: tone.upper,
        letterSpacing: tone.upper ? 0.04 : 0.005,
        background: "none",
        shadow: true,
        shadowColor: "#000000",
        shadowOpacity: 0.55,
        shadowBlur: 0.5,
        shadowOffsetY: 0.05,
      },
    },
  ];
  if (sub) {
    parts.push({
      id: "sub",
      kind: "text",
      text: sub,
      x,
      y: y + 0.075,
      z: 2,
      delay: 0.42,
      maxWidth: 0.5,
      animation: FADE(0.4),
      style: {
        fontFamily: tone.family,
        fontScale: 0.034,
        fontWeight: 600,
        color: tone.accent,
        align: "left",
        letterSpacing: 0.02,
        background: "none",
        shadow: true,
        shadowColor: "#000000",
        shadowOpacity: 0.5,
        shadowBlur: 0.4,
      },
    });
  }
  return parts;
}

/** The starter design behind Add → Graphic: a title with an accent line. */
export function starterGraphic(): GraphicSettings {
  return { parts: dishLabelParts("Your title", "Add a line below it", { tone: "clean" }) };
}

/** True when a part has visible text (what "the title" / "the price" refer to). */
export function partText(p: GraphicPart): string | null {
  return p.kind === "text" ? p.text : null;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}
