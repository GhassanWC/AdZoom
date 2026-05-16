/**
 * Interaction inference — locates click-like events from motion dynamics.
 *
 * There is no real click data in a screen recording, so this is a heuristic:
 * a *click-like event* is a sharp motion spike immediately followed by a pause
 * — the human "move the cursor → click → stop and read the result" pattern.
 *
 * It WILL misfire on scroll and drag gestures. Downstream consumers treat
 * `clickEvents` as a soft signal, never as ground truth.
 */

import type { VisualEvent } from "../firebase/schema";

/** A spike must exceed rollingMean + K·rollingStd to count. */
const SPIKE_K = 2;
/** Frames of history for the spike baseline. */
const SPIKE_WINDOW = 12;
/** Motion below this is considered "paused". */
const PAUSE_THRESHOLD = 0.02;
/** Frames of pause required immediately after the spike. */
const PAUSE_FRAMES = 2;
/** Absolute floor — ignore spikes on essentially-static video. */
const SPIKE_FLOOR = 0.04;
/** Suppress a second event within this many seconds. */
const DEBOUNCE_SECONDS = 0.6;

/**
 * @param motion per-frame motion intensity (use `FrameDiff.motionIntensity`)
 * @param times  per-frame timestamps in seconds, same length as `motion`
 */
export function detectInteractions(motion: number[], times: number[]): VisualEvent[] {
  const n = motion.length;
  const events: VisualEvent[] = [];
  let lastEventTime = -Infinity;

  for (let i = 1; i < n - PAUSE_FRAMES; i++) {
    const m = motion[i];
    if (m < SPIKE_FLOOR) continue;

    // Local maximum check.
    if (m < motion[i - 1] || m < motion[i + 1]) continue;

    // Rolling baseline over the preceding frames.
    const from = Math.max(0, i - SPIKE_WINDOW);
    let mean = 0;
    let count = 0;
    for (let j = from; j < i; j++) {
      mean += motion[j];
      count++;
    }
    mean = count > 0 ? mean / count : 0;
    let variance = 0;
    for (let j = from; j < i; j++) variance += (motion[j] - mean) ** 2;
    const std = count > 0 ? Math.sqrt(variance / count) : 0;

    if (m <= mean + SPIKE_K * std) continue;

    // Require a pause in the frames right after the spike.
    let paused = true;
    for (let j = i + 1; j <= i + PAUSE_FRAMES; j++) {
      if (motion[j] > PAUSE_THRESHOLD) {
        paused = false;
        break;
      }
    }
    if (!paused) continue;

    if (times[i] - lastEventTime < DEBOUNCE_SECONDS) continue;
    lastEventTime = times[i];
    events.push({
      t: Math.round(times[i] * 10) / 10,
      strength: Math.min(1, m / Math.max(0.08, mean + SPIKE_K * std)),
    });
  }

  return events;
}
