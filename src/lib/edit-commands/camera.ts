/**
 * Camera moves as data — the bridge between what the AI (or a chat revision)
 * asks for in viewer terms and the keyframes the existing camera resolver
 * already animates (src/lib/timeline/camera.ts).
 *
 * Viewer terms: a sequence of beats, each "at `at` seconds into the move, look
 * at (x, y) at `zoom`× with this easing". Resolver terms: `MomentKeyframe`s
 * with `t` 0..1 across the moment and `scale` as a 0..1 INTENSITY mapped into
 * the camera preset's scale range. This module converts, picks the preset
 * that can reach the strongest zoom asked for, sizes the focus box so the
 * subject-fit cap doesn't flatten the move, and expresses revisions
 * ("slower push-in", "hold on the price") as pure keyframe transforms.
 *
 * Pure — tested in tests/camera-moves.test.ts.
 */

import type { DetectedMoment, EaseKind, MomentKeyframe } from "@/lib/firebase/schema";
import { ZOOM_PRESETS, MAX_ZOOM_SCALE, type ZoomPresetId } from "@/lib/timeline/zoom-presets";

export interface CameraBeat {
  /** Seconds after the move starts. */
  at: number;
  /** Focal centre, 0..1 of the frame. */
  x: number;
  y: number;
  /** Zoom factor the viewer sees, 1.0 (full frame) … MAX_ZOOM_SCALE. */
  zoom: number;
  /** Easing INTO this beat from the previous one. Default ease-in-out. */
  ease?: EaseKind;
}

/** A push-in needs time to arrive AND be seen; shorter reads as a flash. */
export const MIN_MOVE_SECONDS = 2;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The weakest preset whose range still reaches `maxZoom` (gentler ramps when it can). */
export function presetForZoom(maxZoom: number): ZoomPresetId {
  if (maxZoom <= ZOOM_PRESETS.subtle.maxScale) return "subtle";
  if (maxZoom <= ZOOM_PRESETS.standard.maxScale) return "standard";
  return "emphasis";
}

/** Zoom factor → the preset's 0..1 intensity (inverse of targetScaleFor's window). */
export function intensityForZoom(zoom: number, preset: ZoomPresetId): number {
  const p = ZOOM_PRESETS[preset];
  const z = clamp(zoom, 1, Math.min(p.maxScale, MAX_ZOOM_SCALE));
  if (z <= p.minScale) return 0;
  return clamp((z - p.minScale) / (p.maxScale - p.minScale), 0, 1);
}

/** Intensity → zoom factor for a preset (what the viewer will see, before the subject-fit cap). */
export function zoomForIntensity(intensity: number, preset: ZoomPresetId): number {
  const p = ZOOM_PRESETS[preset];
  return r3(p.minScale + (p.maxScale - p.minScale) * clamp(intensity, 0, 1));
}

/**
 * A square focus box whose subject-fit cap allows `maxZoom`: the resolver caps
 * scale at 1/(side + 2·padding), so side = 1/maxZoom − 2·padding − margin.
 * Centred on the first beat (the box centre is unused once keyframes exist,
 * but keeping it near the subject helps hand-editing and tests read right).
 */
export function focusBoxFor(maxZoom: number, cx: number, cy: number, preset: ZoomPresetId): DetectedMoment["focusRegion"] {
  const pad = ZOOM_PRESETS[preset].safePadding;
  const side = clamp(1 / Math.max(1.01, maxZoom) - 2 * pad - 0.02, 0.12, 0.6);
  return { x: r3(clamp(cx - side / 2, 0, 1 - side)), y: r3(clamp(cy - side / 2, 0, 1 - side)), width: r3(side), height: r3(side) };
}

export interface ComposedMove {
  keyframes: MomentKeyframe[];
  preset: ZoomPresetId;
  focusRegion: DetectedMoment["focusRegion"];
  /** The beats after normalization — for the chat summary. */
  durationS: number;
  maxZoom: number;
}

/**
 * Beats → keyframes over a move of `durationS` seconds. Beats are sorted,
 * clamped into the move, and the last beat is held to the end (the resolver
 * holds the last keyframe, then eases back out on its own).
 */
export function composeMove(beats: readonly CameraBeat[], durationS: number): ComposedMove | { error: string } {
  if (!beats.length) return { error: "A camera move needs at least one beat." };
  if (!(durationS >= MIN_MOVE_SECONDS)) return { error: `A camera move needs at least ${MIN_MOVE_SECONDS}s.` };
  const sorted = [...beats]
    .map((b) => ({ ...b, at: clamp(b.at, 0, durationS), zoom: clamp(b.zoom, 1, MAX_ZOOM_SCALE), x: clamp(b.x, 0, 1), y: clamp(b.y, 0, 1) }))
    .sort((a, b) => a.at - b.at);
  const maxZoom = Math.max(...sorted.map((b) => b.zoom));
  if (maxZoom < 1.03) return { error: "Every beat is at 1× — that isn't a camera move." };
  const preset = presetForZoom(maxZoom);
  const keyframes: MomentKeyframe[] = sorted.map((b) => ({
    t: r3(b.at / durationS),
    x: r3(b.x),
    y: r3(b.y),
    scale: r3(intensityForZoom(b.zoom, preset)),
    ease: b.ease ?? "ease-in-out",
  }));
  // Two beats at the same t are a hold expressed oddly — keep the later one.
  const dedup = keyframes.filter((k, i) => i === keyframes.length - 1 || keyframes[i + 1].t - k.t > 1e-6);
  const first = sorted[0];
  return { keyframes: dedup, preset, focusRegion: focusBoxFor(maxZoom, first.x, first.y, preset), durationS, maxZoom };
}

/** Keyframes → viewer beats (for the model's get_timeline and chat summaries). */
export function beatsFromKeyframes(m: Pick<DetectedMoment, "keyframes" | "startTime" | "endTime" | "cameraMotion">): CameraBeat[] {
  const dur = m.endTime - m.startTime;
  const preset = m.cameraMotion?.preset ?? "standard";
  return (m.keyframes ?? []).map((k) => ({ at: r3(k.t * dur), x: k.x, y: k.y, zoom: zoomForIntensity(k.scale, preset), ease: k.ease }));
}

/**
 * "Make the push-in slower": the camera takes longer to arrive. Stretches the
 * time between the first beat and the one it moves to by `factor`, pushing
 * later beats back (holds shrink, never below 0.15 of the move), and slows the
 * ramp (cameraMotion.speed −25).
 */
export function slowerMove(m: DetectedMoment, factor = 1.5, speedDelta = -25): Partial<DetectedMoment> {
  const speed = clamp((m.cameraMotion?.speed ?? 50) + speedDelta, 0, 100);
  const kf = m.keyframes ?? [];
  if (kf.length < 2) return { cameraMotion: { ...(m.cameraMotion ?? {}), speed } };
  const sorted = [...kf].sort((a, b) => a.t - b.t);
  const arrive = sorted[1].t - sorted[0].t;
  const stretched = Math.min(arrive * factor, 1 - 0.15 * (sorted.length - 1));
  const shift = stretched - arrive;
  const next = sorted.map((k, i) => (i === 0 ? k : { ...k, t: r3(clamp(k.t + shift, 0, 1)) }));
  // Keep order strictly increasing after the shift.
  for (let i = 1; i < next.length; i++) if (next[i].t <= next[i - 1].t) next[i] = { ...next[i], t: r3(Math.min(1, next[i - 1].t + 0.01)) };
  return { keyframes: next, cameraMotion: { ...(m.cameraMotion ?? {}), speed } };
}

/**
 * "Keep the price visible" / "hold on it longer": extend the move by
 * `holdSeconds`, keeping every beat at its ABSOLUTE time and holding the last
 * pose through the new end. Returns the new endTime + re-normalized keyframes.
 */
export function holdLonger(m: DetectedMoment, holdSeconds: number, sourceDuration: number): Partial<DetectedMoment> | null {
  const dur = m.endTime - m.startTime;
  const newEnd = Math.min(sourceDuration, m.endTime + holdSeconds);
  const newDur = newEnd - m.startTime;
  if (newDur - dur < 0.1) return null;
  const kf = [...(m.keyframes ?? [])].sort((a, b) => a.t - b.t);
  const next = kf.map((k) => ({ ...k, t: r3((k.t * dur) / newDur) }));
  const last = next[next.length - 1];
  if (last && last.t < 0.999) next.push({ ...last, t: 1, ease: "linear" });
  return { endTime: r3(newEnd), ...(next.length ? { keyframes: next } : {}) };
}

/**
 * Will an element of this on-frame size read at this zoom? Text needs about
 * 3% of frame height after magnification to be legible on a phone; a subject
 * (dish) should fill at least a fifth of the frame to feel like a close-up.
 */
export function framingCheck(el: { w: number; h: number }, zoom: number): { onScreenW: number; onScreenH: number; readable: boolean; fillsFrame: boolean } {
  const onScreenW = r3(el.w * zoom);
  const onScreenH = r3(el.h * zoom);
  return { onScreenW, onScreenH, readable: onScreenH >= 0.03, fillsFrame: onScreenW >= 0.2 || onScreenH >= 0.2 };
}

/**
 * How the resolver will actually frame a focal centre at `zoom`: the visible
 * window is 1/zoom wide, so a centre nearer the edge than half a window is
 * pulled toward the middle. A subject at x=0.11 is therefore only CENTRED at
 * ~4.5× (never, under the 1.75 cap) — but it stays VISIBLE at any zoom,
 * sitting at the window's edge. `offsetX/Y` is how far (0..1 of the frame)
 * the subject ends up from the centre of the shot.
 */
export function framingAt(el: { cx: number; cy: number; w?: number; h?: number }, zoom: number): {
  clampedCx: number;
  clampedCy: number;
  centred: boolean;
  visible: boolean;
  offsetX: number;
  offsetY: number;
  /** Zoom needed to centre this point exactly (may exceed the 1.75 cap ⇒ "never"). */
  zoomToCentre: number;
} {
  const z = clamp(zoom, 1, MAX_ZOOM_SCALE);
  const half = 1 / (2 * z);
  const cx = clamp(el.cx, half, 1 - half);
  const cy = clamp(el.cy, half, 1 - half);
  const w = el.w ?? 0;
  const h = el.h ?? 0;
  const visible = el.cx - w / 2 >= cx - half - 1e-6 && el.cx + w / 2 <= cx + half + 1e-6 && el.cy - h / 2 >= cy - half - 1e-6 && el.cy + h / 2 <= cy + half + 1e-6;
  const edge = Math.min(el.cx, 1 - el.cx, el.cy, 1 - el.cy);
  return {
    clampedCx: r3(cx),
    clampedCy: r3(cy),
    centred: Math.abs(cx - el.cx) < 1e-3 && Math.abs(cy - el.cy) < 1e-3,
    visible,
    offsetX: r3((el.cx - cx) * z),
    offsetY: r3((el.cy - cy) * z),
    zoomToCentre: edge <= 0 ? Infinity : r3(1 / (2 * edge)),
  };
}
