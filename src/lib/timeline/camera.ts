/**
 * Shared camera model — the single source of truth for "where does the
 * camera sit for this moment at this instant".
 *
 * Used by BOTH the live preview (`RealVideoPlayer`) and the export
 * renderer (`export.ts`). The bug fixed here: preview and export both
 * called `cameraForMoment(...)` and got the same target camera state, but
 *
 *   1. The preview's rAF loop layered exponential smoothing on top, so
 *      the camera RAMPED into the target at moment start (cinematic).
 *   2. The export jumped straight to the target target on the first frame
 *      of the moment and back to identity on the first frame after — a
 *      hard cut, "barely zoomed" feel.
 *
 * The fix is a moment-edge envelope baked into `cameraForMoment`: for
 * moments without explicit keyframes, scale + pan ramp from identity to
 * target over the first fraction of the moment and back to identity over
 * the last fraction. Preview and export now share that envelope, so the
 * exported video matches the in-editor preview.
 *
 * Keyframed moments DON'T get the envelope — the user/AI has expressly
 * directed the camera path and any auto-easing would suppress their
 * intent. The keyframe interpolation handles its own ease in/out.
 */

import type {
  DetectedMoment,
  EaseKind,
  MomentKeyframe,
} from "@/lib/firebase/schema";
import { isOverlayEffectType } from "@/lib/firebase/schema";

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

const MAX_SCALE = 2.4;
/** Crop/reframe can zoom harder than a normal cinematic zoom (e.g. 16:9→9:16). */
const CROP_MAX_SCALE = 6;

/** Edge-envelope: ramps scale + pan from identity → target → identity. */
const EDGE_FRACTION = 0.18; // 18% of the moment on each edge
const EDGE_MIN_S = 0.12; // never shorter than this (so flash-short moments still ease)
const EDGE_MAX_S = 0.4; // never longer than this (so long moments don't waste runtime)

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
 * Clamp a viewport centre so that the zoomed window stays fully inside the
 * source frame (no black bars from peeking off the edge). At `scale`, the
 * visible window in source units has half-width `1/(2*scale)`, so the centre
 * must live in `[half, 1-half]`. When the scale is so high the window is
 * larger than the frame on one axis (half > 0.5), we fall back to dead
 * center on that axis.
 */
function clampCenterToFrame(
  cx: number,
  cy: number,
  scale: number
): { cx: number; cy: number } {
  const half = 1 / (2 * Math.max(1, scale));
  const clampAxis = (v: number) =>
    half >= 0.5 ? 0.5 : Math.max(half, Math.min(1 - half, v));
  return { cx: clampAxis(cx), cy: clampAxis(cy) };
}

/**
 * Moment edge envelope. Returns a 0..1 multiplier driving how much of the
 * target camera (scale + pan) is active at this local progress:
 *
 *   - 0 → identity (no zoom, no pan) — at the very edges of the moment
 *   - 1 → full target — in the middle hold region
 *   - eased ramp between
 *
 * Ease-in-out cubic on each side. Edge width is `EDGE_FRACTION` of the
 * moment duration, clamped to [`EDGE_MIN_S`, `EDGE_MAX_S`] so flash-short
 * moments still ease and long moments don't waste half their runtime
 * ramping. Symmetric in / out.
 *
 * For moments shorter than `2*EDGE_MIN_S`, the in and out ramps would
 * overlap; we shorten them proportionally so the curve still peaks at 1
 * in the middle.
 */
function edgeEnvelope(localProg: number, durSec: number): number {
  if (durSec <= 0) return 1;
  let edgeSec = clampRange(durSec * EDGE_FRACTION, EDGE_MIN_S, EDGE_MAX_S);
  if (edgeSec * 2 > durSec) edgeSec = durSec / 2;
  const edge = edgeSec / durSec; // 0..0.5
  if (edge <= 0) return 1;
  if (localProg < edge) return applyEase("ease-in-out", localProg / edge);
  if (localProg > 1 - edge)
    return applyEase("ease-in-out", (1 - localProg) / edge);
  return 1;
}

/**
 * The camera state for a moment at a given local progress (0..1).
 *
 * Static moment (no keyframes): the focusRegion centre is the target, and
 * an envelope ramps the camera in at the start and out at the end so the
 * exporter doesn't hard-cut into/out of the zoom.
 *
 * Keyframed moment: interpolate centre + intensity through the keyframes.
 * No envelope — the user's keyframes own the motion, including any edges.
 */
/**
 * Crop/Reframe camera: frame the crop box (the moment's `focusRegion`) to
 * COVER the output (scale so the box fills the frame; excess cropped). Reuses
 * the shared edge envelope unless `crop.easing === "instant"` (then it holds
 * the framing for the whole section). Allows a higher scale cap than zoom so a
 * tight reframe (e.g. 16:9 → 9:16) isn't clamped.
 */
function cropCamera(m: DetectedMoment, localProgressValue: number): CameraState {
  const box = m.focusRegion;
  const cxRaw = box.x + box.width / 2;
  const cyRaw = box.y + box.height / 2;
  const fill =
    box.width > 0 && box.height > 0
      ? Math.max(1 / box.width, 1 / box.height)
      : 1;
  const targetScale = clampRange(fill, 1, CROP_MAX_SCALE);
  const { cx, cy } = clampCenterToFrame(cxRaw, cyRaw, targetScale);

  if (m.crop?.easing === "instant") {
    return {
      scale: targetScale,
      panXPct: (0.5 - cx) * 100,
      panYPct: (0.5 - cy) * 100,
      cx,
      cy,
    };
  }
  const env = edgeEnvelope(
    clamp01(localProgressValue),
    Math.max(0, m.endTime - m.startTime)
  );
  return {
    scale: 1 + (targetScale - 1) * env,
    panXPct: (0.5 - cx) * 100 * env,
    panYPct: (0.5 - cy) * 100 * env,
    cx: 0.5 + (cx - 0.5) * env,
    cy: 0.5 + (cy - 0.5) * env,
  };
}

export function cameraForMoment(
  m: DetectedMoment,
  blendedIntensity: number,
  localProgressValue: number
): CameraState {
  if (m.effectType === "crop") return cropCamera(m, localProgressValue);
  const kfs = m.keyframes;
  if (kfs && kfs.length > 0) {
    const { a, b, f } = bracket(kfs, clamp01(localProgressValue));
    const cxRaw = a.x + (b.x - a.x) * f;
    const cyRaw = a.y + (b.y - a.y) * f;
    const intensity = a.scale + (b.scale - a.scale) * f;
    const scale = scaleFromFocus(
      m.focusRegion.width,
      m.focusRegion.height,
      intensity
    );
    const { cx, cy } = clampCenterToFrame(cxRaw, cyRaw, scale);
    return {
      scale,
      panXPct: (0.5 - cx) * 100,
      panYPct: (0.5 - cy) * 100,
      cx,
      cy,
    };
  }

  const cxRaw = m.focusRegion.x + m.focusRegion.width / 2;
  const cyRaw = m.focusRegion.y + m.focusRegion.height / 2;
  const targetScale = scaleFromFocus(
    m.focusRegion.width,
    m.focusRegion.height,
    blendedIntensity
  );
  const { cx, cy } = clampCenterToFrame(cxRaw, cyRaw, targetScale);

  // Apply the edge envelope to scale + pan so preview and export both
  // ramp in/out the same way. The clamp uses the FULL target scale so the
  // visible window never leaks off the source frame mid-ramp.
  const env = edgeEnvelope(
    clamp01(localProgressValue),
    Math.max(0, m.endTime - m.startTime)
  );
  const scale = 1 + (targetScale - 1) * env;
  const targetPanXPct = (0.5 - cx) * 100;
  const targetPanYPct = (0.5 - cy) * 100;
  return {
    scale,
    panXPct: targetPanXPct * env,
    panYPct: targetPanYPct * env,
    cx: 0.5 + (cx - 0.5) * env,
    cy: 0.5 + (cy - 0.5) * env,
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

// ─────────────────────────────────────────────────────────────────────────
// SHARED RESOLVER — single source of truth for preview + export.
//
// Use these in NEW callers instead of `cameraForMoment` directly. The
// resolver does:
//   1. Pick the moment containing `t` from a list (deterministic).
//   2. Apply the same `perMoment * 0.6 + autoZoom * 0.4` blending the
//      preview and export both used inline (now in one place — the
//      fallback chain previously diverged: preview included
//      `?? m.importance`, export did not, leaking 10–20% scale on
//      legacy moments).
//   3. Call `cameraForMoment` to get the CameraState.
//
// Consumers convert the CameraState into either CSS `%` translates
// (preview) or canvas pixel translates (export) via the small adapter
// helpers below. The math lives in ONE place; the adapters are pure
// projections that can't drift from each other.
// ─────────────────────────────────────────────────────────────────────────

export interface ResolverOpts {
  /**
   * Project-level intensity floor (0..100). Mixed with the moment's own
   * intensity to give the final blended value. From `effectsSettings.autoZoom`.
   */
  autoZoom: number;
}

/**
 * Single source of truth for "what camera is active at time `t`?". Used by
 * both preview and export. Returns `IDENTITY_CAMERA` when no moment overlaps.
 */
export function resolveCameraFrame(
  moments: DetectedMoment[] | null | undefined,
  t: number,
  opts: ResolverOpts
): { camera: CameraState; moment: DetectedMoment | null } {
  if (!moments || moments.length === 0) {
    return { camera: IDENTITY_CAMERA, moment: null };
  }
  const m = pickActiveMoment(moments, t);
  if (!m) return { camera: IDENTITY_CAMERA, moment: null };
  const blended = blendIntensity(m, opts.autoZoom);
  const camera = cameraForMoment(m, blended, localProgress(m, t));
  return { camera, moment: m };
}

/**
 * Camera priority for overlap resolution: user crop/reframe > user zoom/focus
 * > AI zoom/focus. Higher wins; ties break on latest startTime.
 */
function cameraPriority(m: DetectedMoment): number {
  if (m.effectType === "crop") return m.source === "user" ? 5 : 4;
  return m.source === "user" ? 3 : 2;
}

/**
 * Deterministic moment selection for a given playhead time. SPEED moments
 * never move the camera (they only affect timing), so they're skipped here.
 * Among the rest, the highest `cameraPriority` wins (user crop > user zoom >
 * AI), ties break on the LATEST startTime ("last-authored wins"). Export and
 * preview both call this, so they always agree on which moment is active.
 */
function pickActiveMoment(
  moments: DetectedMoment[],
  t: number
): DetectedMoment | null {
  // Active cut ranges (removed time). A camera edit fully inside one is hidden
  // from preview + export, so it's never picked. A straddling edit still
  // applies on its visible part.
  const activeCuts = moments.filter(
    (m) => m.effectType === "cut" && m.cut?.active !== false
  );
  const insideActiveCut = (m: DetectedMoment): boolean =>
    activeCuts.some((c) => m.startTime >= c.startTime && m.endTime <= c.endTime);

  let pick: DetectedMoment | null = null;
  let pickPri = -1;
  for (const m of moments) {
    // Speed + Cut moments never move the camera (timing-only effects); Phase-3
    // overlays (captions/text/callout/blur/transition/branding) + smart-crop
    // (applied via the output canvas) never move the per-moment camera either.
    if (m.effectType === "speed-up" || m.effectType === "cut") continue;
    if (isOverlayEffectType(m.effectType)) continue;
    if (insideActiveCut(m)) continue;
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
 * Blend the moment's per-moment intensity with the project's autoZoom
 * floor. Single, canonical formula — preview and export previously
 * inlined this with slightly different fallback chains (export was
 * missing `?? m.importance`, leaking zoom on legacy moments).
 */
export function blendIntensity(
  m: DetectedMoment,
  autoZoomPct: number
): number {
  const perMoment =
    m.intensity ??
    m.recommendedIntensity ??
    m.attentionScore ??
    m.importance ??
    0.5;
  return perMoment * 0.6 + clamp01(autoZoomPct / 100) * 0.4;
}

/**
 * Convert a CameraState into the canvas pixel translates required by the
 * export's `ctx.translate(canvasW/2,...); ctx.scale(s,s); ctx.translate(tx,ty)`
 * chain. The previous export used `(panXPct/100) * canvasW`, which is only
 * correct when the source aspect matches the canvas aspect — for vertical
 * exports of a 16:9 recording, drawW differs from canvasW by a factor of
 * ~3.16 and the focal point ended up off-canvas. Using `drawW`/`drawH`
 * (the post-cover dimensions) places the focal point at the canvas centre
 * regardless of source/canvas aspect mismatch.
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
 * Capture both the preview-style and export-style camera values for a
 * single timestamp. Used by the dev-only "Camera diagnostics" toggle in
 * the editor — log this for a few timestamps and the two columns must be
 * identical. If they're not, the bug is real and reproducible from one
 * moment's data alone.
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
