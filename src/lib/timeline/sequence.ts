/**
 * The SEQUENCE — Framevo's multi-source timeline.
 *
 * Until now a project was ONE uploaded video with ranges removed (cuts) and
 * constant speed sections, all stored in source seconds. A sequence is the
 * general form: an ordered list of items, each a span of some asset (or a
 * frozen frame of one) played at a constant or ramping rate, with its own
 * opacity fades, an optional transition into it, and its own audio settings;
 * plus independent audio tracks (music, narration) laid out in sequence time.
 *
 * Three time bases, kept explicit everywhere:
 *   SOURCE time   — seconds into an ASSET (what a clip's in/out and every
 *                   footage-anchored edit — captions, zooms — are stored in).
 *   SEQUENCE time — seconds into the OUTPUT (what the viewer experiences).
 *   LOCAL time    — seconds since an item or effect started.
 *
 * Legacy projects have no `sequence`: {@link sequenceFromMoments} derives the
 * identical single-asset sequence from their cut/speed moments, so the one
 * evaluator (evaluate.ts) serves old and new projects alike, and a parity test
 * pins it to `buildTimelineMap`.
 */

import type { DetectedMoment } from "@/lib/firebase/schema";
import { buildTimelineMap } from "./crop-speed";
import { toTicks, fromTicks, type Ticks } from "./ticks";

/** The project's original upload — every legacy moment and clip refers to it. */
export const SOURCE_ASSET_ID = "source";

export interface ProjectAsset {
  id: string;
  kind: "video" | "audio" | "image";
  title?: string;
  /** Playable URL (download URL, or a framevo:// local media URL on desktop). */
  url: string;
  storagePath?: string;
  mimeType?: string;
  duration: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  /** True when the container has no constant frame rate — sample by presentation time, never by frame index. */
  variableFrameRate?: boolean;
}

/**
 * Playback rate over source time. `rate` = source seconds per output second
 * (2 = twice as fast, 0.5 = half speed / slow motion). Between keyframes the
 * rate interpolates LINEARLY in source time (so a ramp from 1× to 0.25× eases
 * continuously, and output time is the exact integral — see curve math in
 * evaluate.ts). Before the first / after the last keyframe the rate holds.
 * One keyframe = constant speed.
 */
export interface SpeedCurve {
  keyframes: { at: number; rate: number }[];
}

export const MIN_RATE = 0.1;
export const MAX_RATE = 16;

export interface GainKeyframe {
  /** Seconds since the item's output start (local time). */
  at: number;
  /** Linear gain (1 = unity). */
  gain: number;
}

export interface ClipAudio {
  /**
   * Linked (default): the clip's own audio plays with its picture, following
   * its speed and trims. Unlinked: picture only — the audio was detached to an
   * independent track or dropped.
   */
  linked?: boolean;
  /** Picture-only replacement keeps the ORIGINAL audio: it comes from this asset at this in point. */
  assetId?: string;
  sourceIn?: number;
  muted?: boolean;
  /** Linear gain, 1 = unity. */
  gain?: number;
  /** Seconds (local output time). */
  fadeIn?: number;
  fadeOut?: number;
  keyframes?: GainKeyframe[];
  /** How speed changes affect sound: pitch follows the rate, or tempo-only. */
  pitch?: "follow" | "preserve";
}

export interface ClipOpacity {
  /** Seconds (local output time) over which the picture fades from/to transparent. */
  fadeIn?: number;
  fadeOut?: number;
}

export interface Transition {
  kind: "dissolve" | "dip";
  /** Seconds of output time. Centred on the cut: each side contributes duration/2 of handle media. */
  duration: number;
  /** Dip colour ("#000000" default). */
  color?: string;
  /** Audio under the transition: crossfade both sides (default), or cut with the picture. */
  audio?: "crossfade" | "cut";
}

export interface SequenceClip {
  id: string;
  kind: "clip";
  assetId: string;
  /** Source seconds, half-open [sourceIn, sourceOut). */
  sourceIn: number;
  sourceOut: number;
  speed?: SpeedCurve;
  opacity?: ClipOpacity;
  /** The transition INTO this item (overlapping the previous item's tail). */
  transitionIn?: Transition;
  audio?: ClipAudio;
  label?: string;
}

export interface SequenceFreeze {
  id: string;
  kind: "freeze";
  assetId: string;
  /** The exact source frame held, in source seconds. */
  sourceAt: number;
  /** Fixed hold, output seconds — or, when `linkedTo` is set, derived from that dependency. */
  duration?: number;
  /** Hold for as long as an animation (a moment) or another item lasts. */
  linkedTo?: { momentId: string } | { itemId: string };
  opacity?: ClipOpacity;
  transitionIn?: Transition;
  /** Linked audio during a hold: silence (default) or keep playing the asset from `sourceAt`. */
  audio?: "silent" | "continue";
  gain?: number;
  label?: string;
}

export type SequenceItem = SequenceClip | SequenceFreeze;

export interface AudioTrackItem {
  id: string;
  assetId: string;
  /** Sequence seconds. */
  outputStart: number;
  /** Source seconds, half-open. */
  sourceIn: number;
  sourceOut: number;
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
  keyframes?: GainKeyframe[];
  muted?: boolean;
  /** Lower this track under speech (transcript words of linked dialogue). */
  duck?: { amount: number; attack?: number; release?: number };
  label?: string;
}

export interface Sequence {
  version: 1;
  items: SequenceItem[];
  audioTracks?: AudioTrackItem[];
}

// ── speed curve math ────────────────────────────────────────────────────────

const clampRate = (r: number) => Math.min(MAX_RATE, Math.max(MIN_RATE, Number.isFinite(r) ? r : 1));

/** Normalized keyframes: sorted, deduped, clamped; `[{at:-Inf.., rate:1}]` when absent. */
export function speedKeyframes(curve: SpeedCurve | undefined): { at: number; rate: number }[] {
  const ks = (curve?.keyframes ?? [])
    .filter((k) => Number.isFinite(k.at) && Number.isFinite(k.rate))
    .map((k) => ({ at: k.at, rate: clampRate(k.rate) }))
    .sort((a, b) => a.at - b.at);
  const out: { at: number; rate: number }[] = [];
  for (const k of ks) {
    if (out.length && Math.abs(out[out.length - 1].at - k.at) < 1e-9) out[out.length - 1] = k;
    else out.push(k);
  }
  return out.length ? out : [{ at: 0, rate: 1 }];
}

/** Rate at source time `s` (rate holds outside the keyframe range). */
export function rateAt(curve: SpeedCurve | undefined, s: number): number {
  const ks = speedKeyframes(curve);
  if (s <= ks[0].at) return ks[0].rate;
  for (let i = 1; i < ks.length; i++) {
    if (s <= ks[i].at) {
      const a = ks[i - 1];
      const b = ks[i];
      const f = (s - a.at) / (b.at - a.at || 1);
      return a.rate + (b.rate - a.rate) * f;
    }
  }
  return ks[ks.length - 1].rate;
}

/**
 * Output seconds consumed by the source span [a, b] under the curve. With the
 * rate linear in source time, ∫ ds / r(s) has the closed form
 * (b−a)/(rb−ra)·ln(rb/ra); constant rate degenerates to (b−a)/r.
 */
export function outputSecondsFor(curve: SpeedCurve | undefined, a: number, b: number): number {
  if (b <= a) return 0;
  const ks = speedKeyframes(curve);
  // Breakpoints inside [a, b].
  const pts = [a, ...ks.map((k) => k.at).filter((x) => x > a && x < b), b];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const s0 = pts[i - 1];
    const s1 = pts[i];
    const r0 = rateAt(curve, s0);
    const r1 = rateAt(curve, s1);
    total += Math.abs(r1 - r0) < 1e-9 ? (s1 - s0) / r0 : ((s1 - s0) / (r1 - r0)) * Math.log(r1 / r0);
  }
  return total;
}

/**
 * Inverse: the source time reached after `o` output seconds from source `a`.
 * Within a linear-rate span, r(s) = ra·exp(o·(rb−ra)/(b−a)), then s follows
 * from the line. Clamped to `b`.
 */
export function sourceAfterOutput(curve: SpeedCurve | undefined, a: number, b: number, o: number): number {
  if (o <= 0) return a;
  const ks = speedKeyframes(curve);
  const pts = [a, ...ks.map((k) => k.at).filter((x) => x > a && x < b), b];
  let remaining = o;
  for (let i = 1; i < pts.length; i++) {
    const s0 = pts[i - 1];
    const s1 = pts[i];
    const r0 = rateAt(curve, s0);
    const r1 = rateAt(curve, s1);
    const span = Math.abs(r1 - r0) < 1e-9 ? (s1 - s0) / r0 : ((s1 - s0) / (r1 - r0)) * Math.log(r1 / r0);
    if (remaining < span - 1e-12) {
      if (Math.abs(r1 - r0) < 1e-9) return s0 + remaining * r0;
      const k = (r1 - r0) / (s1 - s0);
      const r = r0 * Math.exp(remaining * k);
      return s0 + (r - r0) / k;
    }
    remaining -= span;
  }
  return b;
}

// ── layout ──────────────────────────────────────────────────────────────────

/** The hold of a freeze, resolving `linkedTo` through the caller's resolver. */
export type HoldResolver = (f: SequenceFreeze) => number;

export interface LaidOutItem {
  item: SequenceItem;
  index: number;
  /**
   * The nominal boundary between this item and the previous one, in sequence
   * ticks. The item's OWN media occupies [cut, cut + durationTicks).
   */
  cut: Ticks;
  durationTicks: Ticks;
  /**
   * Visible span, half-open sequence ticks: the own media plus any transition
   * overlap at the head ([cut − T/2, cut)) and at the tail (the next item's
   * transition, [nextCut, nextCut + T'/2)).
   */
  start: Ticks;
  end: Ticks;
  /** The transition INTO this item, centred on `cut`: [cut − ticks/2, cut + ticks/2). */
  transition?: { kind: Transition["kind"]; color: string; audio: "crossfade" | "cut"; ticks: Ticks };
}

export interface SequenceLayout {
  items: LaidOutItem[];
  outputTicks: Ticks;
  outputDuration: number;
}

export const DEFAULT_FREEZE_SECONDS = 2;

/** Output seconds of an item's own media (handles excluded). */
export function itemOutputSeconds(item: SequenceItem, hold: HoldResolver): number {
  if (item.kind === "freeze") return Math.max(0, hold(item));
  return outputSecondsFor(item.speed, item.sourceIn, item.sourceOut);
}

/**
 * Lay the items out in sequence time. Items abut at their cuts; the output
 * length is the sum of their own media. A transition of duration d is centred
 * on its cut, so each side shows d/2 beyond its in/out point — HANDLE media
 * the executor checks for first ({@link transitionFeasibility}).
 */
export function layoutSequence(seq: Sequence, hold: HoldResolver): SequenceLayout {
  const items: LaidOutItem[] = [];
  let cut: Ticks = 0;
  seq.items.forEach((item, index) => {
    const t = item.transitionIn;
    const ticks = t && t.duration > 0 && index > 0 ? toTicks(t.duration) : 0;
    const durationTicks = toTicks(itemOutputSeconds(item, hold));
    items.push({
      item,
      index,
      cut,
      durationTicks,
      start: Math.max(0, cut - Math.floor(ticks / 2)),
      end: cut + durationTicks, // extended below by the next item's transition
      ...(ticks ? { transition: { kind: t!.kind, color: t!.color ?? "#000000", audio: t!.audio ?? "crossfade", ticks } } : {}),
    });
    cut += durationTicks;
  });
  for (let i = 0; i + 1 < items.length; i++) {
    const next = items[i + 1];
    if (next.transition) items[i].end = next.cut + Math.ceil(next.transition.ticks / 2);
  }
  const outputTicks = cut;
  if (items.length) items[items.length - 1].end = Math.min(items[items.length - 1].end, outputTicks);
  return { items, outputTicks, outputDuration: fromTicks(outputTicks) };
}

/**
 * Source time of an item at sequence tick τ. Inside the own media it follows
 * the speed curve from the in point; in a head overlap (τ < cut) or a tail
 * handle (past the own media) it extends linearly at the edge rate, which is
 * what the handle media plays.
 */
export function itemSourceTimeAt(l: LaidOutItem, tau: Ticks): number {
  const item = l.item;
  if (item.kind === "freeze") return item.sourceAt;
  const local = fromTicks(tau - l.cut);
  if (local < 0) return item.sourceIn + local * rateAt(item.speed, item.sourceIn);
  const own = fromTicks(l.durationTicks);
  if (local <= own) return sourceAfterOutput(item.speed, item.sourceIn, item.sourceOut, local);
  return item.sourceOut + (local - own) * rateAt(item.speed, item.sourceOut);
}

// ── legacy bridge ───────────────────────────────────────────────────────────

/**
 * The single-asset sequence equivalent to a legacy project's cut/speed
 * moments: one clip per timeline-map segment, so the evaluator reproduces
 * `sourceTimeForOutput` exactly (pinned by tests/sequence-evaluate.test.ts).
 * Speed sections carry their audio mode: "mute" → muted; "pitch-correct" →
 * preserve; "keep" → follow.
 */
export function sequenceFromMoments(moments: readonly DetectedMoment[], sourceDuration: number): Sequence {
  const map = buildTimelineMap(moments as DetectedMoment[], sourceDuration);
  const speeds = (moments ?? []).filter((m) => m.effectType === "speed-up" && m.enabled !== false && m.speed);
  const items: SequenceItem[] = map.segments.map((s, i) => {
    const mid = (s.sourceStart + s.sourceEnd) / 2;
    const section = speeds.filter((m) => mid >= m.startTime && mid < m.endTime).sort((a, b) => b.startTime - a.startTime)[0];
    const mode = section?.speed?.audioMode;
    const clip: SequenceClip = {
      id: `seg_${i}`,
      kind: "clip",
      assetId: SOURCE_ASSET_ID,
      sourceIn: s.sourceStart,
      sourceOut: s.sourceEnd,
      ...(s.speedMultiplier !== 1 ? { speed: { keyframes: [{ at: s.sourceStart, rate: s.speedMultiplier }] } } : {}),
      ...(section ? { audio: { ...(mode === "mute" ? { muted: true } : {}), pitch: mode === "pitch-correct" ? "preserve" : "follow" } } : {}),
    };
    return clip;
  });
  return { version: 1, items };
}

/** True when the project has an authored sequence (vs. the derived legacy one). */
export function hasSequence(seq: Sequence | undefined | null): seq is Sequence {
  return !!seq && Array.isArray(seq.items);
}

// ── small helpers shared by the executor and the UI ─────────────────────────

export function newItemId(prefix = "it"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Asset duration lookup with the legacy source. */
export function assetDuration(assets: readonly ProjectAsset[] | undefined, assetId: string, sourceDuration: number): number {
  if (assetId === SOURCE_ASSET_ID) return sourceDuration;
  return assets?.find((a) => a.id === assetId)?.duration ?? 0;
}

/**
 * Can a transition of `duration` seconds be placed INTO item `index`? Each side
 * needs duration/2 of handle media beyond its in/out point (a freeze has
 * unlimited handles). Returns the maximum feasible duration so the executor
 * can report "only 0.6s of media after the cut" before applying anything.
 */
export function transitionFeasibility(
  seq: Sequence,
  index: number,
  duration: number,
  assets: readonly ProjectAsset[] | undefined,
  sourceDuration: number
): { ok: boolean; maxDuration: number; outgoingHandle: number; incomingHandle: number; reason?: string } {
  const item = seq.items[index];
  const prev = seq.items[index - 1];
  if (!item || !prev) return { ok: false, maxDuration: 0, outgoingHandle: 0, incomingHandle: 0, reason: "A transition needs a shot before it." };
  const outHandle =
    prev.kind === "freeze"
      ? Infinity
      : Math.max(0, assetDuration(assets, prev.assetId, sourceDuration) - prev.sourceOut) / rateAt(prev.speed, prev.sourceOut);
  const inHandle = item.kind === "freeze" ? Infinity : Math.max(0, item.sourceIn) / rateAt(item.speed, item.sourceIn);
  const maxDuration = Math.min(outHandle, inHandle) * 2;
  const ok = duration <= maxDuration + 1e-9;
  return {
    ok,
    maxDuration: Number.isFinite(maxDuration) ? Math.floor(maxDuration * 100) / 100 : duration,
    outgoingHandle: Number.isFinite(outHandle) ? outHandle : duration,
    incomingHandle: Number.isFinite(inHandle) ? inHandle : duration,
    ...(ok
      ? {}
      : {
          reason:
            outHandle < inHandle
              ? `Only ${outHandle.toFixed(2)}s of media after the outgoing shot's out point — a ${duration}s transition needs ${(duration / 2).toFixed(2)}s on each side (max ${(maxDuration).toFixed(2)}s).`
              : `Only ${inHandle.toFixed(2)}s of media before the incoming shot's in point — a ${duration}s transition needs ${(duration / 2).toFixed(2)}s on each side (max ${(maxDuration).toFixed(2)}s).`,
        }),
  };
}
