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
  CutSettings,
  DetectedMoment,
  FocusRegion,
  SpeedSettings,
} from "@/lib/firebase/schema";
import { isMomentEnabled } from "@/lib/firebase/schema";

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

/** A new cut is active (applied) by default; "restore" flips this to false. */
export const DEFAULT_CUT: CutSettings = {
  active: true,
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

/** True when a speed moment is applied (enabled → compresses its range). */
export function isActiveSpeed(m: DetectedMoment): boolean {
  return m.effectType === "speed-up" && isMomentEnabled(m);
}

/** The active speed section's settings at time `t`, or null (latest start wins). */
export function activeSpeedAt(
  moments: DetectedMoment[] | null | undefined,
  t: number
): SpeedSettings | null {
  if (!moments) return null;
  let pick: DetectedMoment | null = null;
  for (const m of moments) {
    if (!isActiveSpeed(m)) continue;
    if (t < m.startTime || t > m.endTime) continue;
    if (!pick || m.startTime > pick.startTime) pick = m;
  }
  return pick ? pick.speed ?? DEFAULT_SPEED : null;
}

/**
 * True when a cut moment is active (applied → removes its range). TWO
 * independent off-switches keep the range: `enabled === false` (the universal
 * per-edit hide, shared with every other effect type) and `cut.active === false`
 * (the cut lane's own "restore" affordance). Either one wins.
 */
export function isActiveCut(m: DetectedMoment): boolean {
  return m.effectType === "cut" && m.cut?.active !== false && isMomentEnabled(m);
}

/**
 * The ACTIVE cut covering time `t`, or null. An active cut removes its range —
 * preview skips it, export excludes it. Restored cuts (`active:false`) return
 * null so they play/export normally.
 */
export function activeCutAt(
  moments: DetectedMoment[] | null | undefined,
  t: number
): DetectedMoment | null {
  if (!moments) return null;
  let pick: DetectedMoment | null = null;
  for (const m of moments) {
    if (!isActiveCut(m)) continue;
    if (t < m.startTime || t >= m.endTime) continue;
    // Latest end wins so a seek lands past the furthest overlapping cut.
    if (!pick || m.endTime > pick.endTime) pick = m;
  }
  return pick;
}

/**
 * If `t` falls inside an active cut, return the time just past it (the cut's
 * end, chained through any adjacent/overlapping cuts); otherwise `t`. Used to
 * snap seeks out of removed ranges to the nearest valid time.
 */
export function snapOutOfActiveCut(
  moments: DetectedMoment[] | null | undefined,
  t: number
): number {
  let cur = t;
  // Chain through back-to-back cuts (the end of one may sit inside the next).
  for (let i = 0; i < 64; i++) {
    const cut = activeCutAt(moments, cur);
    if (!cut) return cur;
    cur = cut.endTime;
  }
  return cur;
}

/**
 * How far PAST a cut's end a skip must land.
 *
 * `activeCutAt` excludes the end boundary (`t >= endTime`), so a seek that lands
 * even a fraction short is still inside the cut and re-triggers on the next
 * frame. Browsers snap seeks to keyframes, so "a fraction short" is the normal
 * case, not the edge case.
 */
export const CUT_SKIP_EPSILON = 1e-3;

/**
 * Where playback should jump to when the playhead is inside an active cut, or
 * `null` when it isn't inside one.
 *
 * Extracted from the preview's rAF loop so the rule can be tested: the returned
 * time must be strictly outside EVERY active cut. Getting that wrong doesn't
 * look like a bug in the maths — it looks like the video stuttering, because a
 * target that is still inside a cut makes the next frame seek again, and each
 * seek is a decoder flush plus (on a remote source) a fresh range request.
 *
 * Chains adjacent cuts so a run of them costs ONE seek, not one per cut.
 */
export function cutSkipTarget(
  moments: DetectedMoment[] | null | undefined,
  t: number,
  duration?: number
): number | null {
  const cut = activeCutAt(moments, t);
  if (!cut) return null;
  const chained = snapOutOfActiveCut(moments, cut.endTime + CUT_SKIP_EPSILON);
  const target = chained + CUT_SKIP_EPSILON;
  return duration && Number.isFinite(duration) ? Math.min(duration, target) : target;
}

/** Merge overlapping/adjacent ranges (sorted by start). */
function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** One contiguous span of source time that survives to the output. */
export interface TimelineSegment {
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  speedMultiplier: number;
}

/** The full source→output mapping for a set of moments. */
export interface TimelineMap {
  segments: TimelineSegment[];
  sourceDuration: number;
  outputDuration: number;
  /** Source seconds removed by active cuts (does NOT count speed compression). */
  totalRemoved: number;
  activeCuts: number;
  inactiveCuts: number;
}

/**
 * Build the source→output timeline mapping — the single source of truth for cut
 * removal + speed compression, shared by preview, export, and the UI summaries.
 *
 * 1. Active cuts are removed (cut wins over everything).
 * 2. The surviving (included) ranges are split at speed-section boundaries.
 * 3. Each sub-segment's output length is `sourceLen / speedMultiplier`.
 *
 * Because speed is only applied WITHIN included ranges, a speed section that
 * overlaps a cut contributes nothing on the removed part — cut wins automatically.
 */
export function buildTimelineMap(
  moments: DetectedMoment[] | null | undefined,
  sourceDuration: number
): TimelineMap {
  const dur = Math.max(0, sourceDuration);
  const list = moments ?? [];
  const activeCuts = list.filter(isActiveCut).length;
  // Every cut that is NOT applied — restored (`cut.active: false`) or disabled
  // (`enabled: false`). Both keep their range, so both belong in this count;
  // active + inactive therefore always equals the number of cut moments.
  const inactiveCuts = list.filter(
    (m) => m.effectType === "cut" && !isActiveCut(m)
  ).length;

  if (dur <= 0) {
    return { segments: [], sourceDuration: dur, outputDuration: 0, totalRemoved: 0, activeCuts, inactiveCuts };
  }

  // 1. Active cut ranges (clamped + merged).
  const cutRanges = mergeRanges(
    list
      .filter(isActiveCut)
      .map((m) => ({
        start: Math.max(0, Math.min(dur, m.startTime)),
        end: Math.max(0, Math.min(dur, m.endTime)),
      }))
      .filter((r) => r.end > r.start)
  );
  const totalRemoved = cutRanges.reduce((a, r) => a + (r.end - r.start), 0);

  // 2. Included ranges = complement of the cut ranges within [0, dur].
  const included: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const r of cutRanges) {
    if (r.start > cursor) included.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < dur) included.push({ start: cursor, end: dur });

  // 3. Speed-section boundaries (start/end times) for splitting included ranges.
  const speeds = list
    .filter(isActiveSpeed)
    .map((m) => ({
      start: Math.max(0, Math.min(dur, m.startTime)),
      end: Math.max(0, Math.min(dur, m.endTime)),
      mult: Math.max(1, m.speed?.multiplier ?? DEFAULT_SPEED.multiplier),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const speedAt = (t: number): number => {
    // Latest-start speed section covering the midpoint wins.
    let mult = 1;
    let bestStart = -Infinity;
    for (const s of speeds) {
      if (t >= s.start && t < s.end && s.start > bestStart) {
        mult = s.mult;
        bestStart = s.start;
      }
    }
    return mult;
  };

  const segments: TimelineSegment[] = [];
  let outAcc = 0;
  for (const inc of included) {
    // Boundaries that fall strictly inside this included range.
    const bounds = new Set<number>([inc.start, inc.end]);
    for (const s of speeds) {
      if (s.start > inc.start && s.start < inc.end) bounds.add(s.start);
      if (s.end > inc.start && s.end < inc.end) bounds.add(s.end);
    }
    const sorted = [...bounds].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const sStart = sorted[i];
      const sEnd = sorted[i + 1];
      if (sEnd <= sStart) continue;
      const mult = speedAt((sStart + sEnd) / 2);
      const outLen = (sEnd - sStart) / mult;
      segments.push({
        sourceStart: sStart,
        sourceEnd: sEnd,
        outputStart: outAcc,
        outputEnd: outAcc + outLen,
        speedMultiplier: mult,
      });
      outAcc += outLen;
    }
  }

  return {
    segments,
    sourceDuration: dur,
    outputDuration: outAcc,
    totalRemoved,
    activeCuts,
    inactiveCuts,
  };
}

/**
 * Output duration after active cuts are removed AND speed sections compress the
 * survivors. Single source of truth via {@link buildTimelineMap}.
 */
export function outputDurationFor(
  moments: DetectedMoment[] | null | undefined,
  sourceDuration: number
): number {
  if (sourceDuration <= 0) return Math.max(0, sourceDuration);
  return buildTimelineMap(moments, sourceDuration).outputDuration;
}

/**
 * Map an OUTPUT time to the SOURCE time it samples — the CANONICAL evaluator
 * of {@link buildTimelineMap}. Video frames AND overlays (captions, hook
 * text, …) must share this one mapping so cuts/speed can never desync them:
 * the export worker seeks its decoder with it and passes the SAME sourceTime
 * to the overlay pass. Past the last segment (frame-rounding at the tail)
 * clamps to the final segment's end.
 */
export function sourceTimeForOutput(map: TimelineMap, outputTime: number): number {
  const segs = map.segments;
  for (const s of segs) {
    if (outputTime >= s.outputStart && outputTime < s.outputEnd) {
      const st = s.sourceStart + (outputTime - s.outputStart) * s.speedMultiplier;
      return Math.min(s.sourceEnd, Math.max(s.sourceStart, st));
    }
  }
  const last = segs[segs.length - 1];
  return last ? last.sourceEnd : outputTime;
}
