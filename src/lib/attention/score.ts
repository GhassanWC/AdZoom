/**
 * Attention engine — the canonical importance signal across the product.
 *
 * This is invariant 3 of the hybrid pipeline (see plan file). Every consumer
 * — zoom intensity, pacing, auto-cuts, chapter splits, AI gap-filling, export
 * optimization — reads from `attentionCurve()` or `getAttentionAt()`. There
 * is no parallel "importance" signal anywhere in `src/`. The
 * `src/lib/attention/sanity.ts` lint guard enforces this.
 *
 * The curve fuses every available signal:
 *   - real click / typing / scroll-pause / hover events (weighted highest)
 *   - cursor intent kinematics (hesitation, settle, micro-pause, churn)
 *   - CV motion / delta / density / scene proximity (from VisualAnalysis)
 *   - active UI region density
 *
 * When events are absent (out-of-tab recording), event + cursor-intent terms
 * collapse to zero and the curve gracefully degrades to CV-only.
 *
 * The curve is quantized to 8-bit and stored on `Analysis.attentionCurve`
 * (per-second). `getAttentionAt(t)` is the single accessor consumers use.
 */

import type {
  Interaction,
} from "../recording/types";
import type {
  VisualAnalysis,
  UIRegion,
  Analysis,
} from "../firebase/schema";
import {
  cursorIntent,
  type CursorIntentSeries,
  bucketAt,
} from "./cursor-intent";
import { dequantize, quantize } from "../cv/resample";

export interface AttentionInput {
  duration: number;
  sampleRate?: number; // defaults to VisualAnalysis.sampleRate or 1
  interactions?: Interaction[];
  interactionScope?: "tab" | "external";
  visualAnalysis?: VisualAnalysis;
  uiRegions?: UIRegion[];
}

export interface AttentionResult {
  /** Per-bucket attention score (0..1). */
  curve: Float32Array;
  /** Samples per second of `curve`. */
  sampleRate: number;
  /** Number of buckets in `curve`. */
  sampleCount: number;
  /** Cursor intent series — exposed so consumers (events.ts, debug overlay) reuse it. */
  cursorIntent: CursorIntentSeries;
  /**
   * 8-bit quantized form for Firestore persistence. Same length as `curve`.
   * Divide by 255 to get back to 0..1.
   */
  curveQ8: number[];
}

// ── Weights (sum of positives ~= 1.0; negatives subtracted) ──
const W_CLICK = 0.28;
const W_HESITATION = 0.12;
const W_SETTLE = 0.1;
const W_MICRO_PAUSE = 0.04;
const W_TYPING = 0.1;
const W_SCROLLPAUSE = 0.06;
const W_MOTION = 0.1;
const W_DELTA = 0.06;
const W_SCENE = 0.1;
const W_REGION = 0.04;
const W_IDLE_PEN = 0.15;
const W_CHURN_PEN = 0.08;

/** Smoothing window in seconds (one-side gaussian-ish). */
const SMOOTH_WINDOW_S = 1.0;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function clickBoost(t: number, clicks: number[]): number {
  let best = 0;
  for (const c of clicks) {
    const dist = Math.abs(c - t);
    if (dist <= 1.2) {
      const s = 1 - dist / 1.2;
      if (s > best) best = s;
    }
  }
  return best;
}

function eventActivity(
  t: number,
  series: Array<{ t: number; tEnd?: number; weight: number }>
): number {
  let best = 0;
  for (const s of series) {
    const start = s.t;
    const end = s.tEnd ?? s.t;
    if (t >= start - 0.4 && t <= end + 0.4) {
      if (s.weight > best) best = s.weight;
    }
  }
  return best;
}

function idleProximity(t: number, idles: Array<{ t: number; tEnd: number }>): number {
  for (const i of idles) {
    if (t >= i.t && t <= i.tEnd) {
      const span = i.tEnd - i.t;
      // Stronger penalty inside long idles.
      return Math.min(1, span / 6);
    }
  }
  return 0;
}

function sceneProximityAt(t: number, scenes: Array<{ t: number; strength: number }>): number {
  let best = 0;
  for (const s of scenes) {
    const dist = Math.abs(s.t - t);
    if (dist <= 1.5) {
      const score = (1 - dist / 1.5) * s.strength;
      if (score > best) best = score;
    }
  }
  return best;
}

function regionActivityAt(t: number, regions: UIRegion[]): number {
  let best = 0;
  for (const r of regions) {
    if (t >= r.t0 && t <= r.t1) {
      if (r.confidence > best) best = r.confidence;
    }
  }
  return best;
}

function smooth(curve: Float32Array, sampleRate: number): Float32Array {
  const win = Math.max(1, Math.round(SMOOTH_WINDOW_S * sampleRate));
  const out = new Float32Array(curve.length);
  let sum = 0;
  let count = 0;
  // Initial fill
  for (let i = 0; i <= Math.min(win, curve.length - 1); i++) {
    sum += curve[i];
    count++;
  }
  for (let i = 0; i < curve.length; i++) {
    const inIdx = i + win;
    const outIdx = i - win - 1;
    if (inIdx < curve.length && i > 0) {
      sum += curve[inIdx];
      count++;
    }
    if (outIdx >= 0) {
      sum -= curve[outIdx];
      count--;
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

/**
 * Build the canonical attention curve.
 *
 * Deterministic: same inputs → same curve. No randomness, no network calls.
 */
export function attentionCurve(input: AttentionInput): AttentionResult {
  const sampleRate = input.sampleRate ?? input.visualAnalysis?.sampleRate ?? 1;
  const duration = Math.max(0, input.duration || 0);
  const sampleCount = Math.max(1, Math.ceil(duration * sampleRate));

  // Build event helper series.
  const events = input.interactions ?? [];
  const useEvents = input.interactionScope !== "external";

  const clicks: number[] = [];
  const typings: Array<{ t: number; tEnd: number; weight: number }> = [];
  const scrollPauses: Array<{ t: number; weight: number }> = [];
  const idles: Array<{ t: number; tEnd: number }> = [];

  if (useEvents) {
    for (const ev of events) {
      if (ev.type === "click" || ev.type === "dblclick" || ev.type === "rightclick") {
        clicks.push(ev.t);
      } else if (ev.type === "typing") {
        typings.push({ t: ev.t, tEnd: ev.tEnd, weight: Math.min(1, ev.keyCount / 12) + 0.5 });
      } else if (ev.type === "scrollpause") {
        scrollPauses.push({ t: ev.t, weight: Math.min(1, ev.pauseSeconds / 1.0) });
      } else if (ev.type === "idle" && ev.tEnd - ev.t >= 4) {
        idles.push({ t: ev.t, tEnd: ev.tEnd });
      }
    }
  }

  const intent = cursorIntent(useEvents ? events : [], duration, sampleRate);

  const va = input.visualAnalysis;
  const regions = input.uiRegions ?? va?.uiRegions ?? [];

  const raw = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const t = (i + 0.5) / sampleRate;

    const click = clickBoost(t, clicks);
    const typing = eventActivity(t, typings);
    const scroll = eventActivity(t, scrollPauses);
    const idle = idleProximity(t, idles);

    const intentSample = intent.samples[bucketAt(intent, t)];
    const hesitation = intentSample?.hesitationScore ?? 0;
    const settle = intentSample?.focusSettleScore ?? 0;
    const microPause = intentSample?.microPauseScore ?? 0;
    const churn = intentSample?.directionChurn ?? 0;

    let motion = 0;
    let delta = 0;
    let scene = 0;
    if (va) {
      const b = Math.min(va.sampleCount - 1, Math.max(0, Math.floor(t * va.sampleRate)));
      motion = dequantize(va.motion[b] ?? 0);
      delta = dequantize(va.delta[b] ?? 0);
      scene = sceneProximityAt(t, va.sceneChanges);
    }
    const region = regionActivityAt(t, regions);

    const score =
      W_CLICK * click +
      W_HESITATION * hesitation +
      W_SETTLE * settle +
      W_MICRO_PAUSE * microPause +
      W_TYPING * typing +
      W_SCROLLPAUSE * scroll +
      W_MOTION * motion +
      W_DELTA * delta +
      W_SCENE * scene +
      W_REGION * region -
      W_IDLE_PEN * idle -
      W_CHURN_PEN * churn;

    raw[i] = clamp01(score);
  }

  const smoothed = smooth(raw, sampleRate);
  const curveQ8: number[] = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    curveQ8[i] = quantize(smoothed[i]);
  }

  return {
    curve: smoothed,
    sampleRate,
    sampleCount,
    cursorIntent: intent,
    curveQ8,
  };
}

/**
 * Single accessor for "how important is this moment in time?". Reads the
 * persisted attention curve off the analysis doc. Returns 0 when no curve has
 * been computed yet (treat absence as no opinion, not low importance).
 *
 * This is the ONLY place outside src/lib/attention/ that should compute an
 * importance value. Everything else — pacing, zoom, cuts, AI prompts — calls
 * this function (invariant 3).
 */
export function getAttentionAt(
  analysis: Pick<Analysis, "attentionCurve" | "attentionSampleRate"> | undefined,
  t: number
): number {
  if (!analysis?.attentionCurve || analysis.attentionCurve.length === 0) return 0;
  const rate = analysis.attentionSampleRate ?? 1;
  const idx = Math.max(
    0,
    Math.min(analysis.attentionCurve.length - 1, Math.floor(t * rate))
  );
  return dequantize(analysis.attentionCurve[idx]);
}
