/**
 * Shared camera model — the single source of truth for "where does the camera
 * sit at this instant".
 *
 * Used by the live preview (`RealVideoPlayer`), the browser export, the desktop
 * local export (it shells the same worker CLI), the Cloud Run worker and the
 * Remotion renderer. All five call `resolveCameraFrame`; none of them owns any
 * camera math of its own, which is what makes preview/export parity structural
 * rather than hoped-for.
 *
 * ── What this resolver guarantees ────────────────────────────────────────────
 *
 * 1. NO JUMPS. Every move rides `easeCinematic` (smootherstep): zero velocity
 *    AND zero acceleration at both ends, so the camera lands instead of
 *    arriving. Ramps are absolute seconds from the active zoom preset, not a
 *    fraction of the edit, so a 2s zoom and a 20s zoom settle identically.
 *
 * 2. NO BOUNCE BETWEEN ZOOMS. Consecutive camera edits are stitched into a
 *    schedule (`buildSchedule`). When the next edit starts within
 *    `LINK_MAX_GAP_S`, the outgoing edit does NOT release to identity and the
 *    incoming one does NOT ramp up from it — the camera glides directly from
 *    one framing to the next, holding the previous pose across the gap.
 *    Momentum carries; the old "zoom out, zoom straight back in" flutter on
 *    click-heavy recordings is gone by construction.
 *
 * 3. NO OVERLAPPING CAMERAS. The schedule resolves priority once per time
 *    interval, so exactly one edit owns the camera at any instant. Slivers
 *    shorter than `MIN_SLOT_S` are dropped rather than rendered as a flash.
 *
 * 4. NO EXCESSIVE ZOOM. The scale comes from the preset's window scaled by
 *    intensity, then capped by `subjectFitScale` so the emphasised subject is
 *    always fully inside the frame with padding. The old code derived scale
 *    from the focus-box size alone and a small detected box could demand 2.4×.
 *
 * 5. NO STARING. Past `maxHoldS` the camera relaxes toward `settleRatio` of the
 *    zoom instead of holding a hard push for the whole edit.
 *
 * Keyframed moments still own their own path (the user placed those keys) —
 * they get the entry/exit stitching but no envelope and no settle.
 */

import type {
  DetectedMoment,
  EaseKind,
  MomentKeyframe,
} from "@/lib/firebase/schema";
import { isMomentEnabled, isOverlayEffectType } from "@/lib/firebase/schema";
import { isActiveCut } from "@/lib/timeline/crop-speed";
import {
  RAMP_MAX_S,
  RAMP_MIN_S,
  easeCinematic,
  resolveZoomProfile,
  targetScaleFor,
  type ZoomPresetId,
  type ZoomProfile,
} from "@/lib/timeline/zoom-presets";

export {
  CAMERA_SPEED_DEFAULT,
  DEFAULT_ZOOM_PRESET,
  ZOOM_PRESETS,
  ZOOM_PRESET_IDS,
  easeCinematic,
  type ZoomPreset,
  type ZoomPresetId,
} from "@/lib/timeline/zoom-presets";

export interface CameraState {
  /** Final zoom scale applied to the frame (≥ 1). */
  scale: number;
  /** Horizontal pan, percent of frame width. Preview: translateX%. */
  panXPct: number;
  /** Vertical pan, percent of frame height. */
  panYPct: number;
  /**
   * Focal centre in source-normalised coords (0..1). Canonical pan
   * representation — `panXPct = 100 * (0.5 - cx)`. Surfaced so consumers
   * (canvas exporter, debug overlay) that need to project into pixel
   * space don't have to invert the percentage.
   */
  cx: number;
  cy: number;
}

export const IDENTITY_CAMERA: CameraState = {
  scale: 1,
  panXPct: 0,
  panYPct: 0,
  cx: 0.5,
  cy: 0.5,
};

/** Crop/reframe can zoom harder than a cinematic zoom (e.g. 16:9 → 9:16). */
const CROP_MAX_SCALE = 6;

/**
 * Two camera edits closer than this hand the camera over directly instead of
 * releasing to identity between them. Half a second is about where a viewer
 * stops reading two pushes as one continuous move.
 */
const LINK_MAX_GAP_S = 0.5;
/** A hand-over never happens faster than this, however snappy the ramp is. */
const LINK_MIN_TRANSITION_S = 0.35;
/**
 * A camera edit that owns less time than this is dropped from the schedule.
 * Below ~a quarter second a zoom is a flash, and flashes are what "shaky" is
 * made of. The edit stays on the timeline and keeps its overlays — it just
 * doesn't move the camera.
 */
const MIN_SLOT_S = 0.25;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function clampRange(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
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
      // Smootherstep here too — a keyframed path shouldn't be second-order
      // rougher than an automatic one just because the user placed the keys.
      return easeCinematic(x);
    case "linear":
    default:
      return x;
  }
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
 * Clamp a viewport centre so the zoomed window stays fully inside the source
 * frame (no black bars from peeking off the edge). At `scale`, the visible
 * window has half-width `1/(2*scale)`, so the centre must live in
 * `[half, 1-half]`. When the window is larger than the frame on an axis
 * (half > 0.5) we fall back to dead centre on that axis.
 */
function clampCenterToFrame(
  cx: number,
  cy: number,
  scale: number
): { cx: number; cy: number } {
  const half = 1 / (2 * Math.max(1, scale));
  const clampAxis = (v: number) => {
    const x = Number.isFinite(v) ? v : 0.5;
    return half >= 0.5 ? 0.5 : Math.max(half, Math.min(1 - half, x));
  };
  return { cx: clampAxis(cx), cy: clampAxis(cy) };
}

/** Build a CameraState from a centre + scale, keeping the window in frame. */
function cameraFrom(cxRaw: number, cyRaw: number, scaleRaw: number): CameraState {
  const scale = Math.max(1, Number.isFinite(scaleRaw) ? scaleRaw : 1);
  const { cx, cy } = clampCenterToFrame(cxRaw, cyRaw, scale);
  return {
    scale,
    panXPct: (0.5 - cx) * 100,
    panYPct: (0.5 - cy) * 100,
    cx,
    cy,
  };
}

/**
 * Continuous interpolation between two camera poses. Scale and focal centre are
 * blended together (never one before the other — that's what makes a move read
 * as a drift instead of a zoom) and the result is re-clamped, so an intermediate
 * pose can't peek off the frame even when the two endpoints are both legal.
 */
function lerpCamera(a: CameraState, b: CameraState, w: number): CameraState {
  const f = clamp01(w);
  if (f <= 0) return a;
  if (f >= 1) return b;
  return cameraFrom(
    a.cx + (b.cx - a.cx) * f,
    a.cy + (b.cy - a.cy) * f,
    a.scale + (b.scale - a.scale) * f
  );
}

/**
 * How long this edit's camera ramp lasts, in seconds — the preset's in-ramp with
 * the 0..100 speed control folded in, capped so the ramps can't swallow a short
 * edit whole. Exported because the inspector previews it and the tests pin its
 * monotonicity.
 *
 * ABSENT speed ⇒ the neutral ramp; `CAMERA_SPEED_DEFAULT` is the same value by
 * construction, so a slider left alone is a no-op.
 */
export function rampSeconds(
  durSec: number,
  speed?: number,
  preset?: ZoomPresetId
): number {
  const profile = resolveZoomProfile(preset, speed);
  const cap = Math.max(0.06, (Number.isFinite(durSec) ? durSec : 0) * 0.45);
  return clampRange(Math.min(profile.rampIn, cap), Math.min(RAMP_MIN_S, cap), RAMP_MAX_S);
}

// ─────────────────────────────────────────────────────────────────────────
// FULL-STRENGTH TARGETS — where an edit wants the camera, before stitching.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Crop/Reframe target: frame the crop box (the moment's `focusRegion`) to COVER
 * the output — scale so the box fills the frame, excess cropped. Allowed a much
 * higher scale than a cinematic zoom so a tight reframe isn't clamped.
 */
function cropTarget(m: DetectedMoment): CameraState {
  const box = m.focusRegion;
  const fill =
    box.width > 0 && box.height > 0 ? Math.max(1 / box.width, 1 / box.height) : 1;
  return cameraFrom(
    box.x + box.width / 2,
    box.y + box.height / 2,
    clampRange(fill, 1, CROP_MAX_SCALE)
  );
}

/** Static zoom target: the focus centre, at the preset's intensity-picked scale. */
function zoomTarget(
  m: DetectedMoment,
  intensity: number,
  profile: ZoomProfile
): CameraState {
  return cameraFrom(
    m.focusRegion.x + m.focusRegion.width / 2,
    m.focusRegion.y + m.focusRegion.height / 2,
    targetScaleFor(profile, m.focusRegion.width, m.focusRegion.height, intensity)
  );
}

/** Keyframed target at a local progress — the user's path, preset-scaled. */
function keyframeTarget(
  m: DetectedMoment,
  kfs: MomentKeyframe[],
  p: number,
  profile: ZoomProfile
): CameraState {
  const { a, b, f } = bracket(kfs, clamp01(p));
  const intensity = a.scale + (b.scale - a.scale) * f;
  return cameraFrom(
    a.x + (b.x - a.x) * f,
    a.y + (b.y - a.y) * f,
    targetScaleFor(profile, m.focusRegion.width, m.focusRegion.height, intensity)
  );
}

// ─────────────────────────────────────────────────────────────────────────
// THE SCHEDULE — one camera owner per instant, stitched end to end.
// ─────────────────────────────────────────────────────────────────────────

interface CameraSlot {
  moment: DetectedMoment;
  /** The window in which this edit owns the camera (post priority resolution). */
  start: number;
  end: number;
  profile: ZoomProfile;
  intensity: number;
  /** Effective ramps after the min-hold squeeze. 0 = suppressed (linked/instant). */
  rampIn: number;
  rampOut: number;
  /** The previous slot hands the camera over directly. */
  linkedIn: boolean;
  /** This slot hands the camera to the next one directly. */
  linkedOut: boolean;
  /** Full-strength pose at `end` — the hand-over the next slot ramps from. */
  exit: CameraState;
}

/**
 * Camera priority for overlap resolution: user crop/reframe > user zoom/focus >
 * AI crop > AI zoom/focus. Higher wins; ties break on latest startTime.
 */
function cameraPriority(m: DetectedMoment): number {
  if (m.effectType === "crop") return m.source === "user" ? 5 : 4;
  return m.source === "user" ? 3 : 2;
}

/** Edits that are allowed to move the camera at all. */
function isCameraMoment(m: DetectedMoment, activeCuts: DetectedMoment[]): boolean {
  // Speed + Cut are timing-only; Phase-3 overlays and smart-crop are drawn
  // elsewhere. Disabled edits are skipped outright so a hidden edit can't
  // out-priority a visible one underneath it.
  if (m.effectType === "speed-up" || m.effectType === "cut") return false;
  if (isOverlayEffectType(m.effectType)) return false;
  if (!isMomentEnabled(m)) return false;
  if (!Number.isFinite(m.startTime) || !Number.isFinite(m.endTime)) return false;
  if (m.endTime <= m.startTime) return false;
  // Fully inside removed time — never visible, so never scheduled.
  if (
    activeCuts.some((c) => m.startTime >= c.startTime && m.endTime <= c.endTime)
  ) {
    return false;
  }
  return true;
}

/**
 * Blend the moment's own intensity with the project's autoZoom floor. Single,
 * canonical formula — preview and export previously inlined this with slightly
 * different fallback chains (export was missing `?? m.importance`, leaking zoom
 * on legacy moments).
 */
export function blendIntensity(m: DetectedMoment, autoZoomPct: number): number {
  const perMoment =
    m.intensity ??
    m.recommendedIntensity ??
    m.attentionScore ??
    m.importance ??
    0.5;
  return clamp01(perMoment * 0.6 + clamp01(autoZoomPct / 100) * 0.4);
}

/** The profile this edit renders with: per-edit override, else the project's. */
function profileFor(m: DetectedMoment, opts: ResolverOpts): ZoomProfile {
  return resolveZoomProfile(
    m.cameraMotion?.preset ?? opts.preset,
    m.cameraMotion?.speed ?? opts.speed
  );
}

/**
 * Resolve the camera-owning edit for every instant, then stitch the resulting
 * slots together. Deterministic and pure: preview and every export build the
 * identical schedule from the identical inputs.
 */
function buildSchedule(
  moments: DetectedMoment[],
  opts: ResolverOpts
): CameraSlot[] {
  const activeCuts = moments.filter(isActiveCut);
  const cams = moments.filter((m) => isCameraMoment(m, activeCuts));
  if (cams.length === 0) return [];

  // 1. Cut time at every edit boundary, then pick one winner per interval. The
  //    midpoint sample makes the winner well-defined even where three edits
  //    overlap, and merging equal neighbours keeps the slot list minimal.
  const bounds = new Set<number>();
  for (const m of cams) {
    bounds.add(m.startTime);
    bounds.add(m.endTime);
  }
  const points = [...bounds].sort((a, b) => a - b);

  const raw: { moment: DetectedMoment; start: number; end: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end - start <= 0) continue;
    const mid = (start + end) / 2;
    let winner: DetectedMoment | null = null;
    let winnerPri = -1;
    for (const m of cams) {
      if (mid < m.startTime || mid > m.endTime) continue;
      const pri = cameraPriority(m);
      if (
        !winner ||
        pri > winnerPri ||
        (pri === winnerPri && m.startTime > winner.startTime)
      ) {
        winner = m;
        winnerPri = pri;
      }
    }
    if (!winner) continue;
    const prev = raw[raw.length - 1];
    if (prev && prev.moment === winner && Math.abs(prev.end - start) < 1e-9) {
      prev.end = end;
    } else {
      raw.push({ moment: winner, start, end });
    }
  }

  // 2. Drop slivers — an edit that owns a handful of frames would flash.
  const kept = raw.filter((s) => s.end - s.start >= MIN_SLOT_S);
  if (kept.length === 0) return [];

  // 3. Link pass: neighbours close enough in time hand the camera over instead
  //    of both travelling through identity.
  const linked = kept.map((s) => ({ ...s, linkedIn: false, linkedOut: false }));
  for (let i = 0; i < linked.length - 1; i++) {
    if (linked[i + 1].start - linked[i].end <= LINK_MAX_GAP_S) {
      linked[i].linkedOut = true;
      linked[i + 1].linkedIn = true;
    }
  }

  // 4. Ramps, squeezed so a short edit still holds its framing for a beat, then
  //    the hand-over pose each linked neighbour ramps from.
  const slots: CameraSlot[] = linked.map((s) => {
    const profile = profileFor(s.moment, opts);
    const dur = s.end - s.start;
    const instantCrop =
      s.moment.effectType === "crop" && s.moment.crop?.easing === "instant";

    let rampIn = instantCrop
      ? 0
      : s.linkedIn
        ? Math.max(profile.rampIn, LINK_MIN_TRANSITION_S)
        : profile.rampIn;
    let rampOut = instantCrop || s.linkedOut ? 0 : profile.rampOut;

    const hold = Math.min(profile.minHoldS, dur * 0.35);
    const total = rampIn + rampOut;
    if (total > 0 && total + hold > dur) {
      const k = Math.max(0, (dur - hold) / total);
      rampIn *= k;
      rampOut *= k;
    }

    return {
      moment: s.moment,
      start: s.start,
      end: s.end,
      profile,
      intensity: blendIntensity(s.moment, opts.autoZoom),
      rampIn,
      rampOut,
      linkedIn: s.linkedIn,
      linkedOut: s.linkedOut,
      exit: IDENTITY_CAMERA, // filled below, once the slot exists
    };
  });

  for (const slot of slots) slot.exit = fullStrengthAt(slot, slot.end);
  return slots;
}

/**
 * The pose this edit wants at `t`, before any entry/exit stitching: the crop
 * framing, the keyframed path, or the static zoom target with the long-hold
 * settle applied.
 */
function fullStrengthAt(slot: CameraSlot, t: number): CameraState {
  const m = slot.moment;
  if (m.effectType === "crop") return cropTarget(m);

  const kfs = m.keyframes;
  if (kfs && kfs.length > 0) {
    // The user placed these keys — no settle, no envelope, just their path.
    return keyframeTarget(m, kfs, localProgress(m, t), slot.profile);
  }

  const target = zoomTarget(m, slot.intensity, slot.profile);
  const held = t - slot.start - slot.rampIn;
  if (held <= slot.profile.maxHoldS) return target;

  // Long hold: relax toward `settleRatio` of the push rather than staring. The
  // framing stays — only the emphasis eases off, which is what an editor does
  // when a shot outlives its beat.
  const w = easeCinematic((held - slot.profile.maxHoldS) / slot.profile.settleS);
  const strength = 1 - (1 - slot.profile.settleRatio) * w;
  return lerpCamera(IDENTITY_CAMERA, target, strength);
}

/** Index of the slot owning `t`, or -1. Slots are sorted and non-overlapping. */
function slotIndexAt(slots: CameraSlot[], t: number): number {
  for (let i = slots.length - 1; i >= 0; i--) {
    if (t >= slots[i].start && t <= slots[i].end) return i;
  }
  return -1;
}

/** The stitched camera at an absolute source time. */
function cameraAtTime(slots: CameraSlot[], t: number): CameraState {
  const idx = slotIndexAt(slots, t);
  if (idx < 0) {
    // Between two linked slots the camera holds the outgoing pose rather than
    // dropping to identity for a few frames and climbing back — that flutter is
    // exactly what "the zooms fight each other" looks like.
    for (let i = 0; i < slots.length - 1; i++) {
      if (
        slots[i].linkedOut &&
        t > slots[i].end &&
        t < slots[i + 1].start
      ) {
        return slots[i].exit;
      }
    }
    return IDENTITY_CAMERA;
  }

  const slot = slots[idx];
  const base = fullStrengthAt(slot, t);
  const local = t - slot.start;
  const remaining = slot.end - t;

  if (slot.rampIn > 0 && local < slot.rampIn) {
    const from = slot.linkedIn && idx > 0 ? slots[idx - 1].exit : IDENTITY_CAMERA;
    return lerpCamera(from, base, easeCinematic(local / slot.rampIn));
  }
  if (slot.rampOut > 0 && remaining < slot.rampOut) {
    return lerpCamera(IDENTITY_CAMERA, base, easeCinematic(remaining / slot.rampOut));
  }
  return base;
}

// ── Schedule cache ────────────────────────────────────────────────────────
// The resolver runs once per rendered frame (54k times for a 30-minute 30fps
// export) and the schedule only depends on the moment list + the project-level
// options, so build it once per (list, options) pair. Keyed weakly on the array
// so a re-rendered preview drops its entry with the array.
//
// This assumes the list is treated as IMMUTABLE, which is how the editor works:
// every mutation (`commitMoments`, `updateMoment`, a drag) produces a new array.
// Mutating a moment in place without replacing the array would keep the stale
// schedule until the array identity changes.

const scheduleCache = new WeakMap<object, Map<string, CameraSlot[]>>();

function scheduleFor(
  moments: DetectedMoment[],
  opts: ResolverOpts
): CameraSlot[] {
  const key = `${opts.autoZoom}|${opts.preset ?? ""}|${opts.speed ?? ""}`;
  let byOpts = scheduleCache.get(moments);
  if (!byOpts) {
    byOpts = new Map();
    scheduleCache.set(moments, byOpts);
  }
  const hit = byOpts.get(key);
  if (hit) return hit;
  const built = buildSchedule(moments, opts);
  // A live editor only ever cycles through a couple of option sets; drop the
  // whole bucket rather than grow it without bound.
  if (byOpts.size > 8) byOpts.clear();
  byOpts.set(key, built);
  return built;
}

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────

export interface ResolverOpts {
  /**
   * Project-level intensity floor (0..100). Mixed with the moment's own
   * intensity to give the final blended value. From `effectsSettings.autoZoom`.
   */
  autoZoom: number;
  /**
   * Project-level zoom preset (`effectsSettings.zoomPreset`). A per-edit
   * `cameraMotion.preset` overrides it. Absent ⇒ "standard".
   */
  preset?: ZoomPresetId;
  /**
   * Project-level camera speed 0..100 (`effectsSettings.zoomSpeed`). A per-edit
   * `cameraMotion.speed` overrides it. Absent ⇒ the neutral ramp.
   */
  speed?: number;
}

/**
 * Single source of truth for "what camera is active at time `t`?". Used by
 * preview and every export path. Returns `IDENTITY_CAMERA` when nothing is
 * active.
 *
 * `moment` is the edit under the playhead by the same priority rule, and is what
 * the compositor resolves the click highlight from. It can be non-null while the
 * camera sits at identity (a sliver edit that was dropped from the schedule) and
 * null while the camera is mid-hand-over between two linked zooms — both are
 * deliberate: overlay visibility and camera ownership are different questions.
 */
export function resolveCameraFrame(
  moments: DetectedMoment[] | null | undefined,
  t: number,
  opts: ResolverOpts
): { camera: CameraState; moment: DetectedMoment | null } {
  if (!moments || moments.length === 0) {
    return { camera: IDENTITY_CAMERA, moment: null };
  }
  const slots = scheduleFor(moments, opts);
  const camera = slots.length > 0 ? cameraAtTime(slots, t) : IDENTITY_CAMERA;
  return { camera, moment: pickActiveMoment(moments, t) };
}

/**
 * The edit under the playhead, by camera priority (user crop > user zoom > AI),
 * ties broken on the latest startTime. Kept separate from the schedule because
 * the compositor also uses it to decide which click highlight to draw.
 */
function pickActiveMoment(
  moments: DetectedMoment[],
  t: number
): DetectedMoment | null {
  const activeCuts = moments.filter(isActiveCut);
  let pick: DetectedMoment | null = null;
  let pickPri = -1;
  for (const m of moments) {
    if (!isCameraMoment(m, activeCuts)) continue;
    if (t < m.startTime || t > m.endTime) continue;
    const pri = cameraPriority(m);
    if (!pick || pri > pickPri || (pri === pickPri && m.startTime > pick.startTime)) {
      pick = m;
      pickPri = pri;
    }
  }
  return pick;
}

/**
 * The camera for ONE moment in isolation, at a local progress (0..1).
 *
 * A thin wrapper over the same schedule the resolver builds — a single-edit
 * timeline — so this can never drift from what actually renders. Prefer
 * `resolveCameraFrame` in new code: it is the only entry point that knows about
 * neighbouring edits, and therefore the only one that can stitch them.
 */
export function cameraForMoment(
  m: DetectedMoment,
  blendedIntensity: number,
  localProgressValue: number,
  opts?: { preset?: ZoomPresetId; speed?: number }
): CameraState {
  const dur = m.endTime - m.startTime;
  if (!(dur > 0)) return IDENTITY_CAMERA;
  // `blendedIntensity` is already blended, so feed the schedule an autoZoom that
  // reproduces it exactly: blend(m, a) = own*0.6 + a/100*0.4, and the caller has
  // pre-blended, so bypass by pinning the moment's own intensity.
  const pinned: DetectedMoment = { ...m, intensity: blendedIntensity };
  const slots = buildSchedule([pinned], {
    autoZoom: blendedIntensity * 100,
    preset: opts?.preset,
    speed: opts?.speed,
  });
  if (slots.length === 0) return IDENTITY_CAMERA;
  return cameraAtTime(slots, m.startTime + clamp01(localProgressValue) * dur);
}

/**
 * Seed a 2-keyframe set from a moment's static focus region — a gentle
 * settle-in push. The starting point for hand-editing camera motion.
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

/**
 * Convert a CameraState into the canvas pixel translates required by the
 * export's `ctx.translate(canvasW/2,...); ctx.scale(s,s); ctx.translate(tx,ty)`
 * chain. Using `drawW`/`drawH` (the post-cover dimensions) rather than the
 * canvas size places the focal point at the canvas centre regardless of
 * source/canvas aspect mismatch — the fix for vertical exports of a 16:9
 * recording, where the focal point used to land off-canvas.
 */
export function canvasTranslateFor(
  camera: CameraState,
  drawW: number,
  drawH: number
): { tx: number; ty: number } {
  return {
    tx: (0.5 - camera.cx) * drawW,
    ty: (0.5 - camera.cy) * drawH,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// DEBUG / DIAGNOSTIC HELPERS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Capture the camera at a single timestamp, plus the pixel translate the export
 * would use. Used by the dev-only "Camera diagnostics" toggle in the editor —
 * log this for a few timestamps on both surfaces and the rows must match.
 */
export interface CameraSnapshot {
  t: number;
  momentId: string | null;
  scale: number;
  cx: number;
  cy: number;
  panXPct: number;
  panYPct: number;
  /** Pixel translate that WOULD be used by export at the given draw size. */
  canvasTranslate: { tx: number; ty: number };
}

export function cameraDiagnostic(
  moments: DetectedMoment[] | null | undefined,
  t: number,
  opts: ResolverOpts & { drawW: number; drawH: number }
): CameraSnapshot {
  const { camera, moment } = resolveCameraFrame(moments, t, opts);
  const px = canvasTranslateFor(camera, opts.drawW, opts.drawH);
  return {
    t,
    momentId: moment?.id ?? null,
    scale: camera.scale,
    cx: camera.cx,
    cy: camera.cy,
    panXPct: camera.panXPct,
    panYPct: camera.panYPct,
    canvasTranslate: px,
  };
}
