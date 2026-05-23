/**
 * Cursor behavior analysis — pure kinematics over the recorded mouse path.
 *
 * Human intent leaks through cursor motion: deceleration before a click
 * (hesitation), settling after motion (focus on a result), micro-pauses
 * inside a movement burst (the "I'm thinking" pause), and direction churn
 * (uncertainty). None of these require AI or CV — they fall out of
 * differentiating positions over time.
 *
 * This file produces a `CursorIntent` time-series at the same sample rate as
 * `VisualAnalysis`, fed into the attention engine as one of its inputs. When
 * the recording has no `mousemove` events (out-of-tab), all signals decay to
 * zero — see invariant 3 of the hybrid pipeline.
 */

import type { Interaction } from "../recording/types";

export interface CursorIntentSample {
  /** Bucket midpoint in seconds. */
  t: number;
  /** Diagonal-normalized speed at this bucket (0..~1). */
  velocity: number;
  /** Signed change in velocity (units/s²); positive = speeding up. */
  accel: number;
  /** Strength of "approached then slowed" pattern leading up to t (0..1). */
  hesitationScore: number;
  /** Strength of short pauses inside a movement burst (0..1). */
  microPauseScore: number;
  /** Direction-change rate around t — radians per second, capped at 1. */
  directionChurn: number;
  /** Strength of "settled" cursor after motion (0..1). */
  focusSettleScore: number;
}

export interface CursorIntentSeries {
  sampleRate: number;
  sampleCount: number;
  samples: CursorIntentSample[];
}

interface MoveSample {
  t: number;
  x: number;
  y: number;
  /** Diagonal-normalized speed reported by the provider. */
  vReported: number;
}

const EMPTY: CursorIntentSeries = { sampleRate: 1, sampleCount: 0, samples: [] };

/**
 * @param interactions full interaction list (filtered internally to mousemove)
 * @param duration     video duration in seconds
 * @param sampleRate   samples per second (typically matches VisualAnalysis)
 */
export function cursorIntent(
  interactions: Interaction[],
  duration: number,
  sampleRate: number
): CursorIntentSeries {
  if (!Number.isFinite(duration) || duration <= 0) return EMPTY;
  if (sampleRate <= 0) return EMPTY;

  const moves: MoveSample[] = [];
  for (const ev of interactions) {
    if (ev.type === "mousemove") {
      moves.push({ t: ev.t, x: ev.x, y: ev.y, vReported: ev.velocity });
    }
  }
  const sampleCount = Math.max(1, Math.ceil(duration * sampleRate));

  if (moves.length < 2) {
    // No usable path — emit a zero series.
    const zeros: CursorIntentSample[] = [];
    for (let i = 0; i < sampleCount; i++) {
      zeros.push({
        t: (i + 0.5) / sampleRate,
        velocity: 0,
        accel: 0,
        hesitationScore: 0,
        microPauseScore: 0,
        directionChurn: 0,
        focusSettleScore: 0,
      });
    }
    return { sampleRate, sampleCount, samples: zeros };
  }

  // Bucket moves by sample window.
  type Bucket = {
    vSum: number;
    vCount: number;
    angles: number[];
    pauseMs: number;
    moveMs: number;
  };
  const buckets: Bucket[] = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    buckets[i] = { vSum: 0, vCount: 0, angles: [], pauseMs: 0, moveMs: 0 };
  }

  for (let i = 1; i < moves.length; i++) {
    const cur = moves[i];
    const prev = moves[i - 1];
    const dt = cur.t - prev.t;
    if (dt <= 0) continue;
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    const dist = Math.hypot(dx, dy);
    const v = dist / dt; // already normalized — coords are 0..1
    const angle = dist > 1e-4 ? Math.atan2(dy, dx) : null;

    const bucketIdx = Math.min(sampleCount - 1, Math.max(0, Math.floor(cur.t * sampleRate)));
    const b = buckets[bucketIdx];
    b.vSum += v;
    b.vCount += 1;
    if (angle !== null) b.angles.push(angle);
    if (v < 0.02) b.pauseMs += dt * 1000;
    else b.moveMs += dt * 1000;
  }

  // First pass: velocity + accel + churn.
  const velocity: number[] = new Array(sampleCount).fill(0);
  const directionChurn: number[] = new Array(sampleCount).fill(0);
  const microPauseScore: number[] = new Array(sampleCount).fill(0);

  for (let i = 0; i < sampleCount; i++) {
    const b = buckets[i];
    velocity[i] = b.vCount > 0 ? Math.min(1, b.vSum / b.vCount) : 0;

    if (b.angles.length >= 2) {
      let totalDelta = 0;
      for (let k = 1; k < b.angles.length; k++) {
        let d = Math.abs(b.angles[k] - b.angles[k - 1]);
        if (d > Math.PI) d = 2 * Math.PI - d;
        totalDelta += d;
      }
      const radPerSec = totalDelta * sampleRate;
      directionChurn[i] = Math.min(1, radPerSec / 6); // 6 rad/s ≈ very churny
    }

    // Micro-pause: small idle gaps inside a window that otherwise saw movement.
    if (b.moveMs > 50 && b.pauseMs > 50 && b.pauseMs < b.moveMs) {
      microPauseScore[i] = Math.min(1, b.pauseMs / 250);
    }
  }

  const accel: number[] = new Array(sampleCount).fill(0);
  for (let i = 1; i < sampleCount; i++) {
    accel[i] = (velocity[i] - velocity[i - 1]) * sampleRate;
  }

  // Hesitation: looks backward — was there motion → strong decel → low velocity
  // within the last ~1s, and a click landed nearby? The "click landed nearby"
  // is left to the scorer (which has the click events); here we report the
  // shape signal that *could* mean hesitation.
  const hesitationScore: number[] = new Array(sampleCount).fill(0);
  const settleScore: number[] = new Array(sampleCount).fill(0);
  const lookback = Math.max(1, Math.round(sampleRate)); // ~1s
  for (let i = 0; i < sampleCount; i++) {
    let peakV = 0;
    let minVAfterPeak = velocity[i];
    let peakIdx = -1;
    for (let k = Math.max(0, i - lookback); k <= i; k++) {
      if (velocity[k] > peakV) {
        peakV = velocity[k];
        peakIdx = k;
      }
    }
    if (peakIdx >= 0) {
      for (let k = peakIdx; k <= i; k++) {
        if (velocity[k] < minVAfterPeak) minVAfterPeak = velocity[k];
      }
      const drop = peakV - minVAfterPeak;
      if (peakV > 0.15 && minVAfterPeak < 0.03 && drop > 0.1) {
        hesitationScore[i] = Math.min(1, drop * 2);
      }
    }

    // Focus settle: cursor has been very slow for the last ~400ms after a recent move.
    const settleLook = Math.max(1, Math.round(sampleRate * 0.4));
    let sawMotion = false;
    let stillNow = true;
    for (let k = Math.max(0, i - settleLook * 2); k < Math.max(0, i - settleLook); k++) {
      if (velocity[k] > 0.05) sawMotion = true;
    }
    for (let k = Math.max(0, i - settleLook); k <= i; k++) {
      if (velocity[k] > 0.05) {
        stillNow = false;
        break;
      }
    }
    if (sawMotion && stillNow) {
      settleScore[i] = 1;
    }
  }

  const samples: CursorIntentSample[] = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = {
      t: (i + 0.5) / sampleRate,
      velocity: velocity[i],
      accel: accel[i],
      hesitationScore: hesitationScore[i],
      microPauseScore: microPauseScore[i],
      directionChurn: directionChurn[i],
      focusSettleScore: settleScore[i],
    };
  }

  return { sampleRate, sampleCount, samples };
}

/** Bucket index helper used by score consumers. */
export function bucketAt(series: CursorIntentSeries, t: number): number {
  if (series.sampleCount <= 0) return 0;
  const b = Math.floor(t * series.sampleRate);
  if (b < 0) return 0;
  if (b >= series.sampleCount) return series.sampleCount - 1;
  return b;
}
