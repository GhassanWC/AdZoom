import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);

// src/cli.ts
import { existsSync as existsSync2, readFileSync, writeFileSync, statSync } from "node:fs";
import { spawn as spawn2 } from "node:child_process";
import { dirname, join as join2 } from "node:path";
import { createInterface } from "node:readline";

// src/render.ts
import v8 from "node:v8";
import vm from "node:vm";
import { createCanvas, ImageData } from "@napi-rs/canvas";

// ../../src/lib/cv/resample.ts
function dequantize(b) {
  return Math.max(0, Math.min(255, b)) / 255;
}
function dequantizeArray(arr) {
  return (arr ?? []).map(dequantize);
}

// ../../src/lib/timeline/cover.ts
function coverFitDims(sourceW, sourceH, targetW, targetH) {
  const safeSrcW = sourceW > 0 ? sourceW : 1920;
  const safeSrcH = sourceH > 0 ? sourceH : 1080;
  const safeTgtW = targetW > 0 ? targetW : safeSrcW;
  const safeTgtH = targetH > 0 ? targetH : safeSrcH;
  const cAspect = safeTgtW / safeTgtH;
  const sAspect = safeSrcW / safeSrcH;
  if (sAspect > cAspect) {
    return { drawW: safeTgtH * sAspect, drawH: safeTgtH };
  }
  return { drawW: safeTgtW, drawH: safeTgtW / sAspect };
}

// ../../src/lib/timeline/output-dims.ts
function even(n) {
  const r = Math.round(n);
  return Math.max(2, r % 2 === 0 ? r : r + 1);
}
function resolveOutputDims(sourceW, sourceH, resolution, format, effects) {
  const safeSrcW = sourceW > 0 ? sourceW : 1920;
  const safeSrcH = sourceH > 0 ? sourceH : 1080;
  const vertical = format === "TikTok 9:16" || effects.verticalExport === true;
  if (vertical) {
    return {
      canvasW: resolution === "4K" ? 2160 : 1080,
      canvasH: resolution === "4K" ? 3840 : 1920,
      cropped: true,
      mode: "crop-9:16"
    };
  }
  if (format === "YouTube 16:9" || format === "Custom") {
    return {
      canvasW: resolution === "4K" ? 3840 : 1920,
      canvasH: resolution === "4K" ? 2160 : 1080,
      cropped: true,
      mode: "crop-16:9"
    };
  }
  const longEdge = resolution === "4K" ? 3840 : 1920;
  const aspect = safeSrcW / safeSrcH;
  let canvasW;
  let canvasH;
  if (aspect >= 1) {
    canvasW = longEdge;
    canvasH = longEdge / aspect;
  } else {
    canvasH = longEdge;
    canvasW = longEdge * aspect;
  }
  return {
    canvasW: even(canvasW),
    canvasH: even(canvasH),
    cropped: false,
    mode: "source"
  };
}

// ../../src/lib/timeline/canvas-layout.ts
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function resolveOutputCanvas(effects, legacyFormat) {
  if (effects.outputCanvas) return effects.outputCanvas;
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
function legacyCanvas(ar) {
  const [width, height] = ar === "9:16" ? [1080, 1920] : [1920, 1080];
  return {
    aspectRatio: ar,
    width,
    height,
    fitMode: "fill",
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    backgroundMode: "blur"
  };
}
var RATIO = {
  "16:9": [16, 9],
  "9:16": [9, 16],
  "1:1": [1, 1],
  "4:5": [4, 5]
};
function resolveCanvasDims(sourceW, sourceH, aspectRatio, resolution, custom) {
  const longEdge = resolution === "4K" ? 3840 : 1920;
  let rw;
  let rh;
  if (aspectRatio === "custom") {
    rw = custom && custom.width > 0 ? custom.width : sourceW > 0 ? sourceW : 1920;
    rh = custom && custom.height > 0 ? custom.height : sourceH > 0 ? sourceH : 1080;
  } else {
    [rw, rh] = RATIO[aspectRatio];
  }
  let canvasW;
  let canvasH;
  if (rw >= rh) {
    canvasW = longEdge;
    canvasH = longEdge * rh / rw;
  } else {
    canvasH = longEdge;
    canvasW = longEdge * rw / rh;
  }
  return { canvasW: even(canvasW), canvasH: even(canvasH) };
}
function containDims(sourceW, sourceH, canvasW, canvasH) {
  const sA = (sourceW > 0 ? sourceW : 1) / (sourceH > 0 ? sourceH : 1);
  const cA = canvasW / canvasH;
  if (sA > cA) {
    return { drawW: canvasW, drawH: canvasW / sA };
  }
  return { drawW: canvasH * sA, drawH: canvasH };
}
function clampPan(off, draw, canv) {
  const half = Math.max(0, (draw - canv) / 2);
  return clamp(off, -half, half);
}
function resolveCanvasPlacement(sourceW, sourceH, canvasW, canvasH, oc, smart) {
  const mode = oc.fitMode === "smart-fit" && smart?.fallbackToBlur ? "fit" : oc.fitMode;
  if (mode === "fill") {
    const { drawW: drawW2, drawH: drawH2 } = coverFitDims(sourceW, sourceH, canvasW, canvasH);
    return { drawW: drawW2, drawH: drawH2, baseOffsetX: 0, baseOffsetY: 0, hasLetterbox: false };
  }
  if (mode === "fit") {
    const { drawW: drawW2, drawH: drawH2 } = containDims(sourceW, sourceH, canvasW, canvasH);
    return {
      drawW: drawW2,
      drawH: drawH2,
      baseOffsetX: 0,
      baseOffsetY: 0,
      hasLetterbox: drawW2 < canvasW - 1 || drawH2 < canvasH - 1
    };
  }
  if (mode === "smart-fit") {
    const { drawW: drawW2, drawH: drawH2 } = coverFitDims(sourceW, sourceH, canvasW, canvasH);
    return {
      drawW: drawW2,
      drawH: drawH2,
      baseOffsetX: clampPan((smart?.offsetX ?? 0) * canvasW, drawW2, canvasW),
      baseOffsetY: clampPan((smart?.offsetY ?? 0) * canvasH, drawH2, canvasH),
      hasLetterbox: false
    };
  }
  const base = containDims(sourceW, sourceH, canvasW, canvasH);
  const s = clamp(oc.scale || 1, 0.25, 4);
  const drawW = base.drawW * s;
  const drawH = base.drawH * s;
  return {
    drawW,
    drawH,
    baseOffsetX: clamp(oc.offsetX || 0, -1, 1) * canvasW,
    baseOffsetY: clamp(oc.offsetY || 0, -1, 1) * canvasH,
    hasLetterbox: drawW < canvasW - 1 || drawH < canvasH - 1
  };
}
function computeSmartFitOffset(sourceW, sourceH, canvasW, canvasH, signals) {
  const sA = (sourceW > 0 ? sourceW : 16) / (sourceH > 0 ? sourceH : 9);
  const cA = canvasW / canvasH;
  const overflowX = sA > cA;
  const pts = signals.points.filter((p) => p.weight > 0 && isFinite(p.x) && isFinite(p.y));
  const totalW = pts.reduce((s, p) => s + p.weight, 0);
  if (pts.length === 0 || totalW <= 0) {
    return { offsetX: 0, offsetY: 0, scale: 1, fallbackToBlur: true };
  }
  const axis = (p) => overflowX ? p.x : p.y;
  const mean = pts.reduce((s, p) => s + p.weight * axis(p), 0) / totalW;
  const variance = pts.reduce((s, p) => s + p.weight * (axis(p) - mean) ** 2, 0) / totalW;
  const spread = Math.sqrt(Math.max(0, variance));
  const meanWeight = totalW / pts.length;
  const concentration = clamp(1 - spread / 0.3, 0, 1);
  const confidence = clamp(meanWeight * 0.5 + concentration * 0.5, 0, 1);
  if (confidence < 0.25) {
    return { offsetX: 0, offsetY: 0, scale: 1, fallbackToBlur: true };
  }
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
function buildSmartSignals(visualAnalysis, moments) {
  const points = [];
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
      const att = attention[i] ?? 0.5;
      const conf = cconf[i] ?? 0;
      if (cx[i] != null && cy[i] != null && conf > 0.15) {
        points.push({ x: cx[i], y: cy[i], weight: conf * (0.5 + 0.5 * att) });
      }
      const mot = motion[i] ?? 0;
      if (ccx[i] != null && ccy[i] != null && mot > 0.05) {
        points.push({
          x: ccx[i],
          y: ccy[i],
          weight: mot * 0.4 * (0.5 + 0.5 * att)
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
      weight: clamp(w, 0, 1) * 0.8
    });
  }
  return { points };
}

// ../../src/lib/timeline/source-crop.ts
function clamp2(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function clamp01(v) {
  return clamp2(v, 0, 1);
}
function resolveSourceRect(videoW, videoH, crop) {
  const W = videoW > 0 ? Math.floor(videoW) : 0;
  const H = videoH > 0 ? Math.floor(videoH) : 0;
  if (!W || !H || !crop?.enabled || !(crop.width > 0) || !(crop.height > 0)) {
    return { sx: 0, sy: 0, sWidth: W, sHeight: H, cropActive: false };
  }
  let sx = Math.round(clamp01(crop.x) * W);
  let sy = Math.round(clamp01(crop.y) * H);
  let sWidth = Math.round(clamp01(crop.width) * W);
  let sHeight = Math.round(clamp01(crop.height) * H);
  sx = Math.max(0, Math.min(sx, W - 2));
  sy = Math.max(0, Math.min(sy, H - 2));
  sWidth = Math.min(sWidth, W - sx);
  sHeight = Math.min(sHeight, H - sy);
  if (sWidth % 2 !== 0) sWidth -= 1;
  if (sHeight % 2 !== 0) sHeight -= 1;
  sWidth = Math.max(2, sWidth);
  sHeight = Math.max(2, sHeight);
  if (sx + sWidth > W) sx = W - sWidth;
  if (sy + sHeight > H) sy = H - sHeight;
  sx = Math.max(0, sx);
  sy = Math.max(0, sy);
  const cropActive = sx > 0 || sy > 0 || sWidth < W || sHeight < H;
  return { sx, sy, sWidth, sHeight, cropActive };
}

// ../../src/lib/timeline/crop-speed.ts
var DEFAULT_SPEED = {
  multiplier: 2,
  audioMode: "mute",
  transition: "cut"
};
var ASPECT_WH = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
  "4:5": 4 / 5
};
function activeSpeedAt(moments, t) {
  if (!moments) return null;
  let pick = null;
  for (const m of moments) {
    if (m.effectType !== "speed-up") continue;
    if (t < m.startTime || t > m.endTime) continue;
    if (!pick || m.startTime > pick.startTime) pick = m;
  }
  return pick ? pick.speed ?? DEFAULT_SPEED : null;
}
function isActiveCut(m) {
  return m.effectType === "cut" && m.cut?.active !== false;
}
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}
function buildTimelineMap(moments, sourceDuration) {
  const dur = Math.max(0, sourceDuration);
  const list = moments ?? [];
  const activeCuts = list.filter(isActiveCut).length;
  const inactiveCuts = list.filter(
    (m) => m.effectType === "cut" && m.cut?.active === false
  ).length;
  if (dur <= 0) {
    return { segments: [], sourceDuration: dur, outputDuration: 0, totalRemoved: 0, activeCuts, inactiveCuts };
  }
  const cutRanges = mergeRanges(
    list.filter(isActiveCut).map((m) => ({
      start: Math.max(0, Math.min(dur, m.startTime)),
      end: Math.max(0, Math.min(dur, m.endTime))
    })).filter((r) => r.end > r.start)
  );
  const totalRemoved = cutRanges.reduce((a, r) => a + (r.end - r.start), 0);
  const included = [];
  let cursor = 0;
  for (const r of cutRanges) {
    if (r.start > cursor) included.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < dur) included.push({ start: cursor, end: dur });
  const speeds = list.filter((m) => m.effectType === "speed-up").map((m) => ({
    start: Math.max(0, Math.min(dur, m.startTime)),
    end: Math.max(0, Math.min(dur, m.endTime)),
    mult: Math.max(1, m.speed?.multiplier ?? DEFAULT_SPEED.multiplier)
  })).filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const speedAt = (t) => {
    let mult = 1;
    let bestStart = -Infinity;
    for (const s of speeds) {
      if (t >= s.start && t < s.end && s.start > bestStart) {
        mult = s.mult;
        bestStart = s.start;
      }
    }
    return mult;
  };
  const segments = [];
  let outAcc = 0;
  for (const inc of included) {
    const bounds = /* @__PURE__ */ new Set([inc.start, inc.end]);
    for (const s of speeds) {
      if (s.start > inc.start && s.start < inc.end) bounds.add(s.start);
      if (s.end > inc.start && s.end < inc.end) bounds.add(s.end);
    }
    const sorted = [...bounds].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const sStart = sorted[i];
      const sEnd = sorted[i + 1];
      if (sEnd <= sStart) continue;
      const mult = speedAt((sStart + sEnd) / 2);
      const outLen = (sEnd - sStart) / mult;
      segments.push({
        sourceStart: sStart,
        sourceEnd: sEnd,
        outputStart: outAcc,
        outputEnd: outAcc + outLen,
        speedMultiplier: mult
      });
      outAcc += outLen;
    }
  }
  return {
    segments,
    sourceDuration: dur,
    outputDuration: outAcc,
    totalRemoved,
    activeCuts,
    inactiveCuts
  };
}

// ../../src/lib/render/recipe.ts
function safeSourceRect(vw, vh, crop) {
  const rect = resolveSourceRect(vw, vh, crop ?? void 0);
  const { sx, sy, sWidth, sHeight } = rect;
  const finite = Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sWidth) && Number.isFinite(sHeight);
  if (!finite || sWidth <= 0 || sHeight <= 0 || sx + sWidth > vw || sy + sHeight > vh) {
    console.warn("[render-recipe] invalid source rect \u2014 clamping to full frame", {
      rect,
      videoWidth: vw,
      videoHeight: vh
    });
    return { sx: 0, sy: 0, sWidth: vw, sHeight: vh, cropActive: false };
  }
  return rect;
}
function buildRenderRecipe(input) {
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
    applyWatermark
  } = input;
  const sourceRect = safeSourceRect(sourceWidth, sourceHeight, sourceCrop);
  const sourceW = sourceRect.sWidth;
  const sourceH = sourceRect.sHeight;
  const oc = resolveOutputCanvas(effects, format);
  let canvasW;
  let canvasH;
  let outMode;
  let outCropped;
  let placement = null;
  let smart;
  if (oc) {
    const dims = resolveCanvasDims(
      sourceW,
      sourceH,
      oc.aspectRatio,
      resolution,
      oc.aspectRatio === "custom" ? { width: oc.width, height: oc.height } : void 0
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
    outMode = `canvas-${oc.aspectRatio}/${oc.fitMode}${smart?.fallbackToBlur ? "\u2192fit" : ""}`;
    outCropped = !placement.hasLetterbox;
  } else {
    const out = resolveOutputDims(sourceW, sourceH, resolution, format, effects);
    canvasW = out.canvasW;
    canvasH = out.canvasH;
    outMode = out.mode;
    outCropped = out.cropped;
  }
  const effectiveFit = oc && oc.fitMode === "smart-fit" && smart?.fallbackToBlur ? "fit" : oc?.fitMode ?? "fill";
  const bgMode = smart?.fallbackToBlur ? "blur" : oc?.backgroundMode ?? "blur";
  const bgActive = !!placement && placement.hasLetterbox && (effectiveFit === "fit" || effectiveFit === "manual");
  const cover = coverFitDims(sourceW, sourceH, canvasW, canvasH);
  const base = placement ? {
    drawW: placement.drawW,
    drawH: placement.drawH,
    offsetX: placement.baseOffsetX,
    offsetY: placement.baseOffsetY
  } : { drawW: cover.drawW, drawH: cover.drawH, offsetX: 0, offsetY: 0 };
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
      clickHighlights: effects.clickHighlights === true,
      clickHighlightStyle: effects.clickHighlightStyle,
      clickHighlightSize: effects.clickHighlightSize,
      vignette: effects.vignette === true
    },
    applyWatermark,
    debugBorders: input.debugBorders === true,
    timelineMap
  };
}

// ../../src/lib/timeline/camera.ts
var IDENTITY_CAMERA = {
  scale: 1,
  panXPct: 0,
  panYPct: 0,
  cx: 0.5,
  cy: 0.5
};
var MAX_SCALE = 2.4;
var CROP_MAX_SCALE = 6;
var EDGE_FRACTION = 0.18;
var EDGE_MIN_S = 0.12;
var EDGE_MAX_S = 0.4;
function clamp012(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
function clampRange(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
function applyEase(kind, t) {
  const x = clamp012(t);
  switch (kind) {
    case "ease-in":
      return x * x;
    case "ease-out":
      return 1 - (1 - x) * (1 - x);
    case "ease-in-out":
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case "linear":
    default:
      return x;
  }
}
function scaleFromFocus(width, height, intensity) {
  const widthScale = width > 0 ? 1 / width : 1;
  const heightScale = height > 0 ? 1 / height : 1;
  const fit = Math.min(widthScale, heightScale);
  const target = Math.min(MAX_SCALE, Math.max(1.05, fit * 0.9));
  return 1 + (target - 1) * Math.max(0.3, Math.min(1, intensity));
}
function localProgress(m, t) {
  const dur = m.endTime - m.startTime;
  if (dur <= 0) return 0;
  return clamp012((t - m.startTime) / dur);
}
function bracket(kfs, p) {
  const sorted = [...kfs].sort((x, y) => x.t - y.t);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (p <= first.t) return { a: first, b: first, f: 0 };
  if (p >= last.t) return { a: last, b: last, f: 1 };
  for (let i = 0; i < sorted.length - 1; i++) {
    if (p >= sorted[i].t && p <= sorted[i + 1].t) {
      const span = sorted[i + 1].t - sorted[i].t;
      const localT = span > 0 ? (p - sorted[i].t) / span : 0;
      return {
        a: sorted[i],
        b: sorted[i + 1],
        f: applyEase(sorted[i + 1].ease, localT)
      };
    }
  }
  return { a: last, b: last, f: 1 };
}
function clampCenterToFrame(cx, cy, scale) {
  const half = 1 / (2 * Math.max(1, scale));
  const clampAxis = (v) => half >= 0.5 ? 0.5 : Math.max(half, Math.min(1 - half, v));
  return { cx: clampAxis(cx), cy: clampAxis(cy) };
}
function edgeEnvelope(localProg, durSec) {
  if (durSec <= 0) return 1;
  let edgeSec = clampRange(durSec * EDGE_FRACTION, EDGE_MIN_S, EDGE_MAX_S);
  if (edgeSec * 2 > durSec) edgeSec = durSec / 2;
  const edge = edgeSec / durSec;
  if (edge <= 0) return 1;
  if (localProg < edge) return applyEase("ease-in-out", localProg / edge);
  if (localProg > 1 - edge)
    return applyEase("ease-in-out", (1 - localProg) / edge);
  return 1;
}
function cropCamera(m, localProgressValue) {
  const box = m.focusRegion;
  const cxRaw = box.x + box.width / 2;
  const cyRaw = box.y + box.height / 2;
  const fill = box.width > 0 && box.height > 0 ? Math.max(1 / box.width, 1 / box.height) : 1;
  const targetScale = clampRange(fill, 1, CROP_MAX_SCALE);
  const { cx, cy } = clampCenterToFrame(cxRaw, cyRaw, targetScale);
  if (m.crop?.easing === "instant") {
    return {
      scale: targetScale,
      panXPct: (0.5 - cx) * 100,
      panYPct: (0.5 - cy) * 100,
      cx,
      cy
    };
  }
  const env = edgeEnvelope(
    clamp012(localProgressValue),
    Math.max(0, m.endTime - m.startTime)
  );
  return {
    scale: 1 + (targetScale - 1) * env,
    panXPct: (0.5 - cx) * 100 * env,
    panYPct: (0.5 - cy) * 100 * env,
    cx: 0.5 + (cx - 0.5) * env,
    cy: 0.5 + (cy - 0.5) * env
  };
}
function cameraForMoment(m, blendedIntensity, localProgressValue) {
  if (m.effectType === "crop") return cropCamera(m, localProgressValue);
  const kfs = m.keyframes;
  if (kfs && kfs.length > 0) {
    const { a, b, f } = bracket(kfs, clamp012(localProgressValue));
    const cxRaw2 = a.x + (b.x - a.x) * f;
    const cyRaw2 = a.y + (b.y - a.y) * f;
    const intensity = a.scale + (b.scale - a.scale) * f;
    const scale2 = scaleFromFocus(
      m.focusRegion.width,
      m.focusRegion.height,
      intensity
    );
    const { cx: cx2, cy: cy2 } = clampCenterToFrame(cxRaw2, cyRaw2, scale2);
    return {
      scale: scale2,
      panXPct: (0.5 - cx2) * 100,
      panYPct: (0.5 - cy2) * 100,
      cx: cx2,
      cy: cy2
    };
  }
  const cxRaw = m.focusRegion.x + m.focusRegion.width / 2;
  const cyRaw = m.focusRegion.y + m.focusRegion.height / 2;
  const targetScale = scaleFromFocus(
    m.focusRegion.width,
    m.focusRegion.height,
    blendedIntensity
  );
  const { cx, cy } = clampCenterToFrame(cxRaw, cyRaw, targetScale);
  const env = edgeEnvelope(
    clamp012(localProgressValue),
    Math.max(0, m.endTime - m.startTime)
  );
  const scale = 1 + (targetScale - 1) * env;
  const targetPanXPct = (0.5 - cx) * 100;
  const targetPanYPct = (0.5 - cy) * 100;
  return {
    scale,
    panXPct: targetPanXPct * env,
    panYPct: targetPanYPct * env,
    cx: 0.5 + (cx - 0.5) * env,
    cy: 0.5 + (cy - 0.5) * env
  };
}
function resolveCameraFrame(moments, t, opts) {
  if (!moments || moments.length === 0) {
    return { camera: IDENTITY_CAMERA, moment: null };
  }
  const m = pickActiveMoment(moments, t);
  if (!m) return { camera: IDENTITY_CAMERA, moment: null };
  const blended = blendIntensity(m, opts.autoZoom);
  const camera = cameraForMoment(m, blended, localProgress(m, t));
  return { camera, moment: m };
}
function cameraPriority(m) {
  if (m.effectType === "crop") return m.source === "user" ? 5 : 4;
  return m.source === "user" ? 3 : 2;
}
function pickActiveMoment(moments, t) {
  const activeCuts = moments.filter(
    (m) => m.effectType === "cut" && m.cut?.active !== false
  );
  const insideActiveCut = (m) => activeCuts.some((c) => m.startTime >= c.startTime && m.endTime <= c.endTime);
  let pick = null;
  let pickPri = -1;
  for (const m of moments) {
    if (m.effectType === "speed-up" || m.effectType === "cut") continue;
    if (insideActiveCut(m)) continue;
    if (t < m.startTime || t > m.endTime) continue;
    const pri = cameraPriority(m);
    if (!pick || pri > pickPri || pri === pickPri && m.startTime > pick.startTime) {
      pick = m;
      pickPri = pri;
    }
  }
  return pick;
}
function blendIntensity(m, autoZoomPct) {
  const perMoment = m.intensity ?? m.recommendedIntensity ?? m.attentionScore ?? m.importance ?? 0.5;
  return perMoment * 0.6 + clamp012(autoZoomPct / 100) * 0.4;
}
function canvasTranslateFor(camera, drawW, drawH) {
  return {
    tx: (0.5 - camera.cx) * drawW,
    ty: (0.5 - camera.cy) * drawH
  };
}

// ../../src/lib/timeline/click-highlight.ts
var EDITOR_REFERENCE_W = 1280;
function clickHighlightGeometry(progress, sizePct, style) {
  const p = clamp013(progress);
  const size = clamp013(sizePct / 100);
  const base = 24 + size * 72;
  if (style === "pulse") {
    return {
      outer: { radius: (base + p * 80) / 2, opacity: 0.8 - p * 0.6 },
      innerRing: { radius: base * 0.55 / 2, opacity: 0.9 }
    };
  }
  if (style === "burst") {
    return {
      outer: { radius: (base + p * 120) / 2, opacity: 1 - p * 0.85 },
      spokes: { count: 10, innerRatio: 0.3, outerRatio: 0.48, opacity: 1 - p * 0.85 }
    };
  }
  return {
    outer: { radius: (base + p * 64) / 2, opacity: 1 - p * 0.7 }
  };
}
function drawClickHighlight(ctx, draw, drawW, drawH, canvasW) {
  const geom = clickHighlightGeometry(draw.progress, draw.sizePct, draw.style);
  const px = drawW * (draw.cx - 0.5);
  const py = drawH * (draw.cy - 0.5);
  const refScale = canvasW / EDITOR_REFERENCE_W;
  if (draw.style === "pulse") {
    ctx.save();
    ctx.fillStyle = `rgba(167, 139, 250, ${geom.outer.opacity.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(px, py, geom.outer.radius * refScale, 0, Math.PI * 2);
    ctx.fill();
    if (geom.innerRing) {
      ctx.strokeStyle = `rgba(221, 214, 254, ${geom.innerRing.opacity.toFixed(3)})`;
      ctx.lineWidth = 1.5 * refScale;
      ctx.beginPath();
      ctx.arc(px, py, geom.innerRing.radius * refScale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  if (draw.style === "burst") {
    if (!geom.spokes) return;
    ctx.save();
    ctx.strokeStyle = `rgba(196, 181, 253, ${geom.spokes.opacity.toFixed(3)})`;
    ctx.lineWidth = 3 * refScale;
    ctx.lineCap = "round";
    const r1 = geom.outer.radius * 2 * geom.spokes.innerRatio * refScale;
    const r2 = geom.outer.radius * 2 * geom.spokes.outerRatio * refScale;
    for (let i = 0; i < geom.spokes.count; i++) {
      const a = i / geom.spokes.count * Math.PI * 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(px + cos * r1, py + sin * r1);
      ctx.lineTo(px + cos * r2, py + sin * r2);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.strokeStyle = `rgba(167, 139, 250, ${geom.outer.opacity.toFixed(3)})`;
  ctx.lineWidth = 1.5 * refScale;
  ctx.beginPath();
  ctx.arc(px, py, geom.outer.radius * refScale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
function clamp013(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// ../../src/lib/render/compose-frame.ts
function composeFrame(ctx, frame, recipe, sourceTime) {
  const { canvasW, canvasH, bgActive, bgMode, backgroundColor, sourceRect, effects, applyWatermark, debugBorders } = recipe;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvasW, canvasH);
  if (bgActive) {
    drawCanvasBackground(
      ctx,
      frame,
      bgMode,
      backgroundColor,
      canvasW,
      canvasH,
      sourceRect.sx,
      sourceRect.sy,
      sourceRect.sWidth,
      sourceRect.sHeight
    );
  }
  applyCameraFrame(ctx, frame, recipe, sourceTime);
  if (debugBorders) drawDebugCanvasBorder(ctx, canvasW, canvasH);
  if (effects.vignette) drawVignette(ctx, canvasW, canvasH);
  if (applyWatermark) drawWatermark(ctx, canvasW, canvasH);
}
function applyCameraFrame(ctx, frame, recipe, t) {
  const { moments, effects, canvasW, canvasH, base, sourceRect, debugBorders } = recipe;
  const { camera, moment } = resolveCameraFrame(moments, t, {
    autoZoom: effects.autoZoom
  });
  const { tx, ty } = canvasTranslateFor(camera, base.drawW, base.drawH);
  ctx.save();
  ctx.translate(canvasW / 2 + base.offsetX, canvasH / 2 + base.offsetY);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(tx, ty);
  ctx.drawImage(
    frame,
    sourceRect.sx,
    sourceRect.sy,
    sourceRect.sWidth,
    sourceRect.sHeight,
    -base.drawW / 2,
    -base.drawH / 2,
    base.drawW,
    base.drawH
  );
  if (debugBorders) {
    ctx.lineWidth = 4 / camera.scale;
    ctx.strokeStyle = "rgba(255,0,0,0.95)";
    ctx.strokeRect(-base.drawW / 2, -base.drawH / 2, base.drawW, base.drawH);
  }
  if (effects.clickHighlights && moment && moment.effectType === "click-highlight") {
    const dur = Math.max(0.1, moment.endTime - moment.startTime);
    drawClickHighlight(
      ctx,
      {
        cx: moment.focusRegion.x + moment.focusRegion.width / 2,
        cy: moment.focusRegion.y + moment.focusRegion.height / 2,
        progress: Math.max(0, Math.min(1, (t - moment.startTime) / dur)),
        style: effects.clickHighlightStyle,
        sizePct: effects.clickHighlightSize
      },
      base.drawW,
      base.drawH,
      canvasW
    );
  }
  ctx.restore();
}
function drawCanvasBackground(ctx, frame, bgMode, backgroundColor, canvasW, canvasH, sourceX, sourceY, sourceW, sourceH) {
  if (bgMode === "blur") {
    const bg = coverFitDims(sourceW, sourceH, canvasW, canvasH);
    const k = 1.08;
    ctx.save();
    ctx.filter = "blur(40px) brightness(0.7)";
    ctx.drawImage(
      frame,
      sourceX,
      sourceY,
      sourceW,
      sourceH,
      canvasW / 2 - bg.drawW * k / 2,
      canvasH / 2 - bg.drawH * k / 2,
      bg.drawW * k,
      bg.drawH * k
    );
    ctx.filter = "none";
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.fillStyle = bgMode === "solid" ? backgroundColor || "#000000" : bgMode === "light" ? "#f5f5f5" : "#0a0a0a";
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.restore();
}
function drawVignette(ctx, canvasW, canvasH) {
  const gradient = ctx.createRadialGradient(
    canvasW / 2,
    canvasH / 2,
    Math.min(canvasW, canvasH) * 0.6,
    canvasW / 2,
    canvasH / 2,
    Math.max(canvasW, canvasH) / 2
  );
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,0.25)");
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.restore();
}
function drawDebugCanvasBorder(ctx, canvasW, canvasH) {
  const lw = 4;
  ctx.save();
  ctx.lineWidth = lw;
  ctx.strokeStyle = "rgba(0,120,255,0.95)";
  ctx.strokeRect(lw / 2, lw / 2, canvasW - lw, canvasH - lw);
  ctx.restore();
}
function drawWatermark(ctx, canvasW, canvasH) {
  const fontSize = Math.max(18, Math.round(canvasH * 0.024));
  const padX = Math.round(fontSize * 0.9);
  const padY = Math.round(fontSize * 0.45);
  const text = "Made with Framevo";
  ctx.save();
  ctx.font = `600 ${fontSize}px -apple-system, "Segoe UI", system-ui, sans-serif`;
  const textW = ctx.measureText(text).width;
  const boxW = textW + padX * 2;
  const boxH = fontSize + padY * 2;
  const x = canvasW - boxW - Math.round(canvasH * 0.035);
  const y = canvasH - boxH - Math.round(canvasH * 0.035);
  const r = boxH / 2;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + boxW - r, y);
  ctx.arcTo(x + boxW, y, x + boxW, y + r, r);
  ctx.lineTo(x + boxW, y + boxH - r);
  ctx.arcTo(x + boxW, y + boxH, x + boxW - r, y + boxH, r);
  ctx.lineTo(x + r, y + boxH);
  ctx.arcTo(x, y + boxH, x, y + boxH - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(196,181,253,1)";
  const dotR = Math.round(fontSize * 0.32);
  ctx.beginPath();
  ctx.arc(x + padX + dotR / 2, y + boxH / 2, dotR / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padX + dotR + Math.round(fontSize * 0.45), y + boxH / 2);
  ctx.restore();
}

// ../../src/lib/export/chunk-plan.ts
var SUPPORTED_CHUNK_EFFECT_TYPES = [
  "zoom",
  "click-highlight",
  "cursor-focus",
  "speed-up",
  "cut",
  "crop"
];

// src/ffmpeg.ts
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
var execFileP = promisify(execFile);
var EXEC_OPTS = { timeout: 6e4, maxBuffer: 32 * 1024 * 1024 };
function resolveBinary(p, fallback) {
  return p && existsSync(p) ? p : fallback;
}
function ffmpegBin() {
  return resolveBinary(ffmpegStatic, "ffmpeg");
}
function ffprobeBin() {
  return resolveBinary(ffprobeStatic?.path, "ffprobe");
}
var AUDIO_UNSUPPORTED_WARNING = "This video's audio could not be processed, so the exported video will be silent.";
var UNDECODABLE_AUDIO = /* @__PURE__ */ new Set(["", "none", "unknown", "apac"]);
function isUnsupportedAudioCodec(codec, tag) {
  return UNDECODABLE_AUDIO.has((codec ?? "").toLowerCase()) || (tag ?? "").toLowerCase() === "apac";
}
function parseRate(raw) {
  if (!raw) return 0;
  const [n, d] = raw.split("/");
  const num = Number(n);
  const den = d === void 0 ? 1 : Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}
async function probeSource(path) {
  let stdout;
  try {
    ({ stdout } = await execFileP(
      ffprobeBin(),
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
      EXEC_OPTS
    ));
  } catch (err) {
    const detail = err.stderr ?? err.message ?? "";
    console.error("[worker:preflight] ffprobe failed", String(detail).slice(-2e3));
    throw new Error("preflight: could not read source video (ffprobe failed)");
  }
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error("preflight: could not read source video (unparseable ffprobe output)");
  }
  const streams = json.streams ?? [];
  const videoStreams = streams.filter(
    (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1
  );
  const v = videoStreams[0];
  const a = streams.find((s) => s.codec_type === "audio");
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    durationSec: Number(json.format?.duration ?? 0),
    videoCodec: v?.codec_name ?? "",
    fps: parseRate(v?.r_frame_rate) || parseRate(v?.avg_frame_rate),
    nbVideoStreams: videoStreams.length,
    nbAudioStreams: streams.filter((s) => s.codec_type === "audio").length,
    hasAudio: !!a,
    audioSampleRate: a?.sample_rate ? Number(a.sample_rate) : 48e3,
    audioChannels: a?.channels ?? 0,
    audioCodec: a?.codec_name ?? "",
    audioCodecTag: a?.codec_tag_string ?? "",
    bitrate: Number(json.format?.bit_rate ?? 0)
  };
}
async function probeAudioStreams(path) {
  let stdout;
  try {
    ({ stdout } = await execFileP(
      ffprobeBin(),
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "a", path],
      EXEC_OPTS
    ));
  } catch {
    return [];
  }
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    return [];
  }
  return (json.streams ?? []).map((s, i) => ({
    audioIndex: i,
    codec: s.codec_name ?? "",
    tag: s.codec_tag_string ?? "",
    channels: s.channels ?? 0,
    sampleRate: s.sample_rate ? Number(s.sample_rate) : 0
  }));
}
async function canDecodeAudioStream(path, audioIndex) {
  try {
    await execFileP(
      ffmpegBin(),
      [
        "-hide_banner",
        "-v",
        "error",
        "-i",
        path,
        "-map",
        `0:a:${audioIndex}`,
        // Decode a brief slice only — enough to prove the decoder works.
        "-t",
        "0.5",
        "-f",
        "null",
        "-"
      ],
      EXEC_OPTS
    );
    return true;
  } catch {
    return false;
  }
}
async function canDecodeAudio(path) {
  return canDecodeAudioStream(path, 0);
}
async function canDecodeVideo(path) {
  try {
    await execFileP(
      ffmpegBin(),
      ["-hide_banner", "-v", "error", "-i", path, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"],
      EXEC_OPTS
    );
    return true;
  } catch {
    return false;
  }
}
var NORMALIZE_EXEC_OPTS = {
  timeout: 20 * 6e4,
  maxBuffer: 16 * 1024 * 1024
};
function normalizeArgs(sourcePath, outputPath, audioMap, crf, preset) {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    sourcePath,
    // Exactly one real video stream + (optionally) one chosen audio stream.
    "-map",
    "0:v:0",
    ...audioMap !== null ? ["-map", `0:a:${audioMap}`] : [],
    // Strip subtitles, data streams, and global/stream metadata.
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    ...audioMap !== null ? ["-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "192k"] : ["-an"],
    "-movflags",
    "+faststart",
    "-y",
    outputPath
  ];
}
function normalizeTail(err) {
  const e = err;
  return (e.stderr || e.message || "").toString().trim();
}
async function normalizeSource(opts) {
  const { sourcePath, outputPath, crf, preset } = opts;
  const exec = { ...NORMALIZE_EXEC_OPTS, signal: opts.signal };
  const streams = await probeAudioStreams(sourcePath);
  const hadAudio = streams.length > 0;
  const ranked = [
    ...streams.filter((s) => s.codec.toLowerCase() === "aac"),
    ...streams.filter((s) => s.codec.toLowerCase() !== "aac")
  ];
  let chosen = null;
  for (const s of ranked) {
    if (isUnsupportedAudioCodec(s.codec, s.tag)) continue;
    if (await canDecodeAudioStream(sourcePath, s.audioIndex)) {
      chosen = s.audioIndex;
      break;
    }
  }
  console.info("[worker:normalize] audio-select", {
    audioStreams: streams.map((s) => `${s.audioIndex}:${s.codec || s.tag || "?"}`),
    chosen
  });
  if (chosen !== null) {
    try {
      await execFileP(ffmpegBin(), normalizeArgs(sourcePath, outputPath, chosen, crf, preset), exec);
      return { audioStatus: "preserved", warnings: [] };
    } catch (err) {
      console.warn(
        "[worker:normalize] audio transcode failed despite probe \u2014 retrying silent",
        normalizeTail(err).slice(-1e3)
      );
    }
  }
  try {
    await execFileP(ffmpegBin(), normalizeArgs(sourcePath, outputPath, null, crf, preset), exec);
  } catch (err) {
    const detail = normalizeTail(err);
    console.error("[worker:normalize] video-only pass failed", detail.slice(-4e3));
    throw new Error(`unsupported_video: normalize failed: ${detail.slice(-500)}`);
  }
  return hadAudio ? { audioStatus: "removed", warnings: [AUDIO_UNSUPPORTED_WARNING] } : { audioStatus: "none", warnings: [] };
}
function makeFrameReader(stream, frameBytes) {
  const MAX_BACKLOG = frameBytes * 3;
  const chunks = [];
  let bufferedLen = 0;
  let ended = false;
  let errored = null;
  let paused = false;
  let waiter = null;
  const wake = () => {
    const w = waiter;
    waiter = null;
    if (w) w();
  };
  stream.on("data", (chunk) => {
    chunks.push(chunk);
    bufferedLen += chunk.length;
    if (bufferedLen >= MAX_BACKLOG && !paused) {
      paused = true;
      stream.pause();
    }
    wake();
  });
  stream.on("end", () => {
    ended = true;
    wake();
  });
  stream.on("close", () => {
    ended = true;
    wake();
  });
  stream.on("error", (err) => {
    errored = err;
    ended = true;
    wake();
  });
  const reuse = Buffer.allocUnsafe(frameBytes);
  const takeFrame = () => {
    let off = 0;
    while (off < frameBytes) {
      const c = chunks[0];
      const need = frameBytes - off;
      if (c.length <= need) {
        c.copy(reuse, off);
        off += c.length;
        chunks.shift();
      } else {
        c.copy(reuse, off, 0, need);
        chunks[0] = c.subarray(need);
        off += need;
      }
    }
    bufferedLen -= frameBytes;
    return reuse;
  };
  return {
    async next() {
      for (; ; ) {
        if (errored) throw errored;
        if (bufferedLen >= frameBytes) {
          const frame = takeFrame();
          if (paused && bufferedLen < MAX_BACKLOG) {
            paused = false;
            stream.resume();
          }
          return frame;
        }
        if (ended) return null;
        await new Promise((resolve) => {
          waiter = resolve;
        });
      }
    },
    bufferedFrames() {
      return Math.floor(bufferedLen / frameBytes);
    },
    destroy() {
      stream.destroy();
    }
  };
}
function spawnDecoder(path, fps, width, height, startSec) {
  const seekArgs = typeof startSec === "number" && startSec > 0 ? ["-ss", startSec.toFixed(6)] : [];
  const child = spawn(
    ffmpegBin(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      // The decoder emits ONLY video — skip opening/analyzing the audio stream
      // so input setup (and the first frame) isn't delayed by it.
      "-an",
      // Input seek (fast) for chunked renders — placed BEFORE -i.
      ...seekArgs,
      "-i",
      path,
      // Force exact dims so each frame is exactly `width*height*4` bytes (the
      // FrameReader slices on that). Color-matrix parity tuning is deferred —
      // keep the filter minimal to reduce the failure surface.
      "-vf",
      `fps=${fps},scale=${width}:${height},format=rgba`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1"
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stderr.on("data", (d) => {
    const s = d.toString().trim();
    if (s) console.warn("[worker:decode]", s);
  });
  child.on("error", (err) => {
    try {
      child.stdout.destroy(err);
    } catch {
    }
  });
  child.on("close", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error("[worker:decode] ffmpeg decoder exited", { code, signal });
    }
  });
  return {
    reader: makeFrameReader(child.stdout, width * height * 4),
    child,
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }
  };
}
async function spawnEncoder(opts) {
  const { width, height, fps, outputPath, sourcePath, audio, crf, preset, audioWindow } = opts;
  let scriptPath = null;
  const args = [
    "-hide_banner",
    // `warning` (not `error`) so an audio-drop / filtergraph complaint shows up
    // in [worker:encode] instead of vanishing silently.
    "-loglevel",
    "warning",
    // Input 0: rawvideo from stdin.
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${width}x${height}`,
    "-r",
    String(fps),
    "-i",
    "pipe:0"
  ];
  if (audio.kind === "filter") {
    scriptPath = join(
      tmpdir(),
      `framevo-afc-${process.pid}-${Math.floor(Date.now())}.txt`
    );
    await writeFile(scriptPath, audio.filterComplex, "utf8");
    args.push(
      "-i",
      sourcePath,
      "-filter_complex_script",
      scriptPath,
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-c:a",
      "aac",
      "-b:a",
      "192k"
    );
  } else if (audio.kind === "direct") {
    if (audioWindow && audioWindow.startSec > 0) {
      args.push("-ss", String(audioWindow.startSec));
    }
    args.push(
      "-i",
      sourcePath,
      "-map",
      "0:v",
      "-map",
      "1:a:0?",
      "-c:a",
      "aac",
      "-b:a",
      "192k"
    );
  } else {
    args.push("-an");
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-r",
    String(fps),
    "-shortest",
    "-y",
    outputPath
  );
  const child = spawn(ffmpegBin(), args, {
    stdio: ["pipe", "ignore", "pipe"]
  });
  let stderrTail = "";
  child.stderr.on("data", (d) => {
    const s = d.toString();
    stderrTail = (stderrTail + s).slice(-4e3);
    const t = s.trim();
    if (t) console.warn("[worker:encode]", t);
  });
  let exitError = null;
  let hasExited = false;
  const exitPromise = new Promise((resolve) => {
    const done = () => {
      if (scriptPath) void unlink(scriptPath).catch(() => {
      });
      hasExited = true;
      resolve();
    };
    child.on("error", (err) => {
      if (!exitError) exitError = err;
      done();
    });
    child.on("close", (code) => {
      if (code !== 0 && !exitError) {
        exitError = new Error(`ffmpeg encoder exited ${code}: ${stderrTail.trim()}`);
      }
      if (code !== null && code !== 0) {
        console.error("[worker:encode] ffmpeg encoder exited", {
          code,
          tail: stderrTail.trim().slice(-1e3)
        });
      }
      done();
    });
  });
  const stdin = child.stdin;
  stdin.on("error", () => {
  });
  return {
    writeFrame(frame) {
      return new Promise((resolve, reject) => {
        if (hasExited) {
          reject(exitError ?? new Error("ffmpeg encoder exited before frame write."));
          return;
        }
        const ok = stdin.write(frame, (err) => {
          if (!err) {
            if (ok) resolve();
            return;
          }
          if (exitError) {
            reject(exitError);
            return;
          }
          Promise.race([
            exitPromise,
            new Promise((r) => setTimeout(r, 2e3))
          ]).then(() => reject(exitError ?? err));
        });
        if (!ok) stdin.once("drain", () => resolve());
      });
    },
    async finish() {
      await new Promise((resolve) => stdin.end(() => resolve()));
      await exitPromise;
      if (exitError) throw exitError;
    },
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      if (scriptPath) void unlink(scriptPath).catch(() => {
      });
    }
  };
}

// src/audio.ts
var EPS = 1e-3;
function atempoChain(mult) {
  const parts = [];
  let r = mult;
  while (r > 2 + 1e-9) {
    parts.push("atempo=2.0");
    r /= 2;
  }
  while (r < 0.5 - 1e-9) {
    parts.push("atempo=0.5");
    r /= 0.5;
  }
  parts.push(`atempo=${r.toFixed(6)}`);
  return parts;
}
function buildAudioFilterComplex(segments, moments, sampleRate, opts = {}) {
  if (!segments.length) return null;
  const chains = [];
  const labels = [];
  segments.forEach((seg, i) => {
    const mid = (seg.sourceStart + seg.sourceEnd) / 2;
    const sp = activeSpeedAt(moments, mid);
    const mult = seg.speedMultiplier;
    const mode = sp?.audioMode ?? "keep";
    const filters = [
      `atrim=start=${seg.sourceStart.toFixed(6)}:end=${seg.sourceEnd.toFixed(6)}`,
      "asetpts=PTS-STARTPTS"
    ];
    if (Math.abs(mult - 1) > EPS) {
      if (mode === "keep") {
        filters.push(`asetrate=${Math.round(sampleRate * mult)}`, `aresample=${sampleRate}`);
      } else {
        filters.push(...atempoChain(mult));
      }
    }
    if (mode === "mute") {
      filters.push("volume=0");
    }
    const out = `a${i}`;
    chains.push(`[1:a]${filters.join(",")}[${out}]`);
    labels.push(`[${out}]`);
  });
  const tail = opts.padToFill ? ",apad" : "";
  const concat = `${labels.join("")}concat=n=${labels.length}:v=0:a=1${tail}[aout]`;
  return [...chains, concat].join(";");
}

// src/preflight.ts
async function computePreflight(path) {
  const info = await probeSource(path);
  const [videoDecodable, audioDecodable] = await Promise.all([
    canDecodeVideo(path),
    info.hasAudio ? canDecodeAudio(path) : Promise.resolve(false)
  ]);
  const needsAudioDrop = info.hasAudio && (isUnsupportedAudioCodec(info.audioCodec, info.audioCodecTag) || !audioDecodable);
  const reasons = [];
  if (info.videoCodec && info.videoCodec !== "h264") {
    reasons.push(`video codec "${info.videoCodec}" is not h264`);
  }
  if (info.nbVideoStreams !== 1) {
    reasons.push(`unexpected video stream count: ${info.nbVideoStreams}`);
  }
  if (info.hasAudio && info.audioCodec !== "aac") {
    reasons.push(
      needsAudioDrop ? `audio codec "${info.audioCodec || info.audioCodecTag || "unknown"}" is undecodable` : `audio codec "${info.audioCodec}" is not aac`
    );
  }
  const pf = {
    info,
    risky: reasons.length > 0,
    reasons,
    videoDecodable,
    audioDecodable,
    needsAudioDrop
  };
  console.info("[worker:preflight]", {
    videoCodec: info.videoCodec,
    audioCodec: info.audioCodec || info.audioCodecTag || "(none)",
    width: info.width,
    height: info.height,
    fps: info.fps,
    durationSec: info.durationSec,
    videoStreams: info.nbVideoStreams,
    audioStreams: info.nbAudioStreams,
    videoDecodable,
    audioDecodable,
    risky: pf.risky,
    reasons
  });
  return pf;
}

// src/render.ts
var CanceledError = class extends Error {
  constructor() {
    super("Export canceled");
    this.name = "CanceledError";
  }
};
var STALL_MS = 9e4;
var PROGRESS_LOG_EVERY = 250;
var CHUNK_PROGRESS_LOG_MS = 1e4;
var LOW_FPS_WARN = 1;
var GC_EVERY = 50;
var MAX_RSS_MB = Number(process.env.RENDER_MAX_RSS_MB) || 4096;
var LEAK_SLOPE_MB = 400;
function resolveForceGc() {
  try {
    const existing = globalThis.gc;
    if (typeof existing === "function") return existing;
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc");
    v8.setFlagsFromString("--no-expose-gc");
    return typeof gc === "function" ? gc : null;
  } catch {
    return null;
  }
}
var forceGc = resolveForceGc();
function sourceTimeForOutput(map, outputTime) {
  const segs = map.segments;
  for (const s of segs) {
    if (outputTime >= s.outputStart && outputTime < s.outputEnd) {
      const st = s.sourceStart + (outputTime - s.outputStart) * s.speedMultiplier;
      return Math.min(s.sourceEnd, Math.max(s.sourceStart, st));
    }
  }
  const last = segs[segs.length - 1];
  return last ? last.sourceEnd : outputTime;
}
async function renderToMp4(opts) {
  const warnings = [];
  const recipe = buildRenderRecipe({ ...opts.serialized, debugBorders: false });
  const { canvasW, canvasH, sourceWidth, sourceHeight, fps, outputDuration, timelineMap } = recipe;
  const info = await probeSource(opts.sourcePath);
  if (!await canDecodeVideo(opts.sourcePath)) {
    console.error("[worker:decode] source video is undecodable \u2014 failing fast", {
      videoCodec: info.videoCodec,
      width: info.width,
      height: info.height
    });
    throw new Error("preflight: source video could not be decoded \u2014 no frames were produced");
  }
  let hasAudio = info.hasAudio;
  if (opts.audioAlreadyDropped) {
    hasAudio = false;
  } else if (!hasAudio) {
    warnings.push(
      "Source has no audio track \u2014 the export will be silent. This matches the source."
    );
  } else if (isUnsupportedAudioCodec(info.audioCodec, info.audioCodecTag) || !await canDecodeAudio(opts.sourcePath)) {
    hasAudio = false;
    warnings.push(AUDIO_UNSUPPORTED_WARNING);
    console.warn("[worker:audio] audio_dropped_unsupported", {
      codec: info.audioCodec || "(none)",
      tag: info.audioCodecTag || "(none)"
    });
  }
  const srcCanvas = createCanvas(sourceWidth, sourceHeight);
  const srcCtx = srcCanvas.getContext("2d");
  const outCanvas = createCanvas(canvasW, canvasH);
  const outCtx = outCanvas.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  const renderStartSec = opts.chunk ? Math.max(0, opts.chunk.renderStartSec) : 0;
  const seekSourceTime = opts.chunk ? sourceTimeForOutput(timelineMap, renderStartSec) : 0;
  const decoder = spawnDecoder(
    opts.sourcePath,
    fps,
    sourceWidth,
    sourceHeight,
    opts.chunk ? seekSourceTime : void 0
  );
  const hasSpeed = recipe.moments.some((m) => m.effectType === "speed-up");
  const hasCuts = timelineMap.totalRemoved > 0;
  if (opts.chunk) {
    const supported = new Set(SUPPORTED_CHUNK_EFFECT_TYPES);
    const unsupported = [
      ...new Set(recipe.moments.map((m) => m.effectType))
    ].filter((t) => !supported.has(t));
    if (unsupported.length > 0) {
      throw new Error(
        `chunk_unsupported_effects: timeline has effect types the chunk renderer can't reproduce: ${unsupported.join(", ")}`
      );
    }
  }
  let audio;
  if (opts.chunk || !hasAudio) {
    audio = { kind: "none" };
  } else if (!hasSpeed && !hasCuts) {
    audio = { kind: "direct" };
  } else {
    const fc = buildAudioFilterComplex(
      timelineMap.segments,
      recipe.moments,
      info.audioSampleRate
    );
    audio = fc ? { kind: "filter", filterComplex: fc } : { kind: "direct" };
  }
  console.info("[worker:audio]", {
    hasAudio,
    mode: audio.kind,
    chunked: !!opts.chunk,
    hasSpeed,
    hasCuts,
    segments: timelineMap.segments.length,
    sampleRate: info.audioSampleRate
  });
  const totalFrames = Math.max(1, Math.round(outputDuration * fps));
  const renderStartFrame = opts.chunk ? Math.min(totalFrames, Math.max(0, Math.round(renderStartSec * fps))) : 0;
  const renderEndFrame = opts.chunk ? Math.min(totalFrames, Math.round(opts.chunk.renderEndSec * fps)) : totalFrames;
  const trimStartFrame = opts.chunk ? Math.min(totalFrames, Math.max(0, Math.round(opts.chunk.trimStartSec * fps))) : 0;
  const trimEndFrame = opts.chunk ? Math.min(totalFrames, Math.round(opts.chunk.trimEndSec * fps)) : totalFrames;
  const renderWindowFrames = Math.max(1, renderEndFrame - renderStartFrame);
  const emittedFrames = Math.max(1, trimEndFrame - trimStartFrame);
  const encoder = await spawnEncoder({
    width: canvasW,
    height: canvasH,
    fps,
    outputPath: opts.outputPath,
    sourcePath: opts.sourcePath,
    // Chunks are silent (audio is muxed globally after concat) ⇒ no audioWindow.
    audio,
    crf: opts.crf,
    preset: opts.preset
  });
  const frameBytes = sourceWidth * sourceHeight * 4;
  let decodedIndex = Math.round(seekSourceTime * fps) - 1;
  let currentFrame = null;
  let eof = false;
  async function frameForSourceTime(sourceTime) {
    const targetIndex = Math.round(sourceTime * fps);
    while (!eof && decodedIndex < targetIndex) {
      const f = await decoder.reader.next();
      if (f === null) {
        eof = true;
        break;
      }
      currentFrame = f;
      decodedIndex++;
    }
    return currentFrame;
  }
  let stalled = false;
  let watchdog;
  const killBoth = () => {
    decoder.kill();
    encoder.kill();
  };
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      killBoth();
    }, STALL_MS);
  };
  const onAbort = () => killBoth();
  opts.signal.addEventListener("abort", onAbort);
  let lastPct = -1;
  let wroteFirstFrame = false;
  let writtenFrames = 0;
  const renderStartMs = Date.now();
  const jobId = opts.jobId ?? "(unknown)";
  const chunkIndex = opts.chunk?.index ?? -1;
  const decodedStartIndex = Math.round(seekSourceTime * fps);
  let currentFrameIndex = renderStartFrame;
  let progressTimer;
  let lowFpsWarned = false;
  const rssSamples = [];
  try {
    if (opts.signal.aborted) throw new CanceledError();
    console.info("[worker:render-start]", {
      canvasW,
      canvasH,
      fps,
      totalFrames,
      audio: audio.kind,
      chunked: !!opts.chunk,
      ...opts.chunk ? {
        renderWindow: [renderStartFrame, renderEndFrame],
        trimWindow: [trimStartFrame, trimEndFrame],
        seekSourceTime: Number(seekSourceTime.toFixed(3))
      } : {}
    });
    opts.onProgress({ stage: "decoding", progress: 0.01 });
    console.info("[worker:chunk-loop-start]", {
      jobId,
      chunkIndex,
      renderStartFrame,
      renderEndFrame,
      framesExpected: renderWindowFrames,
      seekSourceTime: Number(seekSourceTime.toFixed(3)),
      outputStart: Number((opts.chunk?.trimStartSec ?? 0).toFixed(2)),
      outputEnd: Number((opts.chunk?.trimEndSec ?? outputDuration).toFixed(2))
    });
    progressTimer = setInterval(() => {
      const framesRendered = Math.max(0, currentFrameIndex - renderStartFrame);
      const elapsedSeconds = (Date.now() - renderStartMs) / 1e3;
      const renderFps2 = elapsedSeconds > 0 ? framesRendered / elapsedSeconds : 0;
      const remaining = renderFps2 > 0 ? (renderWindowFrames - framesRendered) / renderFps2 : -1;
      console.info("[worker:chunk-progress]", {
        jobId,
        chunkIndex,
        outputStart: Number((opts.chunk?.trimStartSec ?? 0).toFixed(2)),
        outputEnd: Number((opts.chunk?.trimEndSec ?? outputDuration).toFixed(2)),
        sourceSeekTime: Number(seekSourceTime.toFixed(2)),
        framesExpected: renderWindowFrames,
        framesRendered,
        renderFps: Number(renderFps2.toFixed(2)),
        elapsedSeconds: Number(elapsedSeconds.toFixed(1)),
        estimatedRemainingSeconds: remaining < 0 ? null : Number(remaining.toFixed(1))
      });
      if (!lowFpsWarned && elapsedSeconds > 30 && renderFps2 > 0 && renderFps2 < LOW_FPS_WARN) {
        lowFpsWarned = true;
        console.warn("[worker:chunk-diag] render_fps_extremely_low", {
          jobId,
          chunkIndex,
          renderFps: Number(renderFps2.toFixed(2)),
          framesRendered,
          framesExpected: renderWindowFrames
        });
      }
    }, CHUNK_PROGRESS_LOG_MS);
    if (typeof progressTimer.unref === "function") progressTimer.unref();
    armWatchdog();
    for (let i = renderStartFrame; i < renderEndFrame; i++) {
      if (opts.signal.aborted) throw new CanceledError();
      currentFrameIndex = i;
      const pct = Math.floor((i - renderStartFrame) / renderWindowFrames * 95);
      if (pct !== lastPct) {
        lastPct = pct;
        opts.onProgress({ stage: "rendering", progress: pct / 100 });
      }
      if (forceGc && i > 0 && i % GC_EVERY === 0) forceGc();
      if (i > 0 && i % PROGRESS_LOG_EVERY === 0) {
        const mem = process.memoryUsage();
        const rssMB = Math.round(mem.rss / 1048576);
        const queueLen = decoder.reader.bufferedFrames();
        console.info("[worker:progress]", {
          frame: i,
          totalFrames,
          pct,
          queueLen,
          rssMB,
          heapUsedMB: Math.round(mem.heapUsed / 1048576),
          externalMB: Math.round(mem.external / 1048576)
        });
        if (rssMB > MAX_RSS_MB) {
          throw new Error(
            `memory_leak_detected: RSS ${rssMB}MB exceeded ${MAX_RSS_MB}MB at frame ${i}/${totalFrames} \u2014 frames are not being released to ffmpeg`
          );
        }
        rssSamples.push(rssMB);
        if (rssSamples.length >= 4) {
          const [a, b, c, d] = rssSamples.slice(-4);
          if (b - a > LEAK_SLOPE_MB && c - b > LEAK_SLOPE_MB && d - c > LEAK_SLOPE_MB) {
            throw new Error(
              `memory_leak_detected: RSS rising ${a}\u2192${b}\u2192${c}\u2192${d}MB across heartbeats \u2014 frames are not being released to ffmpeg`
            );
          }
        }
      }
      const outputTime = i / fps;
      const sourceTime = sourceTimeForOutput(timelineMap, outputTime);
      const frame = await frameForSourceTime(sourceTime);
      if (i === renderStartFrame) {
        console.info("[worker:first-decoded-frame]", {
          afterMs: Date.now() - renderStartMs,
          decodedToIndex: decodedIndex
        });
      }
      if (frame && frame.length === frameBytes) {
        srcCtx.putImageData(
          new ImageData(
            new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.length),
            sourceWidth,
            sourceHeight
          ),
          0,
          0
        );
      }
      composeFrame(
        outCtx,
        srcCanvas,
        recipe,
        sourceTime
      );
      if (i === renderStartFrame) {
        console.info("[worker:first-composed-frame]", { afterMs: Date.now() - renderStartMs });
      }
      if (i >= trimStartFrame && i < trimEndFrame) {
        const composited = outCanvas.data();
        await encoder.writeFrame(composited);
        writtenFrames++;
        if (!wroteFirstFrame) {
          wroteFirstFrame = true;
          console.info("[worker:first-frame]", { afterMs: Date.now() - renderStartMs });
        }
      }
      armWatchdog();
    }
    opts.onProgress({ stage: "encoding", progress: 0.97 });
    await encoder.finish();
    decoder.kill();
    if (progressTimer) clearInterval(progressTimer);
    const elapsedMs = Date.now() - renderStartMs;
    const renderFps = elapsedMs > 0 ? writtenFrames / (elapsedMs / 1e3) : 0;
    if (opts.chunk) {
      console.info("[worker:chunk-complete]", {
        jobId,
        chunkIndex,
        outputStart: Number(opts.chunk.trimStartSec.toFixed(2)),
        outputEnd: Number(opts.chunk.trimEndSec.toFixed(2)),
        sourceSeekTime: Number(seekSourceTime.toFixed(2)),
        framesExpected: emittedFrames,
        framesEmitted: writtenFrames,
        framesRendered: renderWindowFrames,
        decodedFromIndex: decodedStartIndex,
        decodedToIndex: decodedIndex,
        chunkDurationSec: Number((writtenFrames / fps).toFixed(2)),
        renderFps: Number(renderFps.toFixed(2)),
        elapsedSeconds: Number((elapsedMs / 1e3).toFixed(1))
      });
      if (writtenFrames > emittedFrames * 1.05) {
        console.warn("[worker:chunk-diag] frames_emitted_exceeds_expected", {
          chunkIndex,
          framesEmitted: writtenFrames,
          framesExpected: emittedFrames
        });
      }
    }
    console.info("[worker:complete]", {
      outputWidth: canvasW,
      outputHeight: canvasH,
      fps,
      frames: totalFrames,
      ...opts.chunk ? { emittedFrames, renderedFrames: renderWindowFrames } : {},
      renderFps: Number(renderFps.toFixed(2)),
      elapsedMs,
      warnings: warnings.length
    });
    return { warnings, outputWidth: canvasW, outputHeight: canvasH, fps };
  } catch (err) {
    killBoth();
    if (opts.signal.aborted) throw new CanceledError();
    if (stalled) {
      throw new Error(
        "Render stalled \u2014 no frames were produced within the timeout. The source video may be unreadable or in an unsupported format."
      );
    }
    throw err;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (progressTimer) clearInterval(progressTimer);
    opts.signal.removeEventListener("abort", onAbort);
  }
}

// src/errors.ts
function toUserFacingError(err) {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (raw.includes("normalize_not_executed")) {
    return {
      code: "normalize_not_executed",
      message: "The export could not be prepared (normalization did not run). Please try again; if it persists the render service needs an update."
    };
  }
  if (raw.includes("memory_leak_detected")) {
    return {
      code: "memory_leak_detected",
      message: "The export ran out of memory and was stopped. Please try again \u2014 if it keeps happening, contact support."
    };
  }
  if (raw.includes("audio_missing_after_render")) {
    return {
      code: "audio_missing_after_render",
      message: "The export finished but its audio went missing. Please try again \u2014 if it keeps happening, contact support."
    };
  }
  if (raw.includes("normalize_failed")) {
    return {
      code: "normalize_failed",
      message: "We couldn't prepare this video for export. Please try again, or re-upload the file."
    };
  }
  if (raw.includes("upload_failed")) {
    return {
      code: "upload_failed",
      message: "The export rendered but couldn't be saved. Please try again."
    };
  }
  if (raw.includes("audio_decode_failed") || raw.includes("no decoder found") || raw.includes("could not find codec parameters") || raw.includes("initializing a simple filtergraph") || raw.includes("error initializing")) {
    return {
      code: "audio_decode_failed",
      message: "This video's audio is in a format we can't process. Please try exporting again \u2014 if it keeps failing, the audio track may be unsupported."
    };
  }
  if (raw.includes("unsupported_video")) {
    return {
      code: "unsupported_video",
      message: "We couldn't process this video's format. Please re-upload it or try a different file."
    };
  }
  if (raw.includes("could not be decoded") || raw.includes("preflight")) {
    return {
      code: "decode_failed",
      message: "We couldn't read this video \u2014 it may be corrupt or in a format we can't process. Please re-upload it or try a different file."
    };
  }
  if (raw.includes("stalled")) {
    return {
      code: "render_stalled",
      message: "The export stalled while rendering. The source video may be unreadable or in an unsupported format. Please try again."
    };
  }
  if (raw.includes("enoent") || raw.includes("spawn")) {
    return {
      code: "worker_error",
      message: "The export service hit a temporary problem. Please try again in a moment."
    };
  }
  if (raw.includes("epipe") || raw.includes("broken pipe") || raw.includes("write after end")) {
    return {
      code: "encoder_pipe_broken",
      message: "The export ended unexpectedly while encoding. Please try again."
    };
  }
  return {
    code: "render_failed",
    message: "Something went wrong while exporting your video. Please try again."
  };
}

// src/cli.ts
var RENDER_CLI_VERSION = "2025.06-normalize+canvasdata";
function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}
function toStderr(...args) {
  process.stderr.write(
    args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ") + "\n"
  );
}
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;
console.error = toStderr;
function runFfmpeg(args, tag, failCode) {
  return new Promise((resolve, reject) => {
    const child = spawn2(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    child.stderr.on("data", (d) => {
      tail = (tail + d.toString()).slice(-4e3);
      const t = d.toString().trim();
      if (t) toStderr(`[worker:${tag}]`, t);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${failCode}: ffmpeg exited ${code}: ${tail.trim().slice(-800)}`));
    });
  });
}
async function runConcat(spec) {
  const inputs = spec.inputs ?? [];
  if (inputs.length === 0) {
    emit({ type: "error", code: "concat_no_inputs", message: "No chunk inputs to concat." });
    process.exit(1);
  }
  for (const f of inputs) {
    if (!existsSync2(f)) {
      emit({ type: "error", code: "concat_missing_chunk", message: `Chunk missing: ${f}` });
      process.exit(1);
    }
  }
  emit({ type: "stage", name: "merging" });
  const listPath = join2(dirname(spec.outputPath), "concat-list.txt");
  const list = inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
  writeFileSync(listPath, list, "utf8");
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-y",
    spec.outputPath
  ];
  await runFfmpeg(args, "concat", "concat_failed");
  emit({ type: "done", warnings: [], merged: inputs.length });
  process.exit(0);
}
async function runAudioMux(spec, signal) {
  const videoPath = spec.videoPath ?? "";
  if (!videoPath || !existsSync2(videoPath)) {
    emit({ type: "error", code: "audiomux_no_video", message: `Merged video missing: ${videoPath}` });
    process.exit(1);
  }
  if (!spec.sourcePath || !existsSync2(spec.sourcePath)) {
    emit({ type: "error", code: "audiomux_no_source", message: `Audio source missing: ${spec.sourcePath}` });
    process.exit(1);
  }
  emit({ type: "stage", name: "muxing-audio" });
  toStderr(
    `[worker:audiomux] start video=${videoPath} source=${spec.sourcePath} out=${spec.outputPath}`
  );
  const recipe = buildRenderRecipe({ ...spec.serializedRecipe, debugBorders: false });
  const { fps, outputDuration, timelineMap } = recipe;
  const hasSpeed = recipe.moments.some((m) => m.effectType === "speed-up");
  const hasCuts = timelineMap.totalRemoved > 0;
  let audioSource = spec.sourcePath;
  let audioStatus;
  if (spec.normalizeEnabled !== false) {
    const normPath = join2(dirname(spec.outputPath), "normalized-source.mp4");
    const norm = await normalizeSource({
      sourcePath: spec.sourcePath,
      outputPath: normPath,
      crf: spec.normalizeCrf ?? 18,
      preset: spec.normalizePreset ?? "veryfast",
      signal
    });
    audioSource = normPath;
    audioStatus = norm.audioStatus;
  } else {
    const probe = await probeSource(audioSource).catch(() => null);
    audioStatus = probe?.hasAudio ? "preserved" : "none";
  }
  const srcProbe = await probeSource(audioSource).catch(() => null);
  const sourceHasAudio = audioStatus === "preserved" && !!srcProbe?.hasAudio;
  const muxWarnings = [];
  if (audioStatus === "removed") {
    muxWarnings.push(AUDIO_UNSUPPORTED_WARNING);
    emit({ type: "warning", message: AUDIO_UNSUPPORTED_WARNING });
  }
  const args = ["-hide_banner", "-loglevel", "warning", "-i", videoPath];
  if (!sourceHasAudio) {
    args.push("-map", "0:v", "-c:v", "copy", "-movflags", "+faststart", "-y", spec.outputPath);
  } else {
    args.push("-i", audioSource);
    const sampleRate = srcProbe?.audioSampleRate ?? 48e3;
    const fc = !hasSpeed && !hasCuts ? null : buildAudioFilterComplex(timelineMap.segments, recipe.moments, sampleRate, {
      padToFill: true
    });
    if (fc) {
      const scriptPath = join2(dirname(spec.outputPath), "audiomux-afc.txt");
      writeFileSync(scriptPath, fc, "utf8");
      args.push("-filter_complex_script", scriptPath, "-map", "0:v", "-map", "[aout]");
    } else {
      args.push("-map", "0:v", "-map", "1:a:0?", "-af", "apad");
    }
    args.push(
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      "-y",
      spec.outputPath
    );
  }
  await runFfmpeg(args, "audiomux", "audiomux_failed");
  const outProbe = await probeSource(spec.outputPath).catch(() => null);
  const size = existsSync2(spec.outputPath) ? statSync(spec.outputPath).size : 0;
  if (!outProbe || size <= 0) {
    emit({ type: "error", code: "audiomux_failed", message: "audiomux produced no/empty output" });
    process.exit(1);
  }
  const outDur = outProbe.durationSec ?? 0;
  const tol = Math.max(0.5, 2 / fps);
  emit({
    type: "audio-verify",
    audioStatus: sourceHasAudio ? "preserved" : "none",
    sourceHasAudio,
    outputHasAudio: outProbe.hasAudio,
    outputAudioCodec: outProbe.audioCodec || "(none)",
    outputDurationSec: outDur,
    expectedDurationSec: outputDuration,
    durationDiffSec: Math.abs(outDur - outputDuration),
    fileSizeBytes: size
  });
  toStderr(
    `[worker:audiomux] audio-verify sourceAudio=${sourceHasAudio} outputAudio=${outProbe.hasAudio} outDur=${outDur.toFixed(2)} expected=${outputDuration.toFixed(2)} tol=${tol.toFixed(2)} size=${size}`
  );
  if (sourceHasAudio && !outProbe.hasAudio) {
    emit({
      type: "error",
      code: "audio_missing_after_render",
      message: "audio expected but the final muxed output is silent"
    });
    process.exit(1);
  }
  if (Math.abs(outDur - outputDuration) > tol) {
    emit({
      type: "error",
      code: "duration_mismatch",
      message: `final duration ${outDur.toFixed(2)}s differs from expected ${outputDuration.toFixed(2)}s by more than ${tol.toFixed(2)}s`
    });
    process.exit(1);
  }
  emit({
    type: "done",
    warnings: muxWarnings,
    merged: 1,
    normalized: spec.normalizeEnabled !== false,
    audioStatus: sourceHasAudio ? "preserved" : "none",
    outputDurationSec: outDur
  });
  process.exit(0);
}
async function main() {
  const build = process.env.BUILD_VERSION ?? "unknown";
  emit({ type: "version", cliVersion: RENDER_CLI_VERSION, build, node: process.version });
  toStderr(`[worker:cli] start version=${RENDER_CLI_VERSION} build=${build} node=${process.version}`);
  const specPath = process.argv[2];
  if (!specPath) {
    emit({ type: "error", code: "bad_invocation", message: "Missing job-spec path argument." });
    process.exit(1);
  }
  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (err) {
    emit({
      type: "error",
      code: "bad_invocation",
      message: "Unreadable job spec: " + err.message
    });
    process.exit(1);
  }
  if (spec.mode === "concat") {
    try {
      await runConcat(spec);
    } catch (err) {
      const friendly = toUserFacingError(err);
      toStderr("[worker:cli] concat failed:", err?.message ?? String(err));
      emit({ type: "error", code: friendly.code, message: friendly.message });
      process.exit(1);
    }
    return;
  }
  const controller = new AbortController();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim() === "cancel") {
      toStderr("[worker:cli] cancel requested");
      controller.abort();
    }
  });
  rl.on("error", () => {
  });
  if (spec.mode === "audiomux") {
    try {
      await runAudioMux(spec, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        emit({ type: "canceled" });
        rl.close();
        process.exit(2);
      }
      const friendly = toUserFacingError(err);
      toStderr("[worker:cli] audiomux failed:", err?.message ?? String(err));
      emit({ type: "error", code: friendly.code, message: friendly.message });
      rl.close();
      process.exit(1);
    }
    return;
  }
  const crf = spec.crf ?? 19;
  const preset = spec.preset ?? "veryfast";
  const chunkSilent = !!spec.chunk;
  const warnings = [];
  const pushWarning = (w) => {
    if (!warnings.includes(w)) {
      warnings.push(w);
      emit({ type: "warning", message: w });
    }
  };
  try {
    const pf = await computePreflight(spec.sourcePath);
    const audioCodec = pf.info.audioCodec || pf.info.audioCodecTag || "";
    emit({
      type: "preflight",
      videoCodec: pf.info.videoCodec,
      audioCodec,
      risky: pf.risky,
      videoDecodable: pf.videoDecodable,
      audioDecodable: pf.audioDecodable,
      needsAudioDrop: pf.needsAudioDrop,
      normalized: false
    });
    if (!pf.videoDecodable) {
      throw new Error("unsupported_video: source video could not be decoded");
    }
    const normPath = join2(dirname(spec.outputPath), "normalized-source.mp4");
    const expectNormalize = spec.normalizeEnabled !== false;
    let renderSource = spec.sourcePath;
    let audioStatus = pf.info.hasAudio ? pf.needsAudioDrop ? "removed" : "preserved" : "none";
    let normalized = false;
    if (expectNormalize) {
      emit({ type: "stage", name: "normalizing" });
      let norm;
      try {
        norm = await normalizeSource({
          sourcePath: spec.sourcePath,
          outputPath: normPath,
          crf: spec.normalizeCrf ?? 18,
          preset: spec.normalizePreset ?? "veryfast",
          signal: controller.signal
        });
      } catch (err) {
        if (controller.signal.aborted) throw err;
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`normalize_failed: ${detail}`);
      }
      renderSource = normPath;
      normalized = true;
      audioStatus = norm.audioStatus;
    }
    if (spec.audioAlreadyDropped && audioStatus === "preserved") audioStatus = "removed";
    const audioDropped = audioStatus !== "preserved";
    if (audioStatus === "removed" && !chunkSilent) pushWarning(AUDIO_UNSUPPORTED_WARNING);
    emit({
      type: "render-input",
      inputFile: spec.sourcePath,
      normalizedFile: normPath,
      renderSource,
      wasNormalizationRun: normalized
    });
    toStderr(
      `[worker:cli] render-input input=${spec.sourcePath} normalizedFile=${normPath} renderSource=${renderSource} wasNormalizationRun=${normalized}`
    );
    if (expectNormalize && (!normalized || renderSource !== normPath)) {
      throw new Error(
        `normalize_not_executed: normalizeEnabled but normalization did not run (renderSource=${renderSource})`
      );
    }
    if (normalized && !existsSync2(renderSource)) {
      throw new Error(`normalize_not_executed: normalized-source.mp4 missing at ${renderSource}`);
    }
    const startedMs = Date.now();
    let lastStage = "";
    let firstFrameEmitted = false;
    const result = await renderToMp4({
      serialized: spec.serializedRecipe,
      jobId: spec.jobId,
      sourcePath: renderSource,
      outputPath: spec.outputPath,
      crf,
      preset,
      signal: controller.signal,
      audioAlreadyDropped: audioDropped,
      chunk: spec.chunk,
      onProgress: ({ stage, progress }) => {
        if (stage !== lastStage) {
          lastStage = stage;
          emit({ type: "stage", name: stage });
          if (stage === "rendering" && !firstFrameEmitted) {
            firstFrameEmitted = true;
            emit({ type: "first-frame", ms: Date.now() - startedMs });
          }
        }
        emit({ type: "progress", value: progress });
      }
    });
    for (const w of result.warnings) pushWarning(w);
    const [renderSrcProbe, outProbe] = await Promise.all([
      probeSource(renderSource).catch(() => null),
      probeSource(spec.outputPath).catch(() => null)
    ]);
    const outDur = outProbe?.durationSec ?? 0;
    const srcDur = renderSrcProbe?.durationSec ?? 0;
    emit({
      type: "audio-verify",
      audioStatus,
      sourceHasAudio: pf.info.hasAudio,
      sourceAudioCodec: audioCodec || "(none)",
      normalizedHasAudio: renderSrcProbe?.hasAudio ?? null,
      outputHasAudio: outProbe?.hasAudio ?? null,
      outputAudioCodec: outProbe?.audioCodec || "(none)",
      outputDurationSec: outDur,
      videoDurationSec: srcDur,
      durationDiffSec: Math.abs(outDur - srcDur)
    });
    toStderr(
      `[worker:cli] audio-verify audioStatus=${audioStatus} sourceAudio=${pf.info.hasAudio} normalizedAudio=${renderSrcProbe?.hasAudio} outputAudio=${outProbe?.hasAudio} outputCodec=${outProbe?.audioCodec || "(none)"} outDur=${outDur.toFixed(2)} vidDur=${srcDur.toFixed(2)} diff=${Math.abs(outDur - srcDur).toFixed(2)}`
    );
    if (audioStatus === "preserved" && !chunkSilent && outProbe && !outProbe.hasAudio) {
      throw new Error(
        "audio_missing_after_render: render source has audio but final output has none"
      );
    }
    if (chunkSilent && spec.chunk) {
      const expectedDur = Math.max(0, spec.chunk.trimEndSec - spec.chunk.trimStartSec);
      const fileSize = existsSync2(spec.outputPath) ? statSync(spec.outputPath).size : 0;
      emit({
        type: "chunk-complete",
        chunkIndex: spec.chunk.index ?? -1,
        outputStartSec: spec.chunk.trimStartSec,
        outputEndSec: spec.chunk.trimEndSec,
        expectedDurationSec: Number(expectedDur.toFixed(2)),
        outputDurationSec: Number(outDur.toFixed(2)),
        fileSizeBytes: fileSize
      });
      toStderr(
        `[worker:cli] chunk-complete index=${spec.chunk.index ?? -1} outWindow=[${spec.chunk.trimStartSec.toFixed(2)},${spec.chunk.trimEndSec.toFixed(2)}] outDur=${outDur.toFixed(2)}s expected=${expectedDur.toFixed(2)}s size=${fileSize}B`
      );
      if (expectedDur > 0 && outDur > expectedDur * 1.5) {
        toStderr(
          `[worker:cli] WARN chunk_output_duration_unexpected index=${spec.chunk.index ?? -1} outDur=${outDur.toFixed(2)}s >> expected=${expectedDur.toFixed(2)}s \u2014 rendered outside the window?`
        );
        emit({ type: "warning", message: "chunk_output_duration_unexpected" });
      }
    }
    emit({
      type: "done",
      warnings,
      // Top-level normalized/audioStatus so the orchestrator reads them off the
      // flat event (no nested-preflight parse). Mirrored inside `preflight` too.
      normalized,
      audioStatus,
      preflight: { videoCodec: pf.info.videoCodec, audioCodec, risky: pf.risky, normalized, audioStatus }
    });
    rl.close();
    process.exit(0);
  } catch (err) {
    if (controller.signal.aborted) {
      emit({ type: "canceled" });
      rl.close();
      process.exit(2);
    }
    const friendly = toUserFacingError(err);
    toStderr("[worker:cli] render failed:", err?.message ?? String(err));
    emit({ type: "error", code: friendly.code, message: friendly.message });
    rl.close();
    process.exit(1);
  }
}
void main();
