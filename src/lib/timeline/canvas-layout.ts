/**
 * Canvas Fit / Resize — the GLOBAL output-canvas layout.
 *
 * Decides how the WHOLE source video sits inside the chosen export aspect
 * ratio. This is the OUTER layer: the canvas placement is applied first, then
 * the per-moment camera (AI zoom / crop / speed) composes inside it. Distinct
 * from per-moment `CropSettings` (a timeline effect).
 *
 * Pure + deterministic (no DOM / Firestore / Date.now / Math.random) so the
 * preview (CSS) and exporter (canvas) can share the exact same math — the same
 * "shared math, two renderers" model used by `cover.ts` / `camera.ts`.
 */

import type {
  AspectRatioId,
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
  FitMode,
  OutputCanvas,
  VisualAnalysis,
} from "@/lib/firebase/schema";
import { dequantizeArray } from "@/lib/cv/resample";
import { coverFitDims } from "./cover";
import { even, type OutputResolution } from "./output-dims";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Back-compat resolver ─────────────────────────────────────────────────────

/**
 * Single source of truth for "what output canvas applies to this project".
 * First hit wins:
 *   1. `effects.outputCanvas`           → use it (supersedes everything).
 *   2. legacy export-panel `format`     → TikTok 9:16 → 9:16/fill,
 *                                          YouTube/Custom → 16:9/fill,
 *                                          Source/1080p/4K → null.
 *   3. legacy `verticalExport === true` → 9:16/fill.
 *   4. otherwise                        → null.
 *
 * `null` means "full-frame source" — the export keeps its existing
 * `resolveOutputDims` + centred-cover path, so the dominant default is
 * untouched (zero regression).
 */
export function resolveOutputCanvas(
  effects: Pick<
    EffectsSettings,
    "outputCanvas" | "verticalExport" | "defaultExportFormat"
  >,
  legacyFormat?: ExportFormat
): OutputCanvas | null {
  if (effects.outputCanvas) return effects.outputCanvas;

  // A transient export-panel `format` is an explicit per-export choice and
  // overrides the stored toggle.
  switch (legacyFormat) {
    case "TikTok 9:16":
      return legacyCanvas("9:16");
    case "YouTube 16:9":
    case "Custom":
      return legacyCanvas("16:9");
    case "Source":
    case "1080p":
    case "4K":
      return null;
    default:
      break;
  }

  if (effects.verticalExport === true) return legacyCanvas("9:16");
  return null;
}

/** Legacy crop presets were always center-cropped cover, no background. */
function legacyCanvas(ar: "9:16" | "16:9"): OutputCanvas {
  const [width, height] = ar === "9:16" ? [1080, 1920] : [1920, 1080];
  return {
    aspectRatio: ar,
    width,
    height,
    fitMode: "fill",
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    backgroundMode: "blur",
  };
}

// ── Output dimensions ────────────────────────────────────────────────────────

const RATIO: Record<Exclude<AspectRatioId, "custom">, [number, number]> = {
  "16:9": [16, 9],
  "9:16": [9, 16],
  "1:1": [1, 1],
  "4:5": [4, 5],
};

/**
 * Output pixel dimensions for an aspect ratio at a resolution. The long edge
 * is bounded by the resolution (1920 for 1080p, 3840 for 4K) and both edges
 * are rounded even (H.264). Reproduces today's preset sizes exactly
 * (9:16 → 1080×1920, 16:9 → 1920×1080), so the encode budget is unchanged.
 */
export function resolveCanvasDims(
  sourceW: number,
  sourceH: number,
  aspectRatio: AspectRatioId,
  resolution: OutputResolution,
  custom?: { width: number; height: number }
): { canvasW: number; canvasH: number } {
  const longEdge = resolution === "4K" ? 3840 : resolution === "720p" ? 1280 : 1920;

  let rw: number;
  let rh: number;
  if (aspectRatio === "custom") {
    rw = custom && custom.width > 0 ? custom.width : sourceW > 0 ? sourceW : 1920;
    rh =
      custom && custom.height > 0 ? custom.height : sourceH > 0 ? sourceH : 1080;
  } else {
    [rw, rh] = RATIO[aspectRatio];
  }

  let canvasW: number;
  let canvasH: number;
  if (rw >= rh) {
    canvasW = longEdge;
    canvasH = (longEdge * rh) / rw;
  } else {
    canvasH = longEdge;
    canvasW = (longEdge * rw) / rh;
  }
  return { canvasW: even(canvasW), canvasH: even(canvasH) };
}

// ── Base placement ───────────────────────────────────────────────────────────

export interface CanvasPlacement {
  /** Source draw dimensions in canvas px, BEFORE the per-moment camera. */
  drawW: number;
  drawH: number;
  /** Placement-centre offset from the canvas centre, in canvas px. */
  baseOffsetX: number;
  baseOffsetY: number;
  /** True when the source doesn't fully cover the canvas (background shows). */
  hasLetterbox: boolean;
}

/** `object-fit: contain` dims — the largest source rect that fits inside. */
function containDims(
  sourceW: number,
  sourceH: number,
  canvasW: number,
  canvasH: number
): { drawW: number; drawH: number } {
  const sA = (sourceW > 0 ? sourceW : 1) / (sourceH > 0 ? sourceH : 1);
  const cA = canvasW / canvasH;
  if (sA > cA) {
    // Source wider than canvas — fit by width, gap top/bottom.
    return { drawW: canvasW, drawH: canvasW / sA };
  }
  // Source taller — fit by height, gap left/right.
  return { drawW: canvasH * sA, drawH: canvasH };
}

/** A cover rect overflows by `draw - canv`; pan ± half that without a gap. */
function clampPan(off: number, draw: number, canv: number): number {
  const half = Math.max(0, (draw - canv) / 2);
  return clamp(off, -half, half);
}

/**
 * The base placement of the source inside the output canvas for each fit mode.
 * The per-moment camera transform composes on top using `drawW`/`drawH` (so
 * `canvasTranslateFor` stays aspect-correct) and `baseOffsetX/Y` shifts the
 * placement centre.
 */
export function resolveCanvasPlacement(
  sourceW: number,
  sourceH: number,
  canvasW: number,
  canvasH: number,
  oc: OutputCanvas,
  smart?: SmartFitResult
): CanvasPlacement {
  // Smart-fit that gave up falls back to a contained fit (+ blur background).
  const mode: FitMode =
    oc.fitMode === "smart-fit" && smart?.fallbackToBlur ? "fit" : oc.fitMode;

  if (mode === "fill") {
    const { drawW, drawH } = coverFitDims(sourceW, sourceH, canvasW, canvasH);
    return { drawW, drawH, baseOffsetX: 0, baseOffsetY: 0, hasLetterbox: false };
  }

  if (mode === "fit") {
    const { drawW, drawH } = containDims(sourceW, sourceH, canvasW, canvasH);
    return {
      drawW,
      drawH,
      baseOffsetX: 0,
      baseOffsetY: 0,
      hasLetterbox: drawW < canvasW - 1 || drawH < canvasH - 1,
    };
  }

  if (mode === "smart-fit") {
    const { drawW, drawH } = coverFitDims(sourceW, sourceH, canvasW, canvasH);
    return {
      drawW,
      drawH,
      baseOffsetX: clampPan((smart?.offsetX ?? 0) * canvasW, drawW, canvasW),
      baseOffsetY: clampPan((smart?.offsetY ?? 0) * canvasH, drawH, canvasH),
      hasLetterbox: false,
    };
  }

  // manual: a contained base, scaled by the user, then offset by the drag.
  const base = containDims(sourceW, sourceH, canvasW, canvasH);
  const s = clamp(oc.scale || 1, 0.25, 4);
  const drawW = base.drawW * s;
  const drawH = base.drawH * s;
  return {
    drawW,
    drawH,
    baseOffsetX: clamp(oc.offsetX || 0, -1, 1) * canvasW,
    baseOffsetY: clamp(oc.offsetY || 0, -1, 1) * canvasH,
    hasLetterbox: drawW < canvasW - 1 || drawH < canvasH - 1,
  };
}

// ── Smart-Fit ────────────────────────────────────────────────────────────────

export interface SmartFitResult {
  /** Canvas-normalized pan (0 = centred). */
  offsetX: number;
  offsetY: number;
  scale: number;
  /** True when signals are too weak to trust → caller renders Fit + blur. */
  fallbackToBlur: boolean;
}

/** Weighted importance points in source-normalized 0..1 coords. */
export interface SmartSignals {
  points: { x: number; y: number; weight: number }[];
}

/**
 * Pick a pan offset that keeps the important content in frame when a covered
 * source overflows the output canvas (e.g. 16:9 → 9:16 overflows horizontally,
 * so we pan X). Deterministic. If the signals are weak / absent, returns
 * `fallbackToBlur` so the caller shows the whole frame on a blurred background
 * instead of cropping on a bad guess.
 */
export function computeSmartFitOffset(
  sourceW: number,
  sourceH: number,
  canvasW: number,
  canvasH: number,
  signals: SmartSignals
): SmartFitResult {
  const sA = (sourceW > 0 ? sourceW : 16) / (sourceH > 0 ? sourceH : 9);
  const cA = canvasW / canvasH;
  // Cover overflows on the axis where the source is "longer" than the canvas.
  const overflowX = sA > cA;

  const pts = signals.points.filter((p) => p.weight > 0 && isFinite(p.x) && isFinite(p.y));
  const totalW = pts.reduce((s, p) => s + p.weight, 0);
  if (pts.length === 0 || totalW <= 0) {
    return { offsetX: 0, offsetY: 0, scale: 1, fallbackToBlur: true };
  }

  const axis = (p: { x: number; y: number }) => (overflowX ? p.x : p.y);
  const mean = pts.reduce((s, p) => s + p.weight * axis(p), 0) / totalW;
  const variance =
    pts.reduce((s, p) => s + p.weight * (axis(p) - mean) ** 2, 0) / totalW;
  const spread = Math.sqrt(Math.max(0, variance));

  // Confidence: tighter cluster + heavier mean weight → more trustworthy.
  const meanWeight = totalW / pts.length; // weights are 0..1
  const concentration = clamp(1 - spread / 0.3, 0, 1);
  const confidence = clamp(meanWeight * 0.5 + concentration * 0.5, 0, 1);
  if (confidence < 0.25) {
    return { offsetX: 0, offsetY: 0, scale: 1, fallbackToBlur: true };
  }

  // Shift so the important centre sits at the canvas centre. The available pan
  // is (drawAxis/canvasAxis); `resolveCanvasPlacement` re-clamps to the exact
  // overflow in px so a gap can never appear.
  const cover = coverFitDims(sourceW, sourceH, canvasW, canvasH);
  let offsetX = 0;
  let offsetY = 0;
  if (overflowX) {
    offsetX = clamp((0.5 - mean) * (cover.drawW / canvasW), -1, 1);
  } else {
    offsetY = clamp((0.5 - mean) * (cover.drawH / canvasH), -1, 1);
  }
  return { offsetX, offsetY, scale: 1, fallbackToBlur: false };
}

/**
 * Collect Smart-Fit importance points from everything the project already
 * knows: the CV cursor track + motion centroid (per-second, confidence- and
 * motion-weighted, modulated by the attention curve) and every detected
 * moment's focus region (whole-video static importance). All coords are
 * source-normalized 0..1, so they feed `computeSmartFitOffset` directly.
 */
export function buildSmartSignals(
  visualAnalysis: VisualAnalysis | undefined,
  moments: DetectedMoment[]
): SmartSignals {
  const points: SmartSignals["points"] = [];

  const va = visualAnalysis;
  if (va) {
    const cx = dequantizeArray(va.cursorX);
    const cy = dequantizeArray(va.cursorY);
    const cconf = dequantizeArray(va.cursorConf);
    const ccx = dequantizeArray(va.centroidX);
    const ccy = dequantizeArray(va.centroidY);
    const motion = dequantizeArray(va.motion);
    const attention = dequantizeArray(va.attentionCurve);
    const n = va.sampleCount || Math.max(cx.length, ccx.length);
    for (let i = 0; i < n; i++) {
      const att = attention[i] ?? 0.5; // temporal weight
      const conf = cconf[i] ?? 0;
      if (cx[i] != null && cy[i] != null && conf > 0.15) {
        points.push({ x: cx[i], y: cy[i], weight: conf * (0.5 + 0.5 * att) });
      }
      const mot = motion[i] ?? 0;
      if (ccx[i] != null && ccy[i] != null && mot > 0.05) {
        points.push({
          x: ccx[i],
          y: ccy[i],
          weight: mot * 0.4 * (0.5 + 0.5 * att),
        });
      }
    }
  }

  for (const m of moments) {
    const fr = m.focusRegion;
    if (!fr) continue;
    const w = m.attentionScore ?? m.confidenceScore ?? 0.5;
    points.push({
      x: fr.x + fr.width / 2,
      y: fr.y + fr.height / 2,
      weight: clamp(w, 0, 1) * 0.8,
    });
  }

  return { points };
}
