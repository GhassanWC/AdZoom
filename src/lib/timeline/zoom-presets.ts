/**
 * Zoom presets — the tuned defaults behind every camera move Framevo makes.
 *
 * ONE table, consumed by the ONE camera resolver (`timeline/camera.ts`), which
 * preview, the browser export, the desktop local export (it shells the same
 * worker CLI), the Cloud Run worker and the Remotion renderer all resolve
 * through. Change a number here and every surface changes together — there is
 * no second place where a zoom is described.
 *
 * A preset answers the questions a human editor answers by feel:
 *
 *   how far do we push in?      → `minScale` .. `maxScale` (intensity picks a
 *                                  point in the window; the subject-fit cap can
 *                                  only lower it, never raise it)
 *   how long does it take?      → `rampInS` / `rampOutS`, absolute seconds, so a
 *                                  zoom takes the same time to settle whether
 *                                  it's held for 2s or 20s
 *   how long do we stay?        → `minHoldS` (never a flash) and `maxHoldS` +
 *                                  `settleRatio` (never a stare)
 *   how close to the edge?      → `safePadding` keeps the subject off the frame
 *                                  border with room to breathe
 *   how long should one BE?     → `minDurationS` / `maxDurationS`, the window
 *                                  generated (AI + manual) zooms are held to
 *
 * The out-ramp is deliberately a touch longer than the in-ramp on every preset:
 * pushing in reads as intent, pulling out reads as release, and a symmetric pair
 * feels mechanical.
 */

export type ZoomPresetId = "subtle" | "standard" | "emphasis";

export interface ZoomPreset {
  id: ZoomPresetId;
  label: string;
  /** One line for the picker. */
  hint: string;
  /** Zoom scale at intensity 0 — the gentlest push this preset ever makes. */
  minScale: number;
  /** Zoom scale at intensity 1 — the hardest. Never exceeded, ever. */
  maxScale: number;
  /** Seconds to reach framing at neutral speed. */
  rampInS: number;
  /** Seconds to release back out at neutral speed. */
  rampOutS: number;
  /** The camera must sit at full framing this long — ramps shrink to protect it. */
  minHoldS: number;
  /** After this long at full framing, the camera relaxes toward `settleRatio`. */
  maxHoldS: number;
  /** Fraction of the zoom kept after the settle (1 = no relaxation). */
  settleRatio: number;
  /** Seconds the settle takes. */
  settleS: number;
  /** Padding (source units, 0..1) kept around the subject inside the window. */
  safePadding: number;
  /** Shortest generated zoom — below this a zoom reads as a flash. */
  minDurationS: number;
  /** Longest generated zoom — beyond this the shot stops breathing. */
  maxDurationS: number;
}

export const ZOOM_PRESETS: Record<ZoomPresetId, ZoomPreset> = {
  subtle: {
    id: "subtle",
    label: "Subtle",
    hint: "Barely-there push. Documentary calm — the viewer feels it, never sees it.",
    minScale: 1.05,
    maxScale: 1.22,
    rampInS: 0.75,
    rampOutS: 0.9,
    minHoldS: 0.4,
    maxHoldS: 10,
    settleRatio: 0.6,
    settleS: 1.6,
    safePadding: 0.05,
    minDurationS: 1.6,
    maxDurationS: 6,
  },
  standard: {
    id: "standard",
    label: "Standard",
    hint: "The polished default. Clear emphasis, cinematic settle, nothing showy.",
    minScale: 1.08,
    maxScale: 1.38,
    rampInS: 0.55,
    rampOutS: 0.7,
    minHoldS: 0.35,
    maxHoldS: 8,
    settleRatio: 0.62,
    settleS: 1.4,
    safePadding: 0.045,
    minDurationS: 1.3,
    maxDurationS: 5,
  },
  emphasis: {
    id: "emphasis",
    label: "Emphasis",
    hint: "Punchier push for reveals and social cuts. Still eased, never a jump cut.",
    minScale: 1.14,
    maxScale: 1.62,
    rampInS: 0.42,
    rampOutS: 0.6,
    minHoldS: 0.3,
    maxHoldS: 6,
    settleRatio: 0.65,
    settleS: 1.2,
    safePadding: 0.04,
    minDurationS: 1.1,
    maxDurationS: 4.5,
  },
};

export const ZOOM_PRESET_IDS: ZoomPresetId[] = ["subtle", "standard", "emphasis"];

/** What a project gets when nobody has chosen anything. */
export const DEFAULT_ZOOM_PRESET: ZoomPresetId = "standard";

/** Absolute ceiling on a cinematic zoom, whatever preset or intensity asks for. */
export const MAX_ZOOM_SCALE = 1.75;

/** Neutral position of the 0..100 camera-speed control: exactly the preset ramp. */
export const CAMERA_SPEED_DEFAULT = 50;

/** At speed 0 the ramp is this many times the preset's — a slow glide. */
const RAMP_SLOWEST_MULT = 2.2;
/** At speed 100 — punchy, but still an eased move rather than a cut. */
const RAMP_SNAPPIEST_MULT = 0.4;
/** Hard bounds. The floor is ~4 frames at 30fps: below that a ramp reads as a jump. */
export const RAMP_MIN_S = 0.12;
export const RAMP_MAX_S = 1.8;

export function isZoomPresetId(v: unknown): v is ZoomPresetId {
  return v === "subtle" || v === "standard" || v === "emphasis";
}

export function zoomPreset(id: ZoomPresetId | undefined | null): ZoomPreset {
  return ZOOM_PRESETS[isZoomPresetId(id) ? id : DEFAULT_ZOOM_PRESET];
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampRange(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The preset with the speed control folded in — what the resolver actually
 * reads. `speed` is the 0..100 control (per-edit `cameraMotion.speed`, else the
 * project's `effectsSettings.zoomSpeed`, else neutral): higher = snappier. It
 * scales the ramps only; the framing a zoom lands on is identical at every
 * speed, which is what makes the slider safe to drag mid-edit.
 */
export interface ZoomProfile extends ZoomPreset {
  /** Speed-adjusted in-ramp, seconds. */
  rampIn: number;
  /** Speed-adjusted out-ramp, seconds. */
  rampOut: number;
}

/**
 * Ramp multiplier for a 0..100 speed. Two linear halves through
 * (0 → slowest), (50 → 1×), (100 → snappiest): a single curve through three
 * points would make the neutral position a bump on the way past, and the user's
 * mental model is "50 is normal, left is slower, right is faster".
 */
export function rampMultiplier(speed: number | undefined): number {
  if (speed === undefined || speed === null || !Number.isFinite(speed)) return 1;
  const t = clamp01(speed / 100);
  return t <= 0.5
    ? RAMP_SLOWEST_MULT + (1 - RAMP_SLOWEST_MULT) * (t / 0.5)
    : 1 + (RAMP_SNAPPIEST_MULT - 1) * ((t - 0.5) / 0.5);
}

export function resolveZoomProfile(
  presetId: ZoomPresetId | undefined,
  speed?: number
): ZoomProfile {
  const preset = zoomPreset(presetId);
  const mult = rampMultiplier(speed);
  return {
    ...preset,
    rampIn: clampRange(preset.rampInS * mult, RAMP_MIN_S, RAMP_MAX_S),
    rampOut: clampRange(preset.rampOutS * mult, RAMP_MIN_S, RAMP_MAX_S),
  };
}

// ── Easing ────────────────────────────────────────────────────────────────

/**
 * Smootherstep — the curve every automatic camera move rides.
 *
 * Zero VELOCITY and zero ACCELERATION at both ends (unlike the quadratic
 * ease-in-out this replaced, which had an acceleration step at the join). That
 * second-order continuity is the whole difference between a camera that arrives
 * and one that lands: with a velocity-only ease the frame still visibly "sets
 * down" at the top of the ramp, and with consecutive zooms the kink at every
 * join is exactly what reads as shake.
 */
export function easeCinematic(t: number): number {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

// ── Framing helpers ───────────────────────────────────────────────────────

/**
 * The hardest zoom that still keeps `region` fully inside the visible window
 * with `padding` of breathing room on every side.
 *
 * At scale s the window is `1/s` of the source on each axis, so the subject
 * (plus padding) fits iff `1/s >= max(w, h) + 2*padding`. Zooming past that
 * point crops the very thing being emphasised — the reason a small detected
 * region used to produce a wild 2.4× push that clipped the subject's edges.
 */
export function subjectFitScale(
  width: number,
  height: number,
  padding: number
): number {
  const w = Number.isFinite(width) ? Math.max(0, width) : 0;
  const h = Number.isFinite(height) ? Math.max(0, height) : 0;
  const need = Math.max(w, h) + 2 * Math.max(0, padding);
  if (need <= 0) return MAX_ZOOM_SCALE;
  return Math.max(1, Math.min(MAX_ZOOM_SCALE, 1 / need));
}

/**
 * Turn a 0..1 intensity into the scale this profile zooms to for a subject of
 * the given size. The preset window sets the taste; the subject-fit cap is a
 * hard ceiling on top of it.
 */
export function targetScaleFor(
  profile: ZoomPreset,
  width: number,
  height: number,
  intensity: number
): number {
  const wanted =
    profile.minScale + (profile.maxScale - profile.minScale) * clamp01(intensity);
  const capped = Math.min(wanted, subjectFitScale(width, height, profile.safePadding));
  return clampRange(capped, 1, Math.min(profile.maxScale, MAX_ZOOM_SCALE));
}

/**
 * Hold a generated zoom inside the preset's duration window. Too short reads as
 * a flash (and the ramps would eat the whole moment); too long and the shot
 * stops breathing. Never pushes past `limit` (the clip/source duration) and
 * never returns an inverted window.
 */
export function clampZoomWindow(
  start: number,
  end: number,
  profile: ZoomPreset,
  limit: number
): { startTime: number; endTime: number } {
  const max = Number.isFinite(limit) && limit > 0 ? limit : end;
  const s = clampRange(start, 0, Math.max(0, max - 0.2));
  const wanted = clampRange(
    end - s,
    profile.minDurationS,
    profile.maxDurationS
  );
  const e = Math.min(max, s + wanted);
  // A source shorter than the preset floor still gets a valid (if brief) window.
  return { startTime: s, endTime: Math.max(s + 0.2, e) };
}
