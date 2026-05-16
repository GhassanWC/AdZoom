/**
 * Scene-change detection from the per-frame block-mean delta sequence.
 *
 * Two triggers, OR'd together:
 *  1. Global hard threshold — an unambiguously large frame change.
 *  2. Adaptive threshold — a spike well above the recent rolling baseline,
 *     which catches softer transitions on otherwise calm recordings.
 *
 * A debounce window suppresses duplicate flags, since a real transition spans
 * several sampled frames.
 */

import type { VisualEvent } from "../firebase/schema";

const GLOBAL_THRESHOLD = 0.12;
/** Adaptive: flag when delta > rollingMean + K·rollingStd … */
const ADAPTIVE_K = 2.5;
/** … but never below this floor (rejects noise on near-static screencasts). */
const ADAPTIVE_FLOOR = 0.04;
/** Frames of history the rolling baseline considers. */
const ROLL_WINDOW = 16;
/** Suppress a second flag within this many seconds of the last one. */
const DEBOUNCE_SECONDS = 0.75;

export interface SceneDetectResult {
  /** Per-frame boolean — true where a scene cut was detected. */
  sceneFlags: boolean[];
  /** Sparse, debounced scene-change events. */
  events: VisualEvent[];
}

/**
 * @param deltas  per-frame block-mean delta (use `FrameDiff.blockMeanDelta`)
 * @param times   per-frame timestamps in seconds, same length as `deltas`
 */
export function detectScenes(deltas: number[], times: number[]): SceneDetectResult {
  const n = deltas.length;
  const sceneFlags = new Array<boolean>(n).fill(false);
  const events: VisualEvent[] = [];
  let lastFlagTime = -Infinity;

  for (let i = 0; i < n; i++) {
    const d = deltas[i];

    // Rolling baseline over the preceding ROLL_WINDOW frames.
    const from = Math.max(0, i - ROLL_WINDOW);
    let mean = 0;
    let count = 0;
    for (let j = from; j < i; j++) {
      mean += deltas[j];
      count++;
    }
    mean = count > 0 ? mean / count : 0;
    let variance = 0;
    for (let j = from; j < i; j++) variance += (deltas[j] - mean) ** 2;
    const std = count > 0 ? Math.sqrt(variance / count) : 0;

    const adaptiveThreshold = Math.max(ADAPTIVE_FLOOR, mean + ADAPTIVE_K * std);
    const isCut = d > GLOBAL_THRESHOLD || d > adaptiveThreshold;
    if (!isCut) continue;

    if (times[i] - lastFlagTime < DEBOUNCE_SECONDS) continue;
    lastFlagTime = times[i];
    sceneFlags[i] = true;
    events.push({
      t: round1(times[i]),
      // Strength: how far past the global threshold, capped at 1.
      strength: Math.min(1, d / GLOBAL_THRESHOLD),
    });
  }

  return { sceneFlags, events };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
