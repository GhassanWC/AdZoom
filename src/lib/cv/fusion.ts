/**
 * Hybrid attention fusion — pure helpers that combine Gemini's semantic
 * `attentionScore` with the measured CV signals.
 *
 * Imported by `src/lib/timeline-balancer.ts`, which runs both server-side (in
 * the analyze route) and client-side (on preset re-balance), so this fusion
 * logic is written once and reused.
 *
 * Gemini stays the 50% anchor: CV has no semantics, so a high-motion idle
 * animation must never outrank a quiet but pivotal click.
 */

import type { VisualAnalysis, VisualEvent } from "../firebase/schema";
import { dequantize, sceneProximity } from "./resample";

/** CV signal sampled over a single moment's time window. */
export interface CvMomentSample {
  /** Max per-second motion intensity across the window (0..1). */
  cvMotion: number;
  /** Max per-second change magnitude across the window (0..1). */
  cvDelta: number;
  /** Mean per-second visual density across the window (0..1). */
  cvDensity: number;
  /** Scene-change proximity, 1 at a cut inside the window (0..1). */
  cvScene: number;
  /** Strength of the nearest click-like event within ±1 s (0..1). */
  cvClick: number;
  /** Motion hotspot over the window, or null if too unstable / no data. */
  centroid: { x: number; y: number; variance: number } | null;
}

/** Fusion weights — sum to 1.0. */
const W_GEMINI = 0.5;
const W_MOTION = 0.18;
const W_SCENE = 0.14;
const W_DELTA = 0.1;
const W_DENSITY = 0.08;

/** Time → bucket index in the per-second arrays. */
function bucketAt(va: VisualAnalysis, t: number): number {
  const b = Math.floor(t * va.sampleRate);
  return Math.max(0, Math.min(va.sampleCount - 1, b));
}

/** Sample every CV signal over `[startTime, endTime]`. */
export function sampleCvForMoment(
  va: VisualAnalysis,
  startTime: number,
  endTime: number
): CvMomentSample {
  const b0 = bucketAt(va, startTime);
  const b1 = bucketAt(va, Math.max(startTime, endTime));

  let cvMotion = 0;
  let cvDelta = 0;
  let densitySum = 0;
  let count = 0;

  // Centroid mean + variance over the window.
  let cxSum = 0;
  let cySum = 0;
  for (let b = b0; b <= b1; b++) {
    const m = dequantize(va.motion[b]);
    const d = dequantize(va.delta[b]);
    if (m > cvMotion) cvMotion = m;
    if (d > cvDelta) cvDelta = d;
    densitySum += dequantize(va.density[b]);
    cxSum += dequantize(va.centroidX[b]);
    cySum += dequantize(va.centroidY[b]);
    count++;
  }
  const cvDensity = count > 0 ? densitySum / count : 0;

  let centroid: CvMomentSample["centroid"] = null;
  if (count > 0) {
    const mx = cxSum / count;
    const my = cySum / count;
    let varSum = 0;
    for (let b = b0; b <= b1; b++) {
      const dx = dequantize(va.centroidX[b]) - mx;
      const dy = dequantize(va.centroidY[b]) - my;
      varSum += dx * dx + dy * dy;
    }
    centroid = { x: mx, y: my, variance: varSum / count };
  }

  // Scene proximity at the window midpoint.
  const mid = (startTime + Math.max(startTime, endTime)) / 2;
  const cvScene = sceneProximity(mid, va.sceneChanges);

  const cvClick = nearestEventStrength(va.clickEvents, startTime, endTime, 1);

  return { cvMotion, cvDelta, cvDensity, cvScene, cvClick, centroid };
}

/**
 * Composite attention score. Gemini is the anchor; CV corroborates or corrects.
 * Two disagreement rules nudge clear mismatches.
 */
export function fuseAttention(geminiScore: number, cv: CvMomentSample): number {
  const g = clamp01(geminiScore);
  let fused =
    W_GEMINI * g +
    W_MOTION * cv.cvMotion +
    W_SCENE * cv.cvScene +
    W_DELTA * cv.cvDelta +
    W_DENSITY * cv.cvDensity;

  // Gemini says important, but the screen was static → likely over-weighted narration.
  if (g > 0.7 && cv.cvMotion < 0.05 && cv.cvDelta < 0.03) {
    fused *= 0.85;
  }
  // Gemini says minor, but there's a real cut here → floor it so rescue can pick it up.
  if (g < 0.4 && cv.cvScene > 0.8) {
    fused = Math.max(fused, 0.55);
  }

  return clamp01(fused);
}

/**
 * Nearest click-like event to `[startTime, endTime]` within ±`window` seconds,
 * or null. Used to refine click/cursor moment timing.
 */
export function nearestClickEvent(
  va: VisualAnalysis,
  startTime: number,
  windowSec: number
): VisualEvent | null {
  let best: VisualEvent | null = null;
  let bestDist = Infinity;
  for (const e of va.clickEvents) {
    const dist = Math.abs(e.t - startTime);
    if (dist <= windowSec && dist < bestDist) {
      bestDist = dist;
      best = e;
    }
  }
  return best;
}

/** Max strength of any event whose time falls within `[s - pad, e + pad]`. */
function nearestEventStrength(
  events: VisualEvent[],
  startTime: number,
  endTime: number,
  pad: number
): number {
  let best = 0;
  for (const e of events) {
    if (e.t >= startTime - pad && e.t <= endTime + pad && e.strength > best) {
      best = e.strength;
    }
  }
  return best;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
