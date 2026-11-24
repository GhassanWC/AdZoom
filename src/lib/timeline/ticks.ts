/**
 * Integer time for the timeline engine.
 *
 * Documents store seconds (floats) for readability and compatibility; the
 * evaluator works in TICKS so that boundaries compare exactly and a cut owned
 * by "the later item" is the same decision in preview and in every exporter.
 * 600 000 ticks/s is divisible by 24, 25, 30, 48, 50, 60, 120 fps and by
 * 1000 (ms), so every frame boundary at those rates is an integer.
 */

export const TICKS_PER_SECOND = 600_000;

export type Ticks = number;

export function toTicks(seconds: number): Ticks {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export function fromTicks(ticks: Ticks): number {
  return ticks / TICKS_PER_SECOND;
}

/** Ticks per frame at `fps` (integer for every supported rate). */
export function frameTicks(fps: number): Ticks {
  return Math.round(TICKS_PER_SECOND / fps);
}

/** The output frame index that contains tick `t` at `fps`. */
export function frameAt(t: Ticks, fps: number): number {
  return Math.floor(t / frameTicks(fps));
}

export function clampTicks(t: Ticks, lo: Ticks, hi: Ticks): Ticks {
  return t < lo ? lo : t > hi ? hi : t;
}
