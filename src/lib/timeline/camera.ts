/**
 * Shared camera model — the single source of truth for "where does the camera
 * sit for this moment at this instant".
 *
 * Used by BOTH the live preview (`RealVideoPlayer`) and the export renderer
 * (`export.ts`) so what you preview is what you export. This is the
 * "Editable Timeline Model → render" boundary: moments (with optional
 * keyframes) go in, a concrete camera state comes out.
 */

import type {
  DetectedMoment,
  EaseKind,
  MomentKeyframe,
} from "@/lib/firebase/schema";

export interface CameraState {
  /** Final zoom scale applied to the frame (≥ 1). */
  scale: number;
  /** Horizontal pan, percent of frame width. Preview: translateX%. Export: ×canvasW/100. */
  panXPct: number;
  /** Vertical pan, percent of frame height. */
  panYPct: number;
}

export const IDENTITY_CAMERA: CameraState = { scale: 1, panXPct: 0, panYPct: 0 };

const MAX_SCALE = 2.4;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Standard easing curves for keyframe interpolation. */
function applyEase(kind: EaseKind | undefined, t: number): number {
  const x = clamp01(t);
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

/** Turn a 0..1 intensity into an actual zoom factor, given the focus box size. */
function scaleFromFocus(
  width: number,
  height: number,
  intensity: number
): number {
  const widthScale = width > 0 ? 1 / width : 1;
  const heightScale = height > 0 ? 1 / height : 1;
  const fit = Math.min(widthScale, heightScale);
  const target = Math.min(MAX_SCALE, Math.max(1.05, fit * 0.9));
  return 1 + (target - 1) * Math.max(0.3, Math.min(1, intensity));
}

/** Local progress (0..1) of an absolute time `t` within a moment's window. */
export function localProgress(
  m: { startTime: number; endTime: number },
  t: number
): number {
  const dur = m.endTime - m.startTime;
  if (dur <= 0) return 0;
  return clamp01((t - m.startTime) / dur);
}

/** Find the two keyframes bracketing `p` and the eased blend factor between them. */
function bracket(
  kfs: MomentKeyframe[],
  p: number
): { a: MomentKeyframe; b: MomentKeyframe; f: number } {
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
        f: applyEase(sorted[i + 1].ease, localT),
      };
    }
  }
  return { a: last, b: last, f: 1 };
}

/**
 * The camera state for a moment at a given local progress (0..1).
 *
 * - With keyframes: interpolate centre + intensity through them.
 * - Without: hold the static `focusRegion` at the blended intensity.
 */
export function cameraForMoment(
  m: DetectedMoment,
  blendedIntensity: number,
  localProgressValue: number
): CameraState {
  const kfs = m.keyframes;
  if (kfs && kfs.length > 0) {
    const { a, b, f } = bracket(kfs, clamp01(localProgressValue));
    const cx = a.x + (b.x - a.x) * f;
    const cy = a.y + (b.y - a.y) * f;
    const intensity = a.scale + (b.scale - a.scale) * f;
    const scale = scaleFromFocus(
      m.focusRegion.width,
      m.focusRegion.height,
      intensity
    );
    return {
      scale,
      panXPct: (0.5 - cx) * 100,
      panYPct: (0.5 - cy) * 100,
    };
  }

  const cx = m.focusRegion.x + m.focusRegion.width / 2;
  const cy = m.focusRegion.y + m.focusRegion.height / 2;
  const scale = scaleFromFocus(
    m.focusRegion.width,
    m.focusRegion.height,
    blendedIntensity
  );
  return {
    scale,
    panXPct: (0.5 - cx) * 100,
    panYPct: (0.5 - cy) * 100,
  };
}

/**
 * Seed a 2-keyframe set from a moment's static focus region — a gentle
 * settle-in punch. The starting point for hand-editing camera motion.
 */
export function seedKeyframes(m: DetectedMoment): MomentKeyframe[] {
  const cx = m.focusRegion.x + m.focusRegion.width / 2;
  const cy = m.focusRegion.y + m.focusRegion.height / 2;
  const intensity =
    m.intensity ?? m.recommendedIntensity ?? m.attentionScore ?? 0.6;
  return [
    { t: 0, x: cx, y: cy, scale: Math.max(0.2, intensity * 0.7), ease: "ease-out" },
    { t: 1, x: cx, y: cy, scale: Math.min(1, intensity), ease: "ease-in-out" },
  ];
}
