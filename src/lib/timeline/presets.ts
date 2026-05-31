/**
 * Directional framing presets.
 *
 * Pure functions that produce `FocusRegion` / `MomentKeyframe[]` values for
 * the inspector's preset row (Left, Right, Top, Bottom, Center, Follow
 * cursor) and pan row (Pan →, Pan ←, Pan ↑, Pan ↓). No React, no DOM, no
 * Firestore. Unit-testable.
 *
 * Every preset preserves the current focus box's width/height so the user's
 * intensity choice carries through. Edge presets use a fixed safe margin
 * (5%) so the framing never pins flush against a clipped pixel.
 */

import type {
  EaseKind,
  FocusRegion,
  MomentKeyframe,
} from "../firebase/schema";
import type { Interaction } from "../recording/types";

export type DirectionalPreset =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "center";

export type PanDirection = "right" | "left" | "up" | "down";

/** Safe margin from frame edges in normalized units. */
const EDGE_SAFE = 0.05;
/** Default keyframe ease used by all generated multi-keyframe paths. */
const DEFAULT_EASE_IN: EaseKind = "ease-out";
const DEFAULT_EASE_OUT: EaseKind = "ease-in-out";
/** How long the start/end "average" window is when sampling cursor data. */
const CURSOR_AVG_MS = 200;
/** Minimum number of mousemove samples needed for cursorFollowKeyframes. */
const MIN_FOLLOW_SAMPLES = 4;

/**
 * Compute a new focusRegion for a directional preset. Width/height of the
 * incoming region are preserved — only x/y move. `center` clears keyframes
 * upstream; the geometry returned here is the static fallback.
 */
export function presetToFocusRegion(
  preset: DirectionalPreset,
  current: FocusRegion
): FocusRegion {
  const w = clamp(current.width, 0.05, 1);
  const h = clamp(current.height, 0.05, 1);
  let x = current.x;
  let y = current.y;
  switch (preset) {
    case "left":
      x = EDGE_SAFE;
      y = (1 - h) / 2;
      break;
    case "right":
      x = 1 - w - EDGE_SAFE;
      y = (1 - h) / 2;
      break;
    case "top":
      x = (1 - w) / 2;
      y = EDGE_SAFE;
      break;
    case "bottom":
      x = (1 - w) / 2;
      y = 1 - h - EDGE_SAFE;
      break;
    case "center":
      x = (1 - w) / 2;
      y = (1 - h) / 2;
      break;
  }
  return {
    x: clamp(x, 0, Math.max(0, 1 - w)),
    y: clamp(y, 0, Math.max(0, 1 - h)),
    width: w,
    height: h,
  };
}

/**
 * Build a 2-keyframe pan across the long axis at constant scale. Used by
 * the inspector's "Pan →/←/↑/↓" buttons. Starting and ending centres
 * respect the same edge safe-margin as the directional presets.
 */
export function createPanKeyframes(
  fr: FocusRegion,
  direction: PanDirection,
  intensity: number
): MomentKeyframe[] {
  const w = clamp(fr.width, 0.05, 1);
  const h = clamp(fr.height, 0.05, 1);
  const scale = clamp(intensity, 0.1, 1);
  let startX: number;
  let endX: number;
  let startY: number;
  let endY: number;

  if (direction === "right" || direction === "left") {
    const cy = fr.y + h / 2;
    const left = EDGE_SAFE + w / 2;
    const right = 1 - EDGE_SAFE - w / 2;
    startX = direction === "right" ? left : right;
    endX = direction === "right" ? right : left;
    startY = cy;
    endY = cy;
  } else {
    const cx = fr.x + w / 2;
    const top = EDGE_SAFE + h / 2;
    const bottom = 1 - EDGE_SAFE - h / 2;
    startY = direction === "down" ? top : bottom;
    endY = direction === "down" ? bottom : top;
    startX = cx;
    endX = cx;
  }

  return [
    { t: 0, x: clamp01(startX), y: clamp01(startY), scale: scale * 0.85, ease: DEFAULT_EASE_IN },
    { t: 1, x: clamp01(endX), y: clamp01(endY), scale, ease: DEFAULT_EASE_OUT },
  ];
}

/**
 * Generate 2-keyframe pan keyframes from the recorded cursor stream within
 * the moment window. Per user direction:
 *  - start = average cursor position over the first `CURSOR_AVG_MS`
 *  - end   = average cursor position over the last `CURSOR_AVG_MS`
 *
 * Returns null if there are fewer than `MIN_FOLLOW_SAMPLES` mousemove
 * events inside the window — the caller should disable the chip with a
 * "no cursor data" tooltip rather than fabricating a centered pan.
 */
export function cursorFollowKeyframes(
  interactions: Interaction[] | null | undefined,
  window: { startTime: number; endTime: number },
  intensity: number
): MomentKeyframe[] | null {
  if (!interactions || interactions.length === 0) return null;
  const moves = interactions.filter(
    (e): e is Extract<Interaction, { type: "mousemove" }> =>
      e.type === "mousemove" &&
      e.t >= window.startTime &&
      e.t <= window.endTime
  );
  if (moves.length < MIN_FOLLOW_SAMPLES) return null;
  moves.sort((a, b) => a.t - b.t);

  const dur = Math.max(0.001, window.endTime - window.startTime);
  const avgWindowSec = CURSOR_AVG_MS / 1000;
  // First-window cutoff: either an absolute 200ms or 25% of duration —
  // whichever is smaller — so very short moments still average over a band
  // rather than a single sample.
  const startCutoff = window.startTime + Math.min(avgWindowSec, dur * 0.25);
  const endCutoff = window.endTime - Math.min(avgWindowSec, dur * 0.25);

  const startSamples = moves.filter((m) => m.t <= startCutoff);
  const endSamples = moves.filter((m) => m.t >= endCutoff);

  const startAvg = avgXY(startSamples.length > 0 ? startSamples : [moves[0]]);
  const endAvg = avgXY(
    endSamples.length > 0 ? endSamples : [moves[moves.length - 1]]
  );

  const scale = clamp(intensity, 0.1, 1);
  return [
    {
      t: 0,
      x: clamp01(startAvg.x),
      y: clamp01(startAvg.y),
      scale: scale * 0.85,
      ease: DEFAULT_EASE_IN,
    },
    {
      t: 1,
      x: clamp01(endAvg.x),
      y: clamp01(endAvg.y),
      scale,
      ease: DEFAULT_EASE_OUT,
    },
  ];
}

function avgXY(samples: { x: number; y: number }[]): { x: number; y: number } {
  if (samples.length === 0) return { x: 0.5, y: 0.5 };
  let sx = 0;
  let sy = 0;
  for (const s of samples) {
    sx += s.x;
    sy += s.y;
  }
  return { x: sx / samples.length, y: sy / samples.length };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
