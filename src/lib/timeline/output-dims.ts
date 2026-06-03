import type { EffectsSettings, ExportFormat } from "@/lib/firebase/schema";

/**
 * Single source of truth for EXPORT output dimensions and the crop
 * decision. Both the renderer (`export.ts`) and the editor preview
 * (`RealVideoPlayer.tsx`) call this so what you see equals what exports.
 *
 * The core invariant the user cares about: an export must NEVER silently
 * crop content off the captured viewport. Cropping only happens when the
 * user explicitly opts into a fixed-aspect CROP preset (TikTok 9:16,
 * YouTube 16:9, or the legacy verticalExport toggle).
 *
 *  - "Source" (default) → canvas aspect == source aspect. `coverFitDims`
 *    then yields drawW==canvasW / drawH==canvasH, so the full frame is
 *    painted with zero crop and zero letterbox.
 *  - "YouTube 16:9" / "Custom" → fixed 16:9 canvas, source center-cropped.
 *  - "TikTok 9:16" / verticalExport → fixed 9:16 canvas, source
 *    center-cropped.
 *
 * The long edge of a "Source" canvas is bounded by the resolution's long
 * edge (1920 for 1080p, 3840 for 4K) so a high-DPI capture doesn't blow
 * past the browser-stable encode budget.
 */

export type OutputResolution = "1080p" | "4K";

export interface OutputDims {
  /** Canvas / encoded width in pixels (always even — H.264 requires it). */
  canvasW: number;
  /** Canvas / encoded height in pixels (always even). */
  canvasH: number;
  /** Whether this output crops the source to a fixed container aspect. */
  cropped: boolean;
  /** Human-readable mode for diagnostics + UI copy. */
  mode: "source" | "crop-16:9" | "crop-9:16";
}

/** Round to the nearest even integer ≥ 2 (H.264 needs even dimensions). */
function even(n: number): number {
  const r = Math.round(n);
  return Math.max(2, r % 2 === 0 ? r : r + 1);
}

/**
 * Is the chosen format/effects combination a fixed-aspect CROP preset?
 * Anything that isn't a crop preset preserves the source aspect.
 */
export function isCropPreset(
  format: ExportFormat,
  effects: Pick<EffectsSettings, "verticalExport">
): boolean {
  return (
    format === "TikTok 9:16" ||
    format === "YouTube 16:9" ||
    format === "Custom" ||
    effects.verticalExport === true
  );
}

export function resolveOutputDims(
  sourceW: number,
  sourceH: number,
  resolution: OutputResolution,
  format: ExportFormat,
  effects: Pick<EffectsSettings, "verticalExport">
): OutputDims {
  const safeSrcW = sourceW > 0 ? sourceW : 1920;
  const safeSrcH = sourceH > 0 ? sourceH : 1080;

  const vertical = format === "TikTok 9:16" || effects.verticalExport === true;

  // Explicit vertical crop preset — fixed 9:16, source center-cropped.
  if (vertical) {
    return {
      canvasW: resolution === "4K" ? 2160 : 1080,
      canvasH: resolution === "4K" ? 3840 : 1920,
      cropped: true,
      mode: "crop-9:16",
    };
  }

  // Explicit horizontal crop preset — fixed 16:9, source center-cropped.
  if (format === "YouTube 16:9" || format === "Custom") {
    return {
      canvasW: resolution === "4K" ? 3840 : 1920,
      canvasH: resolution === "4K" ? 2160 : 1080,
      cropped: true,
      mode: "crop-16:9",
    };
  }

  // Default "Source" mode — canvas aspect == source aspect, no crop.
  const longEdge = resolution === "4K" ? 3840 : 1920;
  const aspect = safeSrcW / safeSrcH;
  let canvasW: number;
  let canvasH: number;
  if (aspect >= 1) {
    // Landscape (or square) — width is the long edge.
    canvasW = longEdge;
    canvasH = longEdge / aspect;
  } else {
    // Portrait source — height is the long edge.
    canvasH = longEdge;
    canvasW = longEdge * aspect;
  }
  return {
    canvasW: even(canvasW),
    canvasH: even(canvasH),
    cropped: false,
    mode: "source",
  };
}
