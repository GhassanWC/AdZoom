/**
 * Pure helpers for the manual Crop/Reframe + Speed timeline effects.
 *
 * Crop reuses the moment's `focusRegion` as its box; `cropBoxFor` shapes that
 * box for a target aspect/position/scale. Speed drives `playbackRate` in
 * preview + export; `outputDurationFor` reports the resulting output length and
 * `activeSpeedAt` finds the section under the playhead. No DOM, no side effects.
 */
import type {
  CropAspect,
  CropPosition,
  CropSettings,
  DetectedMoment,
  FocusRegion,
  SpeedSettings,
} from "@/lib/firebase/schema";

export const DEFAULT_CROP: CropSettings = {
  aspectRatio: "9:16",
  scale: 1,
  position: "center",
  easing: "ease-in-out",
};

export const DEFAULT_SPEED: SpeedSettings = {
  multiplier: 2,
  audioMode: "mute",
  transition: "cut",
};

/** Crop scale beyond which reframes would over-upscale the source. */
export const CROP_MAX_SCALE = 6;

const ASPECT_WH: Record<Exclude<CropAspect, "original" | "custom">, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
  "4:5": 4 / 5,
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The largest crop box (normalized 0..1, source coords) matching `aspect` at
 * `position`, shrunk by `scale` (1 = fit). The box IS the framed region — the
 * camera frames it to fill the output. "original"/"custom" → full frame.
 */
export function cropBoxFor(
  aspect: CropAspect,
  position: CropPosition,
  scale: number,
  sourceAspect: number
): FocusRegion {
  const s = Math.max(1, Number.isFinite(scale) && scale > 0 ? scale : 1);
  const srcAr = Number.isFinite(sourceAspect) && sourceAspect > 0 ? sourceAspect : 16 / 9;

  let bw = 1;
  let bh = 1;
  if (aspect !== "original" && aspect !== "custom") {
    // normalized box width/height ratio so the on-screen box aspect == target.
    const ratioWH = ASPECT_WH[aspect] / srcAr;
    if (ratioWH >= 1) {
      bw = 1;
      bh = 1 / ratioWH;
    } else {
      bh = 1;
      bw = ratioWH;
    }
  }
  bw = clamp01(bw / s);
  bh = clamp01(bh / s);

  let x: number;
  let y: number;
  switch (position) {
    case "left":
      x = 0;
      y = (1 - bh) / 2;
      break;
    case "right":
      x = 1 - bw;
      y = (1 - bh) / 2;
      break;
    case "top":
      x = (1 - bw) / 2;
      y = 0;
      break;
    case "bottom":
      x = (1 - bw) / 2;
      y = 1 - bh;
      break;
    case "center":
    case "custom":
    default:
      x = (1 - bw) / 2;
      y = (1 - bh) / 2;
      break;
  }
  return { x: clamp01(x), y: clamp01(y), width: bw, height: bh };
}

/** Human label for a crop aspect (timeline badge / inspector). */
export function cropAspectLabel(aspect: CropAspect | undefined): string {
  switch (aspect) {
    case "16:9":
    case "9:16":
    case "1:1":
    case "4:5":
      return aspect;
    case "custom":
      return "Custom";
    case "original":
    default:
      return "Orig";
  }
}

/** The active speed section's settings at time `t`, or null (latest start wins). */
export function activeSpeedAt(
  moments: DetectedMoment[] | null | undefined,
  t: number
): SpeedSettings | null {
  if (!moments) return null;
  let pick: DetectedMoment | null = null;
  for (const m of moments) {
    if (m.effectType !== "speed-up") continue;
    if (t < m.startTime || t > m.endTime) continue;
    if (!pick || m.startTime > pick.startTime) pick = m;
  }
  return pick ? pick.speed ?? DEFAULT_SPEED : null;
}

/**
 * Output duration after speed sections compress source time:
 * `source − Σ(sectionDur − sectionDur/multiplier)`. Assumes speed sections
 * don't overlap (the editor doesn't create overlapping ones); slight
 * inaccuracy if they do.
 */
export function outputDurationFor(
  moments: DetectedMoment[] | null | undefined,
  sourceDuration: number
): number {
  if (!moments || sourceDuration <= 0) return Math.max(0, sourceDuration);
  let reduction = 0;
  for (const m of moments) {
    if (m.effectType !== "speed-up") continue;
    const mult = Math.max(1, m.speed?.multiplier ?? DEFAULT_SPEED.multiplier);
    const start = Math.max(0, Math.min(sourceDuration, m.startTime));
    const end = Math.max(0, Math.min(sourceDuration, m.endTime));
    const dur = Math.max(0, end - start);
    reduction += dur - dur / mult;
  }
  return Math.max(0, sourceDuration - reduction);
}
