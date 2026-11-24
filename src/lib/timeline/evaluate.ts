/**
 * `evaluateTimeline(revision, outputTime)` — the ONE timing contract.
 *
 * Given a saved revision (sequence + moments + assets) and a sequence time, it
 * resolves what is on screen and what is audible at that instant:
 *   - the active layer(s): which asset, at which SOURCE time, at what opacity
 *     (two layers during a dissolve/dip, bottom → top);
 *   - the transition in progress and the plate colour behind a dip;
 *   - every active overlay/effect moment with its LOCAL time, whatever it is
 *     anchored to (the footage, the sequence, or an item);
 *   - the camera context (source-anchored camera moments of the top layer);
 *   - every audio stem: asset, source time, rate, pitch policy and gain.
 *
 * Preview and every exporter call this (or the plans derived from it below)
 * so a freeze, a ramp or a crossfade means exactly the same thing everywhere.
 * Integer ticks internally; half-open intervals; the LATER item owns an exact
 * cut tick — the same rule `buildTimelineMap` applies to legacy cuts.
 */

import type { DetectedMoment } from "@/lib/firebase/schema";
import {
  DEFAULT_FREEZE_SECONDS,
  SOURCE_ASSET_ID,
  itemOutputSeconds,
  itemSourceTimeAt,
  layoutSequence,
  rateAt,
  sequenceFromMoments,
  speedKeyframes,
  type LaidOutItem,
  type ProjectAsset,
  type Sequence,
  type SequenceFreeze,
  type SequenceItem,
  type SequenceLayout,
} from "./sequence";
import { fromTicks, toTicks, type Ticks } from "./ticks";

/** Where a moment's start/end times live. Absent = source-anchored to the original upload (every legacy moment). */
export type MomentAnchor =
  | { kind: "source"; assetId?: string }
  | { kind: "sequence" }
  | { kind: "item"; itemId: string };

export interface TimelineRevision {
  /** Authored sequence; absent on legacy projects (derived from cut/speed moments). */
  sequence?: Sequence | null;
  moments: DetectedMoment[];
  assets?: ProjectAsset[];
  /** Duration of the original upload (asset "source"). */
  sourceDuration: number;
  /** Spoken windows of the ORIGINAL asset, source seconds — ducking lowers music under them. */
  speech?: { start: number; end: number }[];
  /** Monotonic edit counter of the project (see persistence). */
  rev?: number;
}

export class TimelineError extends Error {
  readonly code: "circular_dependency" | "missing_item" | "missing_asset";
  constructor(message: string, code: "circular_dependency" | "missing_item" | "missing_asset") {
    super(message);
    this.code = code;
  }
}

export interface EvalLayer {
  itemId: string;
  index: number;
  assetId: string;
  kind: SequenceItem["kind"];
  /** Source seconds of the frame to show. */
  sourceTime: number;
  /** 0..1 after fades and the transition. */
  opacity: number;
  /** Seconds since the item's cut (negative inside a head overlap). */
  localTime: number;
  /** True when the picture is held (source time does not advance). */
  frozen: boolean;
}

export interface EvalOverlay {
  moment: DetectedMoment;
  /** Seconds since the moment started, in its own base. */
  localTime: number;
  /**
   * The time to hand the legacy drawers: they animate from `t - m.startTime`,
   * so `virtualTime = m.startTime + localTime` makes a sequence- or item-anchored
   * moment animate correctly through a renderer that only knows one `t`.
   */
  virtualTime: number;
}

export interface EvalAudioStem {
  /** "item:<id>" or "track:<id>". */
  id: string;
  assetId: string;
  sourceTime: number;
  /** Source seconds per output second at this instant. */
  rate: number;
  pitch: "follow" | "preserve";
  /** Linear gain after fades, keyframes, crossfades, ducking and mutes. */
  gain: number;
}

export interface FrameEval {
  outputTime: number;
  outputTicks: Ticks;
  outputDuration: number;
  /** Bottom → top. Empty past the end. */
  layers: EvalLayer[];
  /** The layer overlays and the camera follow (the most opaque). */
  dominant: EvalLayer | null;
  plateColor: string | null;
  transition: { kind: "dissolve" | "dip"; progress: number; fromItemId: string; toItemId: string } | null;
  overlays: EvalOverlay[];
  camera: { assetId: string; sourceTime: number; moments: DetectedMoment[] } | null;
  audio: EvalAudioStem[];
}

// ── resolution ──────────────────────────────────────────────────────────────

export function resolveSequence(rev: TimelineRevision): Sequence {
  return rev.sequence && Array.isArray(rev.sequence.items) ? rev.sequence : sequenceFromMoments(rev.moments, rev.sourceDuration);
}

export function anchorOf(m: DetectedMoment): MomentAnchor {
  const a = (m as { anchor?: MomentAnchor }).anchor;
  return a ?? { kind: "source" };
}

function momentAsset(m: DetectedMoment): string {
  const a = anchorOf(m);
  return a.kind === "source" ? a.assetId ?? (m as { assetId?: string }).assetId ?? SOURCE_ASSET_ID : SOURCE_ASSET_ID;
}

/**
 * The hold of each freeze, with `linkedTo` resolved. A hold linked to a moment
 * is that moment's duration; linked to another item, that item's output
 * length. Chains are followed; a cycle is a TimelineError, never a hang.
 */
export function resolveHolds(seq: Sequence, moments: readonly DetectedMoment[]): Map<string, number> {
  const byId = new Map(seq.items.map((i) => [i.id, i]));
  const out = new Map<string, number>();
  const visiting = new Set<string>();
  const holdOf = (f: SequenceFreeze): number => {
    const hit = out.get(f.id);
    if (hit != null) return hit;
    if (visiting.has(f.id)) throw new TimelineError(`Freeze "${f.id}" depends on itself through its linked duration.`, "circular_dependency");
    visiting.add(f.id);
    let d: number;
    if (!f.linkedTo) d = f.duration ?? DEFAULT_FREEZE_SECONDS;
    else if ("momentId" in f.linkedTo) {
      const wanted = f.linkedTo.momentId;
      const m = moments.find((x) => x.id === wanted);
      d = m ? Math.max(0, m.endTime - m.startTime) : f.duration ?? DEFAULT_FREEZE_SECONDS;
    } else {
      const target = byId.get(f.linkedTo.itemId);
      if (!target) throw new TimelineError(`Freeze "${f.id}" is linked to a missing item.`, "missing_item");
      d = target.kind === "freeze" ? holdOf(target) : itemOutputSeconds(target, holdOf);
    }
    visiting.delete(f.id);
    out.set(f.id, d);
    return d;
  };
  for (const i of seq.items) if (i.kind === "freeze") holdOf(i);
  return out;
}

export function layoutOf(rev: TimelineRevision): SequenceLayout {
  const seq = resolveSequence(rev);
  const holds = resolveHolds(seq, rev.moments);
  return layoutSequence(seq, (f) => holds.get(f.id) ?? DEFAULT_FREEZE_SECONDS);
}

export function outputDurationOf(rev: TimelineRevision): number {
  return layoutOf(rev).outputDuration;
}

// ── gain envelopes ──────────────────────────────────────────────────────────

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function fadeGain(local: number, duration: number, fadeIn = 0, fadeOut = 0): number {
  let g = 1;
  if (fadeIn > 0) g *= clamp01(local / fadeIn);
  if (fadeOut > 0) g *= clamp01((duration - local) / fadeOut);
  return g;
}

function keyframeGain(local: number, kfs: { at: number; gain: number }[] | undefined): number {
  if (!kfs?.length) return 1;
  const ks = [...kfs].sort((a, b) => a.at - b.at);
  if (local <= ks[0].at) return ks[0].gain;
  for (let i = 1; i < ks.length; i++) {
    if (local <= ks[i].at) {
      const a = ks[i - 1];
      const b = ks[i];
      return a.gain + (b.gain - a.gain) * ((local - a.at) / (b.at - a.at || 1));
    }
  }
  return ks[ks.length - 1].gain;
}

/** Equal-power crossfade weights for progress p ∈ [0,1]: (outgoing, incoming). */
function crossfade(p: number): [number, number] {
  const q = clamp01(p) * (Math.PI / 2);
  return [Math.cos(q), Math.sin(q)];
}

/** Multiplier for a ducked track at sequence time `o`, given speech windows in sequence seconds. */
function duckGain(o: number, windows: { start: number; end: number }[], amount: number, attack: number, release: number): number {
  let depth = 0;
  for (const w of windows) {
    if (o >= w.start && o < w.end) return 1 - amount;
    if (o < w.start && w.start - o < attack) depth = Math.max(depth, 1 - (w.start - o) / attack);
    else if (o >= w.end && o - w.end < release) depth = Math.max(depth, 1 - (o - w.end) / release);
  }
  return 1 - amount * clamp01(depth);
}

/** Speech windows mapped into sequence time through the clips that play the original asset. */
export function speechWindowsInSequence(rev: TimelineRevision, layout: SequenceLayout): { start: number; end: number }[] {
  const speech = rev.speech ?? [];
  if (!speech.length) return [];
  const out: { start: number; end: number }[] = [];
  for (const l of layout.items) {
    const it = l.item;
    if (it.kind !== "clip" || it.audio?.linked === false || it.audio?.muted) continue;
    // Speech travels with the AUDIO: a picture-only replacement still carries the original's dialogue.
    const audioAsset = it.audio?.assetId ?? it.assetId;
    if (audioAsset !== SOURCE_ASSET_ID) continue;
    const audioIn = it.audio?.assetId ? (it.audio.sourceIn ?? it.sourceIn) : it.sourceIn;
    const shift = audioIn - it.sourceIn; // audio source → picture source
    for (const w of speech) {
      const a = Math.max(w.start - shift, it.sourceIn);
      const b = Math.min(w.end - shift, it.sourceOut);
      if (b <= a) continue;
      const o0 = fromTicks(l.cut) + outputSecondsBetween(it, it.sourceIn, a);
      const o1 = fromTicks(l.cut) + outputSecondsBetween(it, it.sourceIn, b);
      out.push({ start: o0, end: o1 });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

function outputSecondsBetween(item: Extract<SequenceItem, { kind: "clip" }>, a: number, b: number): number {
  // Local helper around the curve integral (avoids importing the symbol twice).
  const ks = speedKeyframes(item.speed);
  if (ks.length === 1) return (b - a) / ks[0].rate;
  let total = 0;
  const pts = [a, ...ks.map((k) => k.at).filter((x) => x > a && x < b), b];
  for (let i = 1; i < pts.length; i++) {
    const r0 = rateAt(item.speed, pts[i - 1]);
    const r1 = rateAt(item.speed, pts[i]);
    total += Math.abs(r1 - r0) < 1e-9 ? (pts[i] - pts[i - 1]) / r0 : ((pts[i] - pts[i - 1]) / (r1 - r0)) * Math.log(r1 / r0);
  }
  return total;
}

// ── the evaluator ───────────────────────────────────────────────────────────

export function evaluateTimeline(rev: TimelineRevision, outputTime: number): FrameEval {
  const layout = layoutOf(rev);
  const tau = toTicks(outputTime);
  const empty: FrameEval = { outputTime, outputTicks: tau, outputDuration: layout.outputDuration, layers: [], dominant: null, plateColor: null, transition: null, overlays: [], camera: null, audio: [] };
  if (tau < 0 || tau >= layout.outputTicks || !layout.items.length) {
    // Past the end: hold the last frame (frame-rounding at the tail), like the legacy map.
    if (tau >= layout.outputTicks && layout.items.length) return evaluateTimeline(rev, fromTicks(layout.outputTicks - 1));
    return empty;
  }

  const visible = layout.items.filter((l) => tau >= l.start && tau < l.end);
  // The item that OWNS tau (its own media), then any overlapping neighbour.
  const owner = visible.find((l) => tau >= l.cut && tau < l.cut + l.durationTicks) ?? visible[visible.length - 1];
  const others = visible.filter((l) => l !== owner);

  // Transition state: owner's head (incoming) or the next item's head (owner outgoing).
  let transition: FrameEval["transition"] = null;
  let plateColor: string | null = null;
  let incoming: LaidOutItem | null = null;
  let outgoing: LaidOutItem | null = null;
  const headOf = (l: LaidOutItem) => (l.transition ? { t0: l.cut - Math.floor(l.transition.ticks / 2), t1: l.cut + Math.ceil(l.transition.ticks / 2) } : null);
  const ownHead = headOf(owner);
  const next = layout.items[owner.index + 1];
  const nextHead = next ? headOf(next) : null;
  if (ownHead && tau >= ownHead.t0 && tau < ownHead.t1) {
    incoming = owner;
    outgoing = layout.items[owner.index - 1] ?? null;
    const p = (tau - ownHead.t0) / (ownHead.t1 - ownHead.t0);
    transition = { kind: owner.transition!.kind, progress: p, fromItemId: outgoing?.item.id ?? "", toItemId: owner.item.id };
    if (owner.transition!.kind === "dip") plateColor = owner.transition!.color;
  } else if (next && nextHead && tau >= nextHead.t0 && tau < nextHead.t1) {
    incoming = next;
    outgoing = owner;
    const p = (tau - nextHead.t0) / (nextHead.t1 - nextHead.t0);
    transition = { kind: next.transition!.kind, progress: p, fromItemId: owner.item.id, toItemId: next.item.id };
    if (next.transition!.kind === "dip") plateColor = next.transition!.color;
  }

  const layerFor = (l: LaidOutItem): EvalLayer => {
    const it = l.item;
    const local = fromTicks(tau - l.cut);
    const own = fromTicks(l.durationTicks);
    let opacity = fadeGain(local, own, it.opacity?.fadeIn, it.opacity?.fadeOut);
    if (transition) {
      const p = transition.progress;
      if (transition.kind === "dissolve") {
        if (l === incoming) opacity *= p;
      } else {
        // Dip: outgoing fades to the plate over the first half, incoming rises over the second.
        if (l === outgoing) opacity *= clamp01(1 - p * 2);
        if (l === incoming) opacity *= clamp01(p * 2 - 1);
      }
    }
    return { itemId: it.id, index: l.index, assetId: it.assetId, kind: it.kind, sourceTime: itemSourceTimeAt(l, tau), opacity, localTime: local, frozen: it.kind === "freeze" };
  };
  const ordered = [...others.filter((l) => l !== incoming), ...(outgoing && outgoing !== owner ? [] : []), owner];
  // Bottom → top: outgoing below incoming.
  const layers: EvalLayer[] = (transition && incoming && outgoing ? [outgoing, incoming] : ordered).map(layerFor);
  // Overlays and the camera follow the incoming shot from the midpoint of a
  // transition (its picture dominates from there), else the most opaque layer.
  const dominant: EvalLayer | null = transition
    ? (layers.find((l) => l.itemId === (transition!.progress >= 0.5 ? transition!.toItemId : transition!.fromItemId)) ?? layers[layers.length - 1] ?? null)
    : layers.reduce<EvalLayer | null>((best, l) => (!best || l.opacity >= best.opacity ? l : best), null);

  // Overlays.
  const overlays: EvalOverlay[] = [];
  const dominantLaid = dominant ? layout.items[dominant.index] : null;
  for (const m of rev.moments) {
    if (m.enabled === false) continue;
    const a = anchorOf(m);
    if (a.kind === "source") {
      if (!dominant || momentAsset(m) !== dominant.assetId) continue;
      const s = dominant.sourceTime;
      if (s >= m.startTime && s < m.endTime) overlays.push({ moment: m, localTime: s - m.startTime, virtualTime: s });
    } else if (a.kind === "sequence") {
      if (outputTime >= m.startTime && outputTime < m.endTime) overlays.push({ moment: m, localTime: outputTime - m.startTime, virtualTime: outputTime });
    } else {
      const l = layout.items.find((x) => x.item.id === a.itemId);
      if (!l) continue;
      const local = fromTicks(tau - l.cut);
      if (local >= m.startTime && local < m.endTime) overlays.push({ moment: m, localTime: local - m.startTime, virtualTime: m.startTime + (local - m.startTime) });
    }
  }
  void dominantLaid;

  // Camera: source-anchored camera moments of the dominant layer's asset.
  const camera = dominant
    ? {
        assetId: dominant.assetId,
        sourceTime: dominant.sourceTime,
        moments: rev.moments.filter((m) => anchorOf(m).kind === "source" && momentAsset(m) === dominant.assetId),
      }
    : null;

  // Audio.
  const audio: EvalAudioStem[] = [];
  const xf = transition && (incoming?.transition?.audio ?? "crossfade") === "crossfade" ? crossfade(transition.progress) : null;
  for (const l of visible) {
    const it = l.item;
    const local = fromTicks(tau - l.cut);
    const own = fromTicks(l.durationTicks);
    if (it.kind === "freeze") {
      if (it.audio !== "continue") continue;
      let g = it.gain ?? 1;
      if (xf) g *= l === incoming ? xf[1] : l === outgoing ? xf[0] : 1;
      audio.push({ id: `item:${it.id}`, assetId: it.assetId, sourceTime: it.sourceAt + Math.max(0, local), rate: 1, pitch: "follow", gain: g });
      continue;
    }
    const au = it.audio ?? {};
    if (au.linked === false || au.muted) continue;
    let g = (au.gain ?? 1) * fadeGain(local, own, au.fadeIn, au.fadeOut) * keyframeGain(local, au.keyframes);
    if (xf) g *= l === incoming ? xf[1] : l === outgoing ? xf[0] : 1;
    else if (transition && (l === incoming || l === outgoing)) {
      // "cut" audio under a picture transition: the incoming starts at the cut.
      if (l === incoming && tau < l.cut) continue;
      if (l === outgoing && tau >= (incoming?.cut ?? Infinity)) continue;
    }
    if (g <= 0) continue;
    const srcT = itemSourceTimeAt(l, tau);
    const audioAsset = au.assetId ?? it.assetId;
    const audioSource = au.assetId ? (au.sourceIn ?? it.sourceIn) + (srcT - it.sourceIn) : srcT;
    audio.push({ id: `item:${it.id}`, assetId: audioAsset, sourceTime: audioSource, rate: rateAt(it.speed, srcT), pitch: au.pitch ?? "follow", gain: g });
  }
  const speechWindows = speechWindowsInSequence(rev, layout);
  for (const tr of resolveSequence(rev).audioTracks ?? []) {
    if (tr.muted) continue;
    const local = outputTime - tr.outputStart;
    const len = tr.sourceOut - tr.sourceIn;
    if (local < 0 || local >= len) continue;
    let g = (tr.gain ?? 1) * fadeGain(local, len, tr.fadeIn, tr.fadeOut) * keyframeGain(local, tr.keyframes);
    if (tr.duck) g *= duckGain(outputTime, speechWindows, clamp01(tr.duck.amount), tr.duck.attack ?? 0.25, tr.duck.release ?? 0.6);
    if (g <= 0) continue;
    audio.push({ id: `track:${tr.id}`, assetId: tr.assetId, sourceTime: tr.sourceIn + local, rate: 1, pitch: "follow", gain: g });
  }

  return { outputTime, outputTicks: tau, outputDuration: layout.outputDuration, layers, dominant, plateColor, transition, overlays, camera, audio };
}

// ── plans for exporters ─────────────────────────────────────────────────────

/** A constant-rate run of one asset in sequence time — what a decoder or an <OffthreadVideo> can play. */
export interface VideoRun {
  itemId: string;
  assetId: string;
  kind: SequenceItem["kind"];
  /** Sequence seconds, half-open. */
  outputStart: number;
  outputEnd: number;
  /** Source seconds at outputStart; advances at `rate` (0 for a freeze). */
  sourceStart: number;
  rate: number;
}

/** Ramp sampling step for exporters that need constant-rate runs (seconds of output). */
export const RAMP_STEP = 0.25;

/**
 * Every item's visible span as constant-rate runs (ramps sampled every
 * RAMP_STEP, exact at keyframes). Overlapping runs occur only inside
 * transitions; layers come from {@link evaluateTimeline}.
 */
export function planVideo(rev: TimelineRevision): VideoRun[] {
  const layout = layoutOf(rev);
  const runs: VideoRun[] = [];
  for (const l of layout.items) {
    const it = l.item;
    const s0 = fromTicks(l.start);
    const s1 = fromTicks(l.end);
    if (it.kind === "freeze") {
      runs.push({ itemId: it.id, assetId: it.assetId, kind: "freeze", outputStart: s0, outputEnd: s1, sourceStart: it.sourceAt, rate: 0 });
      continue;
    }
    const ks = speedKeyframes(it.speed);
    const constant = ks.length === 1;
    const step = constant ? s1 - s0 : RAMP_STEP;
    for (let o = s0; o < s1 - 1e-9; o = Math.min(s1, o + step)) {
      const oEnd = Math.min(s1, o + step);
      const src = itemSourceTimeAt(l, toTicks(o));
      const srcEnd = itemSourceTimeAt(l, toTicks(oEnd));
      runs.push({ itemId: it.id, assetId: it.assetId, kind: "clip", outputStart: o, outputEnd: oEnd, sourceStart: src, rate: constant ? ks[0].rate : (srcEnd - src) / (oEnd - o || 1) });
      if (oEnd >= s1) break;
    }
  }
  return runs;
}

export interface AudioRun {
  stemId: string;
  assetId: string;
  outputStart: number;
  outputEnd: number;
  sourceStart: number;
  rate: number;
  pitch: "follow" | "preserve";
  /** Gain breakpoints in sequence seconds (linear between), covering [outputStart, outputEnd]. */
  gain: { at: number; gain: number }[];
}

/**
 * Audio as constant-rate runs with gain envelopes — enough for an ffmpeg
 * filter graph (atrim/atempo/volume) or Web Audio automation. Envelopes are
 * sampled at every change point plus a fine grid through fades, crossfades,
 * keyframes and ducking, so a 20 ms grid never misses a transition edge.
 */
export function planAudio(rev: TimelineRevision, grid = 0.02): AudioRun[] {
  const layout = layoutOf(rev);
  const runs: AudioRun[] = [];
  const sample = (stemId: string, o0: number, o1: number) => {
    const pts: { at: number; gain: number }[] = [];
    for (let o = o0; o < o1; o += grid) pts.push({ at: o, gain: evaluateTimeline(rev, o).audio.find((s) => s.id === stemId)?.gain ?? 0 });
    pts.push({ at: o1, gain: evaluateTimeline(rev, Math.max(o0, o1 - 1e-4)).audio.find((s) => s.id === stemId)?.gain ?? 0 });
    // Compress straight runs.
    const out: { at: number; gain: number }[] = [];
    for (const p of pts) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      if (a && b && Math.abs(b.gain - a.gain) < 1e-6 && Math.abs(p.gain - b.gain) < 1e-6) out[out.length - 1] = p;
      else out.push(p);
    }
    return out;
  };
  for (const l of layout.items) {
    const it = l.item;
    const stemId = `item:${it.id}`;
    const s0 = fromTicks(l.start);
    const s1 = fromTicks(l.end);
    if (it.kind === "freeze") {
      if (it.audio !== "continue") continue;
      runs.push({ stemId, assetId: it.assetId, outputStart: s0, outputEnd: s1, sourceStart: it.sourceAt + (s0 - fromTicks(l.cut)), rate: 1, pitch: "follow", gain: sample(stemId, s0, s1) });
      continue;
    }
    const au = it.audio ?? {};
    if (au.linked === false || au.muted) continue;
    const ks = speedKeyframes(it.speed);
    const constant = ks.length === 1;
    const step = constant ? s1 - s0 : RAMP_STEP;
    const assetId = au.assetId ?? it.assetId;
    for (let o = s0; o < s1 - 1e-9; o = Math.min(s1, o + step)) {
      const oEnd = Math.min(s1, o + step);
      const src = itemSourceTimeAt(l, toTicks(o));
      const srcEnd = itemSourceTimeAt(l, toTicks(oEnd));
      const sourceStart = au.assetId ? (au.sourceIn ?? it.sourceIn) + (src - it.sourceIn) : src;
      runs.push({ stemId, assetId, outputStart: o, outputEnd: oEnd, sourceStart, rate: constant ? ks[0].rate : (srcEnd - src) / (oEnd - o || 1), pitch: au.pitch ?? "follow", gain: sample(stemId, o, oEnd) });
      if (oEnd >= s1) break;
    }
  }
  for (const tr of resolveSequence(rev).audioTracks ?? []) {
    if (tr.muted) continue;
    const len = tr.sourceOut - tr.sourceIn;
    if (len <= 0) continue;
    const o0 = tr.outputStart;
    const o1 = Math.min(layout.outputDuration, tr.outputStart + len);
    if (o1 <= o0) continue;
    const stemId = `track:${tr.id}`;
    runs.push({ stemId, assetId: tr.assetId, outputStart: o0, outputEnd: o1, sourceStart: tr.sourceIn, rate: 1, pitch: "follow", gain: sample(stemId, o0, o1) });
  }
  return runs;
}

// ── time conversions for the UI ─────────────────────────────────────────────

/** First sequence time at which `sourceTime` of `assetId` is on screen, or null when it was cut. */
export function outputTimeForSource(rev: TimelineRevision, assetId: string, sourceTime: number): number | null {
  const layout = layoutOf(rev);
  for (const l of layout.items) {
    const it = l.item;
    if (it.kind !== "clip" || it.assetId !== assetId) continue;
    if (sourceTime >= it.sourceIn && sourceTime < it.sourceOut) return fromTicks(l.cut) + outputSecondsBetween(it, it.sourceIn, sourceTime);
  }
  return null;
}

/** The sequence span [start, end) a source-anchored moment occupies (null when fully cut). Spans several clips when split. */
export function outputSpansForSource(rev: TimelineRevision, assetId: string, start: number, end: number): { start: number; end: number; itemId: string }[] {
  const layout = layoutOf(rev);
  const spans: { start: number; end: number; itemId: string }[] = [];
  for (const l of layout.items) {
    const it = l.item;
    if (it.kind !== "clip" || it.assetId !== assetId) continue;
    const a = Math.max(start, it.sourceIn);
    const b = Math.min(end, it.sourceOut);
    if (b <= a) continue;
    spans.push({ itemId: it.id, start: fromTicks(l.cut) + outputSecondsBetween(it, it.sourceIn, a), end: fromTicks(l.cut) + outputSecondsBetween(it, it.sourceIn, b) });
  }
  return spans;
}

/** Items in sequence order with their output positions — what the clips lane draws. */
export function describeLayout(rev: TimelineRevision): { itemId: string; kind: SequenceItem["kind"]; assetId: string; start: number; end: number; cut: number; label?: string }[] {
  return layoutOf(rev).items.map((l) => ({ itemId: l.item.id, kind: l.item.kind, assetId: l.item.assetId, start: fromTicks(l.start), end: fromTicks(l.end), cut: fromTicks(l.cut), label: l.item.label }));
}
