/**
 * Clip EDIT resolution — turns a `GeneratedClip`'s stored intent
 * (`editOperations` + `suggestedHookText` / `suggestedCaptionStyle` /
 * `suggestedAspectRatio`) into the ACTUAL moments + effects the renderer
 * consumes. This is what makes a clip a real smart edit rather than a time range.
 *
 * PURE + non-mutating: every function returns new arrays/objects and never
 * touches the inputs, so the project timeline is untouched until the user
 * explicitly commits (`applyClipEditsToTimeline`).
 *
 * ONE resolver drives all three consumers, so preview and export can't drift:
 *   • preview  → clipPreviewMoments + clipEffects   (focused clip mode)
 *   • export   → clipExportMoments  + clipEffects   (adds the range cuts)
 *   • commit   → clipPreviewMoments                 ("Apply edits to timeline")
 */

import type {
  DetectedMoment,
  EffectsSettings,
  GeneratedClip,
  OutputCanvas,
} from "@/lib/firebase/schema";
import { resolveCanvasDims } from "@/lib/timeline/canvas-layout";
import { clipRangeCutMoments } from "./clip-generator";

/** Every moment synthesized FROM a clip carries this id prefix. */
export const CLIP_EDIT_ID_PREFIX = "clipedit_";

export function isClipEditMoment(m: Pick<DetectedMoment, "id">): boolean {
  return m.id.startsWith(CLIP_EDIT_ID_PREFIX);
}

/** Strip any previously-applied clip-edit moments (used before re-applying). */
export function withoutClipEditMoments(moments: DetectedMoment[]): DetectedMoment[] {
  return moments.filter((m) => !isClipEditMoment(m));
}

const FULL_FRAME = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Materialize the clip's `editOperations` into real moments (hook text, CTA,
 * text overlay, zoom / cursor-focus). Caption STYLE is not a moment — it's an
 * override applied to the captions already inside the range (see
 * `applyClipCaptionStyle`), and `trim` / `smart-crop` map to the range cuts +
 * output canvas respectively, not to moments.
 */
export function buildClipEditMoments(clip: GeneratedClip): DetectedMoment[] {
  const out: DetectedMoment[] = [];
  let i = 0;
  const id = () => `${CLIP_EDIT_ID_PREFIX}${clip.id}_${i++}`;

  for (const op of clip.editOperations) {
    // Clamp every op into the clip window — a clip edit can never leak outside.
    const s = Math.max(clip.startTime, Math.min(op.startTime, clip.endTime));
    const e = Math.min(clip.endTime, Math.max(op.endTime, s));
    if (e <= s && op.type !== "trim") continue;

    switch (op.type) {
      case "hook-text": {
        const text = String(op.params?.text ?? clip.suggestedHookText ?? "").trim();
        if (!text) break;
        out.push({
          ...base(id(), s, e, "hook-text", "Hook", "Clip hook line"),
          hookText: {
            text,
            stylePreset: "bold",
            position: "top",
            animation: "pop",
          },
        });
        break;
      }
      case "branding-cta": {
        const text = String(op.params?.text ?? "").trim() || "Try it yourself";
        out.push({
          ...base(id(), s, e, "branding-cta", "CTA", "Clip call to action"),
          brandingCta: {
            ctaText: text,
            position: "bottom-center",
            stylePreset: "social",
          },
        });
        break;
      }
      case "text-overlay": {
        const text = String(op.params?.text ?? "").trim();
        if (!text) break;
        out.push({
          ...base(id(), s, e, "text-overlay", "Text", "Clip text overlay"),
          textOverlay: {
            text,
            position: "bottom-center",
            size: "medium",
            alignment: "center",
            backgroundStyle: "pill",
            animation: "fade",
          },
        });
        break;
      }
      case "zoom":
      case "cursor-focus": {
        const region = (op.params?.focusRegion as DetectedMoment["focusRegion"]) ?? {
          x: 0.2,
          y: 0.2,
          width: 0.6,
          height: 0.6,
        };
        const m = base(id(), s, e, op.type, "Zoom", "Clip emphasis");
        out.push({
          ...m,
          focusRegion: region,
          intensity: typeof op.params?.intensity === "number" ? (op.params.intensity as number) : undefined,
        });
        break;
      }
      // `trim` → range cuts (clipExportMoments); `captions` → style override;
      // `smart-crop` → output canvas (clipEffects). None produce a moment here.
      default:
        break;
    }
  }
  return out;
}

function base(
  id: string,
  startTime: number,
  endTime: number,
  effectType: DetectedMoment["effectType"],
  label: string,
  reason: string
): DetectedMoment {
  return {
    id,
    startTime,
    endTime,
    label,
    reason,
    focusRegion: { ...FULL_FRAME },
    effectType,
    source: "ai",
    edited: false,
  };
}

/**
 * Apply the clip's suggested caption style to the caption moments INSIDE its
 * window. Captions outside the window (and every other moment) are returned
 * untouched by reference — so this is safe to run on the live timeline array.
 */
export function applyClipCaptionStyle(
  moments: DetectedMoment[],
  clip: GeneratedClip
): DetectedMoment[] {
  const style = clip.suggestedCaptionStyle;
  if (!style) return moments;
  let changed = false;
  const next = moments.map((m) => {
    if (m.effectType !== "captions" || !m.captions) return m;
    if (m.endTime <= clip.startTime || m.startTime >= clip.endTime) return m;
    if (m.captions.stylePreset === style) return m;
    changed = true;
    return { ...m, captions: { ...m.captions, stylePreset: style } };
  });
  return changed ? next : moments;
}

/**
 * The moments a FOCUSED clip renders with: the project's timeline, its captions
 * restyled inside the window, plus the clip's own synthesized edits. NO range
 * cuts — focus mode still shows the whole timeline (the UI dims what's outside).
 */
export function clipPreviewMoments(
  baseMoments: DetectedMoment[],
  clip: GeneratedClip
): DetectedMoment[] {
  const styled = applyClipCaptionStyle(withoutClipEditMoments(baseMoments), clip);
  return [...styled, ...buildClipEditMoments(clip)];
}

/**
 * The moments a clip EXPORTS with: the focused-preview moments + the two
 * synthetic cuts that carve the timeline down to exactly [start,end]. Every
 * render engine honors cuts via buildTimelineMap, so the clip renders as its
 * own short video with its smart edits baked in.
 */
export function clipExportMoments(
  baseMoments: DetectedMoment[],
  clip: GeneratedClip,
  sourceDuration: number
): DetectedMoment[] {
  return [
    ...clipPreviewMoments(baseMoments, clip),
    ...clipRangeCutMoments(clip.startTime, clip.endTime, sourceDuration),
  ];
}

/**
 * The clip's effects: the project's settings with the OUTPUT CANVAS overridden
 * to the clip's suggested aspect (e.g. a 9:16 Reel from a 16:9 source). Returns
 * the SAME object when there's nothing to override, so referential equality (and
 * every downstream memo) is preserved on the non-clip path.
 */
export function clipEffects(
  baseEffects: EffectsSettings,
  clip: GeneratedClip,
  sourceWidth: number,
  sourceHeight: number
): EffectsSettings {
  const aspect = clip.suggestedAspectRatio;
  if (!aspect) return baseEffects;
  const current = baseEffects.outputCanvas;
  if (current?.aspectRatio === aspect) return baseEffects;

  const { canvasW, canvasH } = resolveCanvasDims(
    sourceWidth > 0 ? sourceWidth : 1920,
    sourceHeight > 0 ? sourceHeight : 1080,
    aspect,
    "1080p"
  );
  const outputCanvas: OutputCanvas = {
    // Keep the user's fit/background choices when they already have a canvas;
    // otherwise default to the smart-fit + blur backdrop a social clip wants.
    fitMode: current?.fitMode ?? "smart-fit",
    scale: current?.scale ?? 1,
    offsetX: current?.offsetX ?? 0,
    offsetY: current?.offsetY ?? 0,
    backgroundMode: current?.backgroundMode ?? "blur",
    backgroundColor: current?.backgroundColor,
    aspectRatio: aspect,
    width: canvasW,
    height: canvasH,
  };
  return { ...baseEffects, outputCanvas };
}

/**
 * "Apply edits to full timeline" — the ONLY path that mutates the project.
 * Produces the persisted moment list: the clip's edits become real, user-owned
 * moments on the main timeline (no range cuts — the full video stays full).
 */
export function applyClipEditsToTimeline(
  baseMoments: DetectedMoment[],
  clip: GeneratedClip
): DetectedMoment[] {
  return clipPreviewMoments(baseMoments, clip).map((m) =>
    isClipEditMoment(m) ? { ...m, source: "user" as const, edited: true } : m
  );
}
