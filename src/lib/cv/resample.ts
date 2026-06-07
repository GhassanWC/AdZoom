/**
 * Resampling + quantization — turns the dense per-frame signal (4 fps) into the
 * compact `VisualAnalysis` that gets persisted to Firestore.
 *
 * Per-second buckets, 8-bit quantized arrays. At 1 Hz a 3-min video is ~180
 * samples × 6 arrays ≈ 12 KB encoded — comfortably under the 1 MB doc limit.
 */

import type {
  InferredClick,
  UIRegion,
  VisualAnalysis,
  VisualDwell,
  VisualEvent,
} from "../firebase/schema";
import type { RawFrameSignal } from "./types";
import type { CursorEstimate } from "./cursor-track";

/** Cap persisted UI regions for doc-size safety. */
const MAX_UI_REGIONS = 200;
/** Cap persisted dwells (dev-tuning visibility only). */
const MAX_DWELLS = 120;

/** Above this many samples (~40 min @ 1 Hz) drop to 0.5 Hz. */
const MAX_SAMPLES_AT_1HZ = 2400;

/**
 * The persisted sample rate for a given WHOLE-video duration. Exported so the
 * chunked engine can resample each window at the whole-video rate (otherwise a
 * 30s window would always pick 1 Hz and fail to merge with a 0.5 Hz long video).
 */
export function sampleRateFor(duration: number): number {
  return Math.ceil(duration) > MAX_SAMPLES_AT_1HZ ? 0.5 : 1;
}

/** Scene-proximity falloff for the attention curve, in seconds. */
const SCENE_FALLOFF = 2;

/** 0..1 → 0..255. */
export function quantize(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/** 0..255 → 0..1. */
export function dequantize(b: number): number {
  return Math.max(0, Math.min(255, b)) / 255;
}

/** Whole-array 0..255 → 0..1. */
export function dequantizeArray(arr: number[] | undefined): number[] {
  return (arr ?? []).map(dequantize);
}

export interface ResampleInput {
  signals: RawFrameSignal[];
  duration: number;
  /**
   * Force the per-second sample rate instead of deriving it from `duration`.
   * The chunked engine passes the WHOLE-video rate so every window-local
   * `VisualAnalysis` shares a rate and merges cleanly.
   */
  sampleRate?: number;
  sceneChanges: VisualEvent[];
  clickEvents: VisualEvent[];
  /** Per-frame cursor estimates (same order/length as `signals`). v3. */
  cursors?: CursorEstimate[];
  /** UI-change-grounded inferred clicks. v3. */
  inferredClicks?: InferredClick[];
  /** Cursor dwells (dev-tuning visibility only). v3. */
  dwells?: VisualDwell[];
  /** Detected UI regions. v3. */
  uiRegions?: UIRegion[];
  computeMs: number;
}

/** Build the persisted `VisualAnalysis` from dense per-frame signals. */
export function resample(input: ResampleInput): VisualAnalysis {
  const {
    signals,
    duration,
    sceneChanges,
    clickEvents,
    cursors,
    inferredClicks,
    dwells,
    uiRegions,
    computeMs,
  } = input;

  const sampleRate = input.sampleRate ?? sampleRateFor(duration);
  const bucketLen = 1 / sampleRate; // seconds per bucket
  const sampleCount = Math.max(1, Math.ceil(duration * sampleRate));

  const motion = new Array<number>(sampleCount).fill(0);
  const delta = new Array<number>(sampleCount).fill(0);
  const density = new Array<number>(sampleCount).fill(0);
  const centroidX = new Array<number>(sampleCount).fill(0);
  const centroidY = new Array<number>(sampleCount).fill(0);

  // Accumulators for the mean fields.
  const deltaSum = new Float64Array(sampleCount);
  const densitySum = new Float64Array(sampleCount);
  const counts = new Float64Array(sampleCount);
  // Motion-weighted centroid accumulators.
  const cxSum = new Float64Array(sampleCount);
  const cySum = new Float64Array(sampleCount);
  const cWeight = new Float64Array(sampleCount);
  // Raw (0..1) motion max per bucket, kept for the attention curve.
  const motionRaw = new Float64Array(sampleCount);

  for (const s of signals) {
    const b = Math.min(sampleCount - 1, Math.max(0, Math.floor(s.t / bucketLen)));
    counts[b]++;
    deltaSum[b] += s.meanDelta;
    densitySum[b] += s.visualDensity;
    if (s.motionIntensity > motionRaw[b]) motionRaw[b] = s.motionIntensity;
    if (s.centroid) {
      // Weight the hotspot by motion so noisy near-static frames don't drag it.
      const w = Math.max(0.01, s.motionIntensity);
      cxSum[b] += s.centroid.x * w;
      cySum[b] += s.centroid.y * w;
      cWeight[b] += w;
    }
  }

  // Carry-forward state for buckets with no centroid this second.
  let lastCx = 0.5;
  let lastCy = 0.5;

  for (let b = 0; b < sampleCount; b++) {
    const c = counts[b];
    motion[b] = quantize(motionRaw[b]);
    delta[b] = quantize(c > 0 ? deltaSum[b] / c : 0);
    density[b] = quantize(c > 0 ? densitySum[b] / c : 0);

    if (cWeight[b] > 0) {
      lastCx = cxSum[b] / cWeight[b];
      lastCy = cySum[b] / cWeight[b];
    }
    centroidX[b] = quantize(lastCx);
    centroidY[b] = quantize(lastCy);
  }

  const attentionCurve = buildAttentionCurve(
    motionRaw,
    deltaSum,
    densitySum,
    counts,
    sceneChanges,
    bucketLen,
    sampleCount
  );

  // Cursor track → per-second confidence-weighted position + mean confidence.
  const cursorX = new Array<number>(sampleCount).fill(0);
  const cursorY = new Array<number>(sampleCount).fill(0);
  const cursorConf = new Array<number>(sampleCount).fill(0);
  const hasCursors = !!cursors && cursors.length === signals.length;
  if (hasCursors && cursors) {
    const cxs = new Float64Array(sampleCount);
    const cys = new Float64Array(sampleCount);
    const cw = new Float64Array(sampleCount);
    const confSum = new Float64Array(sampleCount);
    const cCount = new Float64Array(sampleCount);
    for (let i = 0; i < cursors.length; i++) {
      const b = Math.min(sampleCount - 1, Math.max(0, Math.floor(signals[i].t / bucketLen)));
      const cu = cursors[i];
      const w = Math.max(0.01, cu.confidence);
      cxs[b] += cu.x * w;
      cys[b] += cu.y * w;
      cw[b] += w;
      confSum[b] += cu.confidence;
      cCount[b]++;
    }
    let lx = 0.5;
    let ly = 0.5;
    for (let b = 0; b < sampleCount; b++) {
      if (cw[b] > 0) {
        lx = cxs[b] / cw[b];
        ly = cys[b] / cw[b];
      }
      cursorX[b] = quantize(lx);
      cursorY[b] = quantize(ly);
      cursorConf[b] = quantize(cCount[b] > 0 ? confSum[b] / cCount[b] : 0);
    }
  }

  const va: VisualAnalysis = {
    version: hasCursors ? 3 : 1,
    sampleRate,
    sampleCount,
    motion,
    delta,
    density,
    centroidX,
    centroidY,
    sceneChanges,
    clickEvents,
    attentionCurve,
    computeMs: Math.round(computeMs),
  };
  // Only attach v3 fields when present — keeps legacy docs/writes clean
  // (Firestore rejects `undefined`).
  if (hasCursors) {
    va.cursorX = cursorX;
    va.cursorY = cursorY;
    va.cursorConf = cursorConf;
  }
  if (inferredClicks && inferredClicks.length > 0) {
    va.inferredClicks = inferredClicks;
  }
  if (dwells && dwells.length > 0) {
    va.dwells = dwells.slice(0, MAX_DWELLS);
  }
  if (uiRegions && uiRegions.length > 0) {
    va.uiRegions = uiRegions.slice(0, MAX_UI_REGIONS);
  }
  return va;
}

/**
 * Continuous attention curve — a CV-only signal (Gemini moments are sparse).
 * Weighted blend, then a 3-tap smoothing pass, then normalize 0..1.
 */
function buildAttentionCurve(
  motionRaw: Float64Array,
  deltaSum: Float64Array,
  densitySum: Float64Array,
  counts: Float64Array,
  sceneChanges: VisualEvent[],
  bucketLen: number,
  sampleCount: number
): number[] {
  const raw = new Float64Array(sampleCount);

  for (let b = 0; b < sampleCount; b++) {
    const c = counts[b];
    const m = motionRaw[b];
    const d = c > 0 ? deltaSum[b] / c : 0;
    const dens = c > 0 ? densitySum[b] / c : 0;
    const t = (b + 0.5) * bucketLen;
    raw[b] =
      0.4 * m +
      0.25 * d +
      0.2 * dens +
      0.15 * sceneProximity(t, sceneChanges);
  }

  // 3-tap moving average to kill single-second spikes.
  const smoothed = new Float64Array(sampleCount);
  for (let b = 0; b < sampleCount; b++) {
    let sum = raw[b];
    let n = 1;
    if (b > 0) {
      sum += raw[b - 1];
      n++;
    }
    if (b < sampleCount - 1) {
      sum += raw[b + 1];
      n++;
    }
    smoothed[b] = sum / n;
  }

  // Normalize to 0..1 against the peak, then quantize.
  let peak = 0;
  for (let b = 0; b < sampleCount; b++) if (smoothed[b] > peak) peak = smoothed[b];
  const out = new Array<number>(sampleCount).fill(0);
  if (peak > 0) {
    for (let b = 0; b < sampleCount; b++) out[b] = quantize(smoothed[b] / peak);
  }
  return out;
}

/** 1.0 at a scene cut, decaying linearly to 0 over SCENE_FALLOFF seconds. */
export function sceneProximity(t: number, sceneChanges: VisualEvent[]): number {
  let best = 0;
  for (const e of sceneChanges) {
    const dist = Math.abs(e.t - t);
    if (dist >= SCENE_FALLOFF) continue;
    const prox = (1 - dist / SCENE_FALLOFF) * e.strength;
    if (prox > best) best = prox;
  }
  return best;
}
