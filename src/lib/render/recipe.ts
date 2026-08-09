/**
 * RenderRecipe — the DOM-free, serializable description of everything the
 * per-frame compositor needs to bake one export, computed ONCE per render.
 *
 * This is the keystone of preview/export parity: `buildRenderRecipe` resolves
 * the source rect (Frame Crop), the output canvas (Canvas Fit / Resize), the
 * source's base placement, the background layer, and the cut/speed timeline
 * map using the SAME pure helpers the editor preview uses. Both the browser
 * exporter (`export.ts`) and the server worker (`services/export-worker`) call
 * `buildRenderRecipe` + `composeFrame` (see `./compose-frame`), so the two
 * render paths agree by construction — there is no second implementation to
 * drift.
 *
 * It is intentionally free of `document` / `HTMLVideoElement` / canvas APIs:
 * the caller passes the source dimensions (the browser reads them off the
 * `<video>`; the worker reads them off ffprobe), and the recipe carries only
 * plain numbers + the raw moment/effect inputs the compositor selects from at
 * draw time.
 */
import type {
  BackgroundMode,
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
  FitMode,
  SourceCrop,
  VisualAnalysis,
  ZoomPresetId,
} from "@/lib/firebase/schema";
import {
  resolveOutputCanvas,
  resolveCanvasDims,
  resolveCanvasPlacement,
  computeSmartFitOffset,
  buildSmartSignals,
  type CanvasPlacement,
  type SmartFitResult,
} from "@/lib/timeline/canvas-layout";
import { resolveOutputDims } from "@/lib/timeline/output-dims";
import { coverFitDims } from "@/lib/timeline/cover";
import { resolveSourceRect, type SourceRect } from "@/lib/timeline/source-crop";
import { buildTimelineMap, type TimelineMap } from "@/lib/timeline/crop-speed";

/** The source's base placement in the output canvas, before the per-moment camera. */
export interface BasePlacement {
  drawW: number;
  drawH: number;
  offsetX: number;
  offsetY: number;
}

/**
 * The narrowed slice of `EffectsSettings` the per-frame compositor actually
 * reads. Resolved (strict-boolean) so a stray truthy Firestore value can't flip
 * vignette / click-highlights on. Everything else in `EffectsSettings` only
 * influences geometry, which is already baked into the recipe.
 */
export interface RenderEffects {
  autoZoom: number;
  /** Project zoom style — Subtle / Standard / Emphasis. Absent ⇒ "standard". */
  zoomPreset?: ZoomPresetId;
  /** Project camera speed 0..100 (50 = the preset's own ramp). */
  zoomSpeed: number;
  clickHighlights: boolean;
  clickHighlightStyle: "ring" | "pulse" | "burst";
  clickHighlightSize: number;
  vignette: boolean;
}

/**
 * Raw inputs to `buildRenderRecipe`. The browser builds these from the live
 * project + `<video>` element; the worker builds them from the export-job doc.
 * Storing RAW inputs (full `moments` + `effects` + `sourceCrop`) rather than
 * pre-bucketed cut/speed/camera lists is deliberate — the pure resolvers
 * (`resolveCameraFrame`, `buildTimelineMap`) own all selection + overlap
 * priority, and re-implementing that bucketing would be the #1 parity risk.
 */
export interface RenderRecipeInput {
  sourceWidth: number;
  sourceHeight: number;
  fps: 30 | 60;
  resolution: "720p" | "1080p" | "4K";
  format: ExportFormat;
  /** Full SOURCE duration in seconds (pre cuts/speed). */
  sourceDuration: number;
  moments: DetectedMoment[];
  effects: EffectsSettings;
  visualAnalysis?: VisualAnalysis;
  sourceCrop?: SourceCrop | null;
  /** Free-tier watermark. Server-decided; always false for paid cloud exports. */
  applyWatermark: boolean;
  /** Dev-only red/blue bounds borders. Always false in the worker. */
  debugBorders?: boolean;
}

/** The fully-resolved recipe consumed by `composeFrame`. */
export interface RenderRecipe {
  sourceWidth: number;
  sourceHeight: number;
  fps: 30 | 60;
  resolution: "720p" | "1080p" | "4K";
  format: ExportFormat;
  sourceDuration: number;
  /** Output duration in seconds (post cuts/speed) — from the timeline map. */
  outputDuration: number;
  canvasW: number;
  canvasH: number;
  /** Effective source sub-rectangle (Frame Crop), in source pixels. */
  sourceRect: SourceRect;
  /** Source's base placement in the canvas, before the per-moment camera. */
  base: BasePlacement;
  /** Whether a Canvas-Fit background layer fills empty space behind the video. */
  bgActive: boolean;
  bgMode: BackgroundMode;
  backgroundColor?: string;
  /** Fit mode after the Smart-Fit fallback decision (`"source"` = legacy path). */
  fitMode: FitMode | "source";
  effectiveFit: FitMode | "source";
  /** Human-readable output mode for diagnostics. */
  outMode: string;
  outCropped: boolean;
  /** Full moment list — the compositor's resolvers select from it per frame. */
  moments: DetectedMoment[];
  effects: RenderEffects;
  applyWatermark: boolean;
  debugBorders: boolean;
  /** Source→output time map (cuts removed, speed remapped). */
  timelineMap: TimelineMap;
}

/**
 * Resolve the effective source rectangle, clamping any degenerate crop back to
 * the full frame rather than encoding garbage. This is the pure half of the old
 * `getSafeSourceRect` — the caller (browser) does its own zero-dimension guard
 * (throwing a stage-tagged error) before reaching here, since by this point the
 * load-video guard has already verified real dimensions.
 */
function safeSourceRect(
  vw: number,
  vh: number,
  crop: SourceCrop | null | undefined
): SourceRect {
  const rect = resolveSourceRect(vw, vh, crop ?? undefined);
  const { sx, sy, sWidth, sHeight } = rect;
  const finite =
    Number.isFinite(sx) &&
    Number.isFinite(sy) &&
    Number.isFinite(sWidth) &&
    Number.isFinite(sHeight);
  if (!finite || sWidth <= 0 || sHeight <= 0 || sx + sWidth > vw || sy + sHeight > vh) {
    console.warn("[render-recipe] invalid source rect — clamping to full frame", {
      rect,
      videoWidth: vw,
      videoHeight: vh,
    });
    return { sx: 0, sy: 0, sWidth: vw, sHeight: vh, cropActive: false };
  }
  return rect;
}

/**
 * Build the per-export recipe. Pure: no DOM, no side effects beyond a defensive
 * console.warn. Mirrors the geometry block that used to live inline in
 * `renderProjectClientSide` so the browser render is byte-identical, while the
 * worker can call the exact same function.
 */
export function buildRenderRecipe(input: RenderRecipeInput): RenderRecipe {
  const {
    sourceWidth,
    sourceHeight,
    fps,
    resolution,
    format,
    sourceDuration,
    moments,
    effects,
    visualAnalysis,
    sourceCrop,
    applyWatermark,
  } = input;

  const sourceRect = safeSourceRect(sourceWidth, sourceHeight, sourceCrop);
  const sourceW = sourceRect.sWidth;
  const sourceH = sourceRect.sHeight;

  // ── Global output canvas (Canvas Fit / Resize) ──────────────────────────
  // `resolveOutputCanvas` is the single back-compat source of truth: a concrete
  // OutputCanvas for an explicit aspect/fit choice, or `null` for the full-frame
  // "Source" path (legacy `resolveOutputDims` + centred-cover behaviour).
  const oc = resolveOutputCanvas(effects, format);

  let canvasW: number;
  let canvasH: number;
  let outMode: string;
  let outCropped: boolean;
  let placement: CanvasPlacement | null = null;
  let smart: SmartFitResult | undefined;

  if (oc) {
    const dims = resolveCanvasDims(
      sourceW,
      sourceH,
      oc.aspectRatio,
      resolution,
      oc.aspectRatio === "custom"
        ? { width: oc.width, height: oc.height }
        : undefined
    );
    canvasW = dims.canvasW;
    canvasH = dims.canvasH;
    if (oc.fitMode === "smart-fit") {
      smart = computeSmartFitOffset(
        sourceW,
        sourceH,
        canvasW,
        canvasH,
        buildSmartSignals(visualAnalysis, moments)
      );
    }
    placement = resolveCanvasPlacement(sourceW, sourceH, canvasW, canvasH, oc, smart);
    outMode = `canvas-${oc.aspectRatio}/${oc.fitMode}${smart?.fallbackToBlur ? "→fit" : ""}`;
    outCropped = !placement.hasLetterbox;
  } else {
    const out = resolveOutputDims(sourceW, sourceH, resolution, format, effects);
    canvasW = out.canvasW;
    canvasH = out.canvasH;
    outMode = out.mode;
    outCropped = out.cropped;
  }

  // Effective fit + background after the Smart-Fit fallback decision. The
  // background fills the whole canvas behind the (crisp) video whenever the
  // placement leaves empty space — Fit always, Manual when scaled < cover.
  const effectiveFit: FitMode =
    oc && oc.fitMode === "smart-fit" && smart?.fallbackToBlur ? "fit" : oc?.fitMode ?? "fill";
  const bgMode: BackgroundMode = smart?.fallbackToBlur ? "blur" : oc?.backgroundMode ?? "blur";
  const bgActive =
    !!placement &&
    placement.hasLetterbox &&
    (effectiveFit === "fit" || effectiveFit === "manual");

  // The source's base placement inside the canvas. Legacy/null path keeps the
  // historical centred cover; the canvas path uses the resolved placement.
  const cover = coverFitDims(sourceW, sourceH, canvasW, canvasH);
  const base: BasePlacement = placement
    ? {
        drawW: placement.drawW,
        drawH: placement.drawH,
        offsetX: placement.baseOffsetX,
        offsetY: placement.baseOffsetY,
      }
    : { drawW: cover.drawW, drawH: cover.drawH, offsetX: 0, offsetY: 0 };

  const timelineMap = buildTimelineMap(moments, sourceDuration);

  return {
    sourceWidth,
    sourceHeight,
    fps,
    resolution,
    format,
    sourceDuration,
    outputDuration: timelineMap.outputDuration,
    canvasW,
    canvasH,
    sourceRect,
    base,
    bgActive,
    bgMode,
    backgroundColor: oc?.backgroundColor,
    fitMode: oc?.fitMode ?? "source",
    effectiveFit: oc ? effectiveFit : "source",
    outMode,
    outCropped,
    moments,
    effects: {
      autoZoom: effects.autoZoom,
      // Camera feel travels WITH the recipe: the worker and the Remotion
      // renderer never see `effectsSettings`, so a zoom style chosen in the
      // editor would silently fall back to the default in the cloud without
      // these two.
      zoomPreset: effects.zoomPreset,
      zoomSpeed: effects.zoomSpeed,
      clickHighlights: effects.clickHighlights === true,
      clickHighlightStyle: effects.clickHighlightStyle,
      clickHighlightSize: effects.clickHighlightSize,
      vignette: effects.vignette === true,
    },
    applyWatermark,
    debugBorders: input.debugBorders === true,
    timelineMap,
  };
}
