import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);

// src/server.ts
import express from "express";

// src/config.ts
function loadConfig() {
  return {
    projectId: process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    port: Number(process.env.PORT ?? 8787),
    oidcAudience: process.env.WORKER_OIDC_AUDIENCE,
    invokerServiceAccount: process.env.EXPORT_INVOKER_SA,
    devDisableOidc: process.env.DEV_DISABLE_OIDC === "1",
    devSecret: process.env.EXPORT_WORKER_DEV_SECRET,
    pollEveryFrames: Number(process.env.WORKER_POLL_EVERY_FRAMES ?? 30),
    crf: Number(process.env.WORKER_X264_CRF ?? 19),
    preset: process.env.WORKER_X264_PRESET ?? "veryfast"
  };
}

// src/oidc.ts
import { OAuth2Client } from "google-auth-library";
var oauth = new OAuth2Client();
async function verifyRequestAuth(req, cfg) {
  if (cfg.devDisableOidc) {
    if (cfg.devSecret) {
      const got = req.header("x-export-dev-secret");
      if (got !== cfg.devSecret) return { ok: false, reason: "bad dev secret" };
    }
    return { ok: true };
  }
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return { ok: false, reason: "missing bearer token" };
  if (!cfg.oidcAudience) return { ok: false, reason: "WORKER_OIDC_AUDIENCE not set" };
  try {
    const ticket = await oauth.verifyIdToken({
      idToken: token,
      audience: cfg.oidcAudience
    });
    const payload = ticket.getPayload();
    if (!payload) return { ok: false, reason: "empty token payload" };
    if (cfg.invokerServiceAccount && payload.email !== cfg.invokerServiceAccount) {
      return { ok: false, reason: "unexpected token email" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `token verify failed: ${err.message}` };
  }
}

// src/handler.ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join2, extname } from "node:path";
import { FieldValue as FieldValue2 } from "firebase-admin/firestore";

// src/firebase.ts
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
var app;
function getAdmin() {
  const cfg = loadConfig();
  if (!app) {
    if (getApps().length) {
      app = getApps()[0];
    } else {
      const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
      const credential = b64 ? cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))) : applicationDefault();
      app = initializeApp({
        credential,
        projectId: cfg.projectId,
        storageBucket: cfg.storageBucket
      });
    }
  }
  return { app, db: getFirestore(app), bucketName: cfg.storageBucket };
}
function bucket() {
  const { app: app2, bucketName } = getAdmin();
  return getStorage(app2).bucket(bucketName);
}

// src/minutes.ts
import { FieldValue } from "firebase-admin/firestore";
async function releaseMinutes(db, uid, monthKey, minutes) {
  if (!(minutes > 0) || !monthKey) return;
  const ref = db.doc(`users/${uid}/usage/${monthKey}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const u = snap.data() ?? {};
    tx.set(
      ref,
      {
        cloudMinutesReserved: Math.max(0, (u.cloudMinutesReserved ?? 0) - minutes),
        updatedAt: Date.now()
      },
      { merge: true }
    );
  });
}

// src/render.ts
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
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
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
function resolveBinary(p, fallback) {
  return p && existsSync(p) ? p : fallback;
}
function ffmpegBin() {
  return resolveBinary(ffmpegStatic, "ffmpeg");
}
function ffprobeBin() {
  return resolveBinary(ffprobeStatic?.path, "ffprobe");
}
async function probeSource(path) {
  const { stdout } = await execFileP(ffprobeBin(), [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path
  ]);
  const json = JSON.parse(stdout);
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    durationSec: Number(json.format?.duration ?? 0),
    hasAudio: !!a,
    audioSampleRate: a?.sample_rate ? Number(a.sample_rate) : 48e3,
    audioCodec: a?.codec_name ?? "",
    audioCodecTag: a?.codec_tag_string ?? ""
  };
}
async function canDecodeAudio(path) {
  try {
    await execFileP(ffmpegBin(), [
      "-hide_banner",
      "-v",
      "error",
      "-i",
      path,
      "-map",
      "0:a:0",
      // Decode a brief slice only — enough to prove the decoder works without
      // processing the whole track.
      "-t",
      "0.5",
      "-f",
      "null",
      "-"
    ]);
    return true;
  } catch {
    return false;
  }
}
function makeFrameReader(stream, frameBytes) {
  const MAX_BACKLOG = frameBytes * 4;
  let buffered = Buffer.alloc(0);
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
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    if (buffered.length >= MAX_BACKLOG && !paused) {
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
  return {
    async next() {
      for (; ; ) {
        if (errored) throw errored;
        if (buffered.length >= frameBytes) {
          const frame = buffered.subarray(0, frameBytes);
          buffered = buffered.subarray(frameBytes);
          if (paused && buffered.length < MAX_BACKLOG) {
            paused = false;
            stream.resume();
          }
          return Buffer.from(frame);
        }
        if (ended) return null;
        await new Promise((resolve) => {
          waiter = resolve;
        });
      }
    },
    destroy() {
      stream.destroy();
    }
  };
}
function spawnDecoder(path, fps, width, height) {
  const child = spawn(
    ffmpegBin(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
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
  const { width, height, fps, outputPath, sourcePath, audio, crf, preset } = opts;
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
    args.push(
      "-i",
      sourcePath,
      "-map",
      "0:v",
      "-map",
      "1:a?",
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
function buildAudioFilterComplex(segments, moments, sampleRate) {
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
  const concat = `${labels.join("")}concat=n=${labels.length}:v=0:a=1[aout]`;
  return [...chains, concat].join(";");
}

// src/render.ts
var CanceledError = class extends Error {
  constructor() {
    super("Export canceled");
    this.name = "CanceledError";
  }
};
var STALL_MS = 9e4;
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
  let hasAudio = info.hasAudio;
  if (!hasAudio) {
    warnings.push(
      "Source has no audio track \u2014 the export will be silent. This matches the source."
    );
  } else if (!await canDecodeAudio(opts.sourcePath)) {
    hasAudio = false;
    const codec = info.audioCodec || info.audioCodecTag || "unknown";
    warnings.push(
      `Source audio codec "${codec}" is unsupported, exported without audio.`
    );
    console.warn("[worker:audio] unsupported codec \u2014 exporting silent", {
      codec: info.audioCodec,
      tag: info.audioCodecTag
    });
  }
  const srcCanvas = createCanvas(sourceWidth, sourceHeight);
  const srcCtx = srcCanvas.getContext("2d");
  const outCanvas = createCanvas(canvasW, canvasH);
  const outCtx = outCanvas.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  const decoder = spawnDecoder(opts.sourcePath, fps, sourceWidth, sourceHeight);
  const hasSpeed = recipe.moments.some((m) => m.effectType === "speed-up");
  const hasCuts = timelineMap.totalRemoved > 0;
  let audio;
  if (!hasAudio) {
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
    hasSpeed,
    hasCuts,
    segments: timelineMap.segments.length,
    sampleRate: info.audioSampleRate
  });
  const encoder = await spawnEncoder({
    width: canvasW,
    height: canvasH,
    fps,
    outputPath: opts.outputPath,
    sourcePath: opts.sourcePath,
    audio,
    crf: opts.crf,
    preset: opts.preset
  });
  const totalFrames = Math.max(1, Math.round(outputDuration * fps));
  const frameBytes = sourceWidth * sourceHeight * 4;
  let decodedIndex = -1;
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
  try {
    if (opts.signal.aborted) throw new CanceledError();
    armWatchdog();
    for (let i = 0; i < totalFrames; i++) {
      if (opts.signal.aborted) throw new CanceledError();
      const pct = Math.floor(i / totalFrames * 95);
      if (pct !== lastPct) {
        lastPct = pct;
        opts.onProgress({ stage: "rendering", progress: pct / 100 });
      }
      const outputTime = i / fps;
      const sourceTime = sourceTimeForOutput(timelineMap, outputTime);
      const frame = await frameForSourceTime(sourceTime);
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
      const img = outCtx.getImageData(0, 0, canvasW, canvasH);
      await encoder.writeFrame(
        Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength)
      );
      armWatchdog();
    }
    opts.onProgress({ stage: "encoding", progress: 0.97 });
    await encoder.finish();
    decoder.kill();
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
    opts.signal.removeEventListener("abort", onAbort);
  }
}

// src/handler.ts
var LEASE_MS = 30 * 60 * 1e3;
function toMs(v) {
  const t = v;
  return t?.toMillis?.() ?? 0;
}
async function claimJob(db, uid, jobId) {
  const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) return { action: "missing" };
    const job = snap.data();
    if (job.status === "ready" || job.status === "failed" || job.status === "canceled") {
      return { action: "terminal" };
    }
    if (job.status === "rendering" && Date.now() - toMs(job.startedAt) < LEASE_MS) {
      return { action: "leased" };
    }
    tx.update(jobRef, {
      status: "rendering",
      stage: "downloading",
      progress: 0,
      startedAt: FieldValue2.serverTimestamp(),
      updatedAt: FieldValue2.serverTimestamp()
    });
    return { action: "claimed", job };
  });
}
async function processJob(uid, jobId) {
  const cfg = loadConfig();
  const { db, bucketName } = getAdmin();
  const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);
  const claim = await claimJob(db, uid, jobId);
  if (claim.action !== "claimed") {
    console.info("[worker] skip", { uid, jobId, reason: claim.action });
    return claim.action;
  }
  const job = claim.job;
  const estimate = job.estimatedExportMinutes ?? 0;
  const monthKey = job.monthlyBucket;
  const controller = new AbortController();
  let polling = false;
  const cancelPoll = setInterval(() => {
    if (polling) return;
    polling = true;
    void jobRef.get().then((snap) => {
      const st = snap.exists ? snap.get("status") : void 0;
      if (!snap.exists || snap.get("cancelRequested") === true || st === "canceled" || st === "failed") {
        controller.abort();
        clearInterval(cancelPoll);
      }
    }).catch(() => {
    }).finally(() => {
      polling = false;
    });
  }, 1e3);
  const patch = (data) => jobRef.set({ ...data, updatedAt: FieldValue2.serverTimestamp() }, { merge: true });
  let workDir = null;
  try {
    workDir = await mkdtemp(join2(tmpdir2(), `framevo-job-${jobId}-`));
    const srcPath = join2(workDir, `source${extname(job.sourceStoragePath) || ".mp4"}`);
    const outPath = join2(workDir, `${jobId}.mp4`);
    await bucket().file(job.sourceStoragePath).download({ destination: srcPath });
    let lastPct = -1;
    const result = await renderToMp4({
      serialized: job.renderRecipe,
      sourcePath: srcPath,
      outputPath: outPath,
      crf: cfg.crf,
      preset: cfg.preset,
      signal: controller.signal,
      onProgress: ({ stage, progress }) => {
        const pct = Math.round(progress * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        void patch({ stage, progress });
      }
    });
    await patch({ stage: "uploading", progress: 0.98 });
    const token = randomUUID();
    await bucket().upload(outPath, {
      destination: job.outputPath,
      metadata: {
        contentType: "video/mp4",
        metadata: { firebaseStorageDownloadTokens: token }
      }
    });
    const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(
      job.outputPath
    )}?alt=media&token=${token}`;
    const finalized = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return false;
      const st = snap.get("status");
      if (st === "canceled" || st === "failed") return false;
      const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
      const usageSnap = await tx.get(usageRef);
      const u = usageSnap.data() ?? {};
      tx.set(
        usageRef,
        {
          cloudMinutesReserved: Math.max(0, (u.cloudMinutesReserved ?? 0) - estimate),
          cloudMinutesConsumed: Math.max(0, u.cloudMinutesConsumed ?? 0) + estimate,
          lastCloudExportAt: Date.now(),
          updatedAt: Date.now()
        },
        { merge: true }
      );
      tx.set(
        jobRef,
        {
          status: "ready",
          stage: "uploading",
          progress: 1,
          downloadUrl,
          consumedExportMinutes: estimate,
          warnings: result.warnings,
          completedAt: FieldValue2.serverTimestamp(),
          updatedAt: FieldValue2.serverTimestamp()
        },
        { merge: true }
      );
      return true;
    });
    if (!finalized) {
      console.info("[worker] canceled during upload \u2014 skipping ready", { uid, jobId });
      return "canceled";
    }
    await db.doc(`users/${uid}/projects/${job.projectId}`).set({ exportUrl: downloadUrl, updatedAt: Date.now() }, { merge: true }).catch(() => {
    });
    console.info("[worker] done", { uid, jobId, minutes: estimate });
    return "ready";
  } catch (err) {
    if (err instanceof CanceledError) {
      console.info("[worker] canceled", { uid, jobId });
      return "canceled";
    }
    await releaseMinutes(db, uid, monthKey, estimate).catch(() => {
    });
    const message = err instanceof Error ? err.message : "Render failed.";
    await patch({
      status: "failed",
      errorCode: "render_failed",
      errorMessage: message.slice(0, 500),
      completedAt: FieldValue2.serverTimestamp()
    }).catch(() => {
    });
    console.error("[worker] failed", { uid, jobId, error: message });
    return "failed";
  } finally {
    clearInterval(cancelPoll);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {
    });
  }
}

// src/server.ts
function start() {
  const cfg = loadConfig();
  const app2 = express();
  app2.use(express.json({ limit: "16mb" }));
  app2.get("/healthz", (_req, res) => {
    res.status(200).send("ok");
  });
  app2.post("/", async (req, res) => {
    const authed = await verifyRequestAuth(req, cfg);
    if (!authed.ok) {
      console.warn("[worker] auth rejected:", authed.reason);
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { uid, jobId } = req.body ?? {};
    if (!uid || !jobId) {
      res.status(400).json({ error: "body must include { uid, jobId }" });
      return;
    }
    if (cfg.devDisableOidc) {
      res.status(202).json({ accepted: true, jobId });
      processJob(uid, jobId).catch(
        (err) => console.error("[worker] background processJob threw", err)
      );
      return;
    }
    try {
      const outcome = await processJob(uid, jobId);
      res.status(200).json({ outcome });
    } catch (err) {
      console.error("[worker] processJob threw", err);
      res.status(500).json({ error: err.message });
    }
  });
  app2.listen(cfg.port, () => {
    console.info(
      `[worker] listening on :${cfg.port} (oidc=${cfg.devDisableOidc ? "disabled(dev)" : "enabled"})`
    );
  });
}
start();
export {
  start
};
