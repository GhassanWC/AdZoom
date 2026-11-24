/**
 * Pure operations on a sequence — the ONE set of edits the manual timeline,
 * the chat executor and the AI tools all call (see edit-commands/registry.ts).
 *
 * Every op takes the current timeline state and returns a new state plus a
 * list of what changed, or an `OpError` naming the exact precondition that
 * failed (never a silent no-op, never a substitute edit). Ids are stable:
 * moves, trims and retimes keep an item's id; a split keeps the id on the LEFT
 * part and mints the right part's id from the request, so retries are
 * deterministic and references transfer by a stated rule.
 *
 * Reference transfer on split (item X at local output time s):
 *   - item-anchored moments with startTime < s stay on X; others move to the
 *     new right item with startTime −= s (they travel with the footage that
 *     follows the split point);
 *   - a freeze linked to X keeps linking to X (the left part);
 *   - audio gain keyframes are split the same way; fades: fadeIn stays left,
 *     fadeOut goes right; the transition INTO X stays on X.
 */

import type { DetectedMoment } from "@/lib/firebase/schema";
import {
  DEFAULT_FREEZE_SECONDS,
  MAX_RATE,
  MIN_RATE,
  SOURCE_ASSET_ID,
  assetDuration,
  outputSecondsFor,
  rateAt,
  sequenceFromMoments,
  sourceAfterOutput,
  transitionFeasibility,
  type AudioTrackItem,
  type ClipAudio,
  type ProjectAsset,
  type Sequence,
  type SequenceClip,
  type SequenceFreeze,
  type SequenceItem,
  type SpeedCurve,
  type Transition,
} from "./sequence";
import { anchorOf, layoutOf, resolveHolds, TimelineError, type TimelineRevision } from "./evaluate";
import { fromTicks } from "./ticks";

export interface SeqState {
  sequence: Sequence | null | undefined;
  moments: DetectedMoment[];
  assets: ProjectAsset[];
  sourceDuration: number;
}

export interface SeqChange {
  kind: "added" | "updated" | "removed";
  /** Item id, track id, asset id or moment id. */
  id: string;
  target: "item" | "track" | "asset" | "moment" | "sequence";
  summary: string;
  /** Sequence seconds to jump to. */
  at: number;
}

export type OpCode = "not_found" | "bad_args" | "out_of_range" | "too_short" | "unsupported" | "constraint" | "no_change";

export class OpError extends Error {
  readonly code: OpCode;
  constructor(code: OpCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface OpResult {
  state: SeqState;
  changes: SeqChange[];
}

export const MIN_ITEM_SECONDS = 0.1;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
};

function rev(state: SeqState): TimelineRevision {
  return { sequence: state.sequence ?? null, moments: state.moments, assets: state.assets, sourceDuration: state.sourceDuration };
}

/**
 * The authored sequence, materialised from legacy cut/speed moments on first
 * use. Those moments are then REMOVED (the sequence represents them), so the
 * timeline has one source of truth from that point on.
 */
export function ensureSequence(state: SeqState): { state: SeqState; converted: boolean } {
  if (state.sequence && Array.isArray(state.sequence.items)) return { state, converted: false };
  const seq = sequenceFromMoments(state.moments, state.sourceDuration);
  const moments = state.moments.filter((m) => !(m.effectType === "cut" || m.effectType === "speed-up"));
  return { state: { ...state, sequence: seq, moments }, converted: true };
}

function layout(state: SeqState) {
  return layoutOf(rev(state));
}

export function findItem(state: SeqState, itemId: string): { item: SequenceItem; index: number } {
  const idx = state.sequence?.items.findIndex((i) => i.id === itemId) ?? -1;
  if (idx < 0) throw new OpError("not_found", `No clip "${itemId}" on the timeline — it may have been split or removed. Check the timeline and retry.`);
  return { item: state.sequence!.items[idx], index: idx };
}

/** Output seconds of one item's own media. */
export function itemSeconds(state: SeqState, item: SequenceItem): number {
  if (item.kind === "freeze") return resolveHolds(state.sequence!, state.moments).get(item.id) ?? DEFAULT_FREEZE_SECONDS;
  return outputSecondsFor(item.speed, item.sourceIn, item.sourceOut);
}

function withItems(state: SeqState, items: SequenceItem[], audioTracks = state.sequence?.audioTracks): SeqState {
  return { ...state, sequence: { version: 1, items, ...(audioTracks?.length ? { audioTracks } : {}) } };
}

function itemStart(state: SeqState, itemId: string): number {
  const l = layout(state).items.find((x) => x.item.id === itemId);
  return l ? fromTicks(l.cut) : 0;
}

/** Guard against a dependency cycle before returning a state (freezes linked to items). */
function checkCycles(state: SeqState): void {
  try {
    resolveHolds(state.sequence!, state.moments);
  } catch (err) {
    if (err instanceof TimelineError) throw new OpError("constraint", err.message);
    throw err;
  }
}

// ── items ───────────────────────────────────────────────────────────────────

export interface SplitArgs {
  itemId: string;
  /** Seconds since the item's cut (local output time). */
  atLocal: number;
  newId: string;
}

export function splitItem(state0: SeqState, a: SplitArgs): OpResult {
  const { state } = ensureSequence(state0);
  const { item, index } = findItem(state, a.itemId);
  const total = itemSeconds(state, item);
  if (!(a.atLocal > MIN_ITEM_SECONDS - 1e-9) || !(a.atLocal < total - MIN_ITEM_SECONDS + 1e-9)) {
    throw new OpError("out_of_range", `Split point must be inside the clip (${fmt(MIN_ITEM_SECONDS)}–${fmt(total - MIN_ITEM_SECONDS)} into it).`);
  }
  let left: SequenceItem;
  let right: SequenceItem;
  if (item.kind === "freeze") {
    const d = total;
    left = { ...item, duration: r3(a.atLocal), linkedTo: undefined };
    right = { ...item, id: a.newId, duration: r3(d - a.atLocal), linkedTo: undefined, transitionIn: undefined, opacity: item.opacity?.fadeOut ? { fadeOut: item.opacity.fadeOut } : undefined };
    left = { ...left, opacity: item.opacity?.fadeIn ? { fadeIn: item.opacity.fadeIn } : undefined };
  } else {
    const s = r3(sourceAfterOutput(item.speed, item.sourceIn, item.sourceOut, a.atLocal));
    const splitAudioKfs = (kfs: ClipAudio["keyframes"]) => ({
      l: kfs?.filter((k) => k.at < a.atLocal),
      r: kfs?.filter((k) => k.at >= a.atLocal).map((k) => ({ ...k, at: r3(k.at - a.atLocal) })),
    });
    const kf = splitAudioKfs(item.audio?.keyframes);
    const audioL: ClipAudio | undefined = item.audio ? { ...item.audio, fadeOut: undefined, keyframes: kf.l?.length ? kf.l : undefined } : undefined;
    const audioR: ClipAudio | undefined = item.audio
      ? { ...item.audio, fadeIn: undefined, keyframes: kf.r?.length ? kf.r : undefined, ...(item.audio.assetId ? { sourceIn: r3((item.audio.sourceIn ?? item.sourceIn) + (s - item.sourceIn)) } : {}) }
      : undefined;
    left = { ...item, sourceOut: s, opacity: item.opacity?.fadeIn ? { fadeIn: item.opacity.fadeIn } : undefined, audio: clean(audioL) };
    right = { ...item, id: a.newId, sourceIn: s, transitionIn: undefined, opacity: item.opacity?.fadeOut ? { fadeOut: item.opacity.fadeOut } : undefined, audio: clean(audioR) };
  }
  const items = [...state.sequence!.items];
  items.splice(index, 1, clean(left) as SequenceItem, clean(right) as SequenceItem);
  // Item-anchored moments after the split point travel with the right part.
  const moments = state.moments.map((m) => {
    const an = anchorOf(m);
    if (an.kind !== "item" || an.itemId !== item.id || m.startTime < a.atLocal) return m;
    return { ...m, anchor: { kind: "item" as const, itemId: a.newId }, startTime: r3(m.startTime - a.atLocal), endTime: r3(m.endTime - a.atLocal) };
  });
  const next = withItems({ ...state, moments }, items);
  const at = itemStart(next, a.newId);
  return {
    state: next,
    changes: [
      { kind: "updated", id: item.id, target: "item", summary: `Split the clip at ${fmt(at)}`, at },
      { kind: "added", id: a.newId, target: "item", summary: `New clip from ${fmt(at)}`, at },
    ],
  };
}

export function trimItem(state0: SeqState, a: { itemId: string; edge: "start" | "end"; seconds: number }): OpResult {
  const { state } = ensureSequence(state0);
  const { item, index } = findItem(state, a.itemId);
  if (!(a.seconds > 0)) throw new OpError("bad_args", "Trim amount must be more than 0 seconds.");
  const total = itemSeconds(state, item);
  if (a.seconds > total - MIN_ITEM_SECONDS) throw new OpError("too_short", `The clip is ${fmt(total)} long; trimming ${fmt(a.seconds)} would leave less than ${MIN_ITEM_SECONDS}s.`);
  let next: SequenceItem;
  if (item.kind === "freeze") {
    next = { ...item, duration: r3(total - a.seconds), linkedTo: undefined };
  } else if (a.edge === "start") {
    const s = r3(sourceAfterOutput(item.speed, item.sourceIn, item.sourceOut, a.seconds));
    next = { ...item, sourceIn: s, ...(item.audio?.assetId ? { audio: { ...item.audio, sourceIn: r3((item.audio.sourceIn ?? item.sourceIn) + (s - item.sourceIn)) } } : {}) };
  } else {
    const s = r3(sourceAfterOutput(item.speed, item.sourceIn, item.sourceOut, total - a.seconds));
    next = { ...item, sourceOut: s };
  }
  const items = [...state.sequence!.items];
  items[index] = next;
  const st = withItems(state, items);
  const at = itemStart(st, item.id);
  return { state: st, changes: [{ kind: "updated", id: item.id, target: "item", summary: `Trimmed ${fmt(a.seconds)} from the ${a.edge} of the clip`, at }] };
}

export function deleteItem(state0: SeqState, a: { itemId: string }): OpResult {
  const { state } = ensureSequence(state0);
  const { item, index } = findItem(state, a.itemId);
  if (state.sequence!.items.length === 1) throw new OpError("constraint", "That is the only clip — a timeline needs at least one.");
  const at = itemStart(state, item.id);
  const items = state.sequence!.items.filter((i) => i.id !== item.id);
  // Linked holds that pointed at it fall back to a fixed duration.
  const fixed = items.map((i) => (i.kind === "freeze" && i.linkedTo && "itemId" in i.linkedTo && i.linkedTo.itemId === item.id ? { ...i, linkedTo: undefined, duration: itemSeconds(state, i) } : i));
  // Its own effects go with it.
  const moments = state.moments.filter((m) => !(anchorOf(m).kind === "item" && (anchorOf(m) as { itemId: string }).itemId === item.id));
  const removedFx = state.moments.length - moments.length;
  void index;
  return {
    state: withItems({ ...state, moments }, fixed),
    changes: [{ kind: "removed", id: item.id, target: "item", summary: `Removed the clip at ${fmt(at)}${removedFx ? ` (and ${removedFx} attached effect${removedFx === 1 ? "" : "s"})` : ""}`, at }],
  };
}

export function moveItem(state0: SeqState, a: { itemId: string; toIndex: number }): OpResult {
  const { state } = ensureSequence(state0);
  const { item, index } = findItem(state, a.itemId);
  const n = state.sequence!.items.length;
  const to = Math.max(0, Math.min(n - 1, Math.round(a.toIndex)));
  if (to === index) throw new OpError("no_change", "The clip is already there.");
  const items = state.sequence!.items.filter((i) => i.id !== item.id);
  // A transition belongs to the boundary it was on, not to the moved clip.
  items.splice(to, 0, clean({ ...item, transitionIn: undefined }) as SequenceItem);
  const st = withItems(state, items);
  checkCycles(st);
  const at = itemStart(st, item.id);
  return { state: st, changes: [{ kind: "updated", id: item.id, target: "item", summary: `Moved the clip to position ${to + 1} (${fmt(at)})`, at }] };
}

export interface InsertArgs {
  assetId: string;
  sourceIn: number;
  sourceOut: number;
  /** Position in the sequence; omitted = append. */
  atIndex?: number;
  newId: string;
}

export function insertClip(state0: SeqState, a: InsertArgs): OpResult {
  const { state } = ensureSequence(state0);
  const dur = assetDuration(state.assets, a.assetId, state.sourceDuration);
  if (!(dur > 0)) throw new OpError("not_found", `No asset "${a.assetId}" in this project. Add it first (add_asset) or use "source".`);
  const sIn = a.sourceIn;
  const sOut = a.sourceOut;
  // Exact: an out-of-range request is reported, never silently clamped.
  if (sIn < -1e-6 || sOut > dur + 1e-6 || !(sOut - sIn >= MIN_ITEM_SECONDS)) throw new OpError("out_of_range", `The range ${fmt(a.sourceIn)}–${fmt(a.sourceOut)} is outside the asset (0–${fmt(dur)}) or too short.`);
  const items = [...state.sequence!.items];
  const idx = a.atIndex == null ? items.length : Math.max(0, Math.min(items.length, Math.round(a.atIndex)));
  const clip: SequenceClip = { id: a.newId, kind: "clip", assetId: a.assetId, sourceIn: r3(sIn), sourceOut: r3(sOut) };
  items.splice(idx, 0, clip);
  const st = withItems(state, items);
  const at = itemStart(st, a.newId);
  return { state: st, changes: [{ kind: "added", id: a.newId, target: "item", summary: `Inserted ${fmt(sOut - sIn)} of ${a.assetId === SOURCE_ASSET_ID ? "the original" : `"${assetName(state, a.assetId)}"`} at ${fmt(at)}`, at }] };
}

function assetName(state: SeqState, id: string): string {
  return state.assets.find((x) => x.id === id)?.title ?? id;
}

export interface ReplaceArgs {
  itemId: string;
  assetId: string;
  /** In point in the new asset; default: same source in point. */
  sourceIn?: number;
  /** Keep the ORIGINAL clip's sound under the new picture. */
  pictureOnly: boolean;
}

export function replaceSource(state0: SeqState, a: ReplaceArgs): OpResult {
  const { state } = ensureSequence(state0);
  const { item, index } = findItem(state, a.itemId);
  if (item.kind !== "clip") throw new OpError("unsupported", "A frozen frame has no footage to replace — replace the clip it came from.");
  const dur = assetDuration(state.assets, a.assetId, state.sourceDuration);
  if (!(dur > 0)) throw new OpError("not_found", `No asset "${a.assetId}" in this project.`);
  const len = item.sourceOut - item.sourceIn;
  const sIn = a.sourceIn ?? item.sourceIn;
  if (sIn < 0 || sIn + len > dur + 1e-6) throw new OpError("out_of_range", `"${assetName(state, a.assetId)}" has only ${fmt(dur)} — the clip needs ${fmt(len)} from ${fmt(sIn)}.`);
  const audio: ClipAudio | undefined = a.pictureOnly
    ? { ...(item.audio ?? {}), assetId: item.audio?.assetId ?? item.assetId, sourceIn: item.audio?.sourceIn ?? item.sourceIn }
    : item.audio ? { ...item.audio, assetId: undefined, sourceIn: undefined } : undefined;
  const next: SequenceClip = { ...item, assetId: a.assetId, sourceIn: r3(sIn), sourceOut: r3(sIn + len), audio: clean(audio), speed: item.speed ? shiftCurve(item.speed, sIn - item.sourceIn) : undefined };
  const items = [...state.sequence!.items];
  items[index] = clean(next) as SequenceItem;
  // Source-anchored moments stay with their footage (they are the original asset's); nothing to move.
  const st = withItems(state, items);
  const at = itemStart(st, item.id);
  return { state: st, changes: [{ kind: "updated", id: item.id, target: "item", summary: `${a.pictureOnly ? "Replaced the picture" : "Replaced the footage"} at ${fmt(at)} with "${assetName(state, a.assetId)}"${a.pictureOnly ? " (original sound kept)" : ""}`, at }] };
}

function shiftCurve(c: SpeedCurve, by: number): SpeedCurve {
  return { keyframes: c.keyframes.map((k) => ({ at: r3(k.at + by), rate: k.rate })) };
}

export interface FreezeArgs {
  itemId: string;
  /** Seconds since the item's cut where the frame is frozen. */
  atLocal: number;
  duration?: number;
  linkedToMomentId?: string;
  newIds: { freeze: string; right: string };
  audio?: "silent" | "continue";
}

/**
 * Freeze the frame at a point: split the clip there and insert a hold between
 * the halves. The right half starts at the frozen frame, so playback resumes
 * exactly where it stopped.
 */
export function freezeFrame(state0: SeqState, a: FreezeArgs): OpResult {
  const { state } = ensureSequence(state0);
  const { item, index } = findItem(state, a.itemId);
  if (item.kind !== "clip") throw new OpError("unsupported", "That is already a frozen frame.");
  const total = itemSeconds(state, item);
  if (a.linkedToMomentId && !state.moments.some((m) => m.id === a.linkedToMomentId)) throw new OpError("not_found", `No animation "${a.linkedToMomentId}" to link the hold to.`);
  const dur = a.linkedToMomentId ? undefined : Math.max(0.1, a.duration ?? DEFAULT_FREEZE_SECONDS);
  const sourceAt = r3(sourceAfterOutput(item.speed, item.sourceIn, item.sourceOut, Math.max(0, Math.min(total, a.atLocal))));
  const freeze: SequenceFreeze = {
    id: a.newIds.freeze,
    kind: "freeze",
    assetId: item.assetId,
    sourceAt,
    ...(dur != null ? { duration: r3(dur) } : {}),
    ...(a.linkedToMomentId ? { linkedTo: { momentId: a.linkedToMomentId } } : {}),
    ...(a.audio ? { audio: a.audio } : {}),
  };
  const items = [...state.sequence!.items];
  let moments = state.moments;
  if (a.atLocal <= MIN_ITEM_SECONDS) {
    // At the very start: hold the first frame before the clip.
    items.splice(index, 0, freeze);
  } else if (a.atLocal >= total - MIN_ITEM_SECONDS) {
    // At the end: hold the last frame after the clip.
    items.splice(index + 1, 0, { ...freeze, sourceAt: r3(Math.max(item.sourceIn, item.sourceOut - 1 / 60)) });
  } else {
    const split = splitItem(state, { itemId: item.id, atLocal: a.atLocal, newId: a.newIds.right });
    moments = split.state.moments;
    const after = split.state.sequence!.items;
    const i = after.findIndex((x) => x.id === a.newIds.right);
    after.splice(i, 0, freeze);
    items.length = 0;
    items.push(...after);
  }
  // The linked animation starts with the hold.
  if (a.linkedToMomentId) {
    moments = moments.map((m) => (m.id === a.linkedToMomentId ? { ...m, anchor: { kind: "item" as const, itemId: a.newIds.freeze }, endTime: r3(m.endTime - m.startTime), startTime: 0 } : m));
  }
  const st = withItems({ ...state, moments }, items);
  checkCycles(st);
  const at = itemStart(st, a.newIds.freeze);
  const held = itemSeconds(st, freeze);
  return { state: st, changes: [{ kind: "added", id: a.newIds.freeze, target: "item", summary: `Froze the frame at ${fmt(at)} for ${fmt(held)}${a.linkedToMomentId ? " (as long as the animation)" : ""}`, at }] };
}

export function setFreezeDuration(state0: SeqState, a: { itemId: string; duration?: number; linkedToMomentId?: string; linkedToItemId?: string }): OpResult {
  const { state } = ensureSequence(state0);
  const { item, index } = findItem(state, a.itemId);
  if (item.kind !== "freeze") throw new OpError("unsupported", "Only a frozen frame has a hold duration.");
  const next: SequenceFreeze = { ...item, duration: a.duration != null ? r3(Math.max(0.1, a.duration)) : item.duration, linkedTo: a.linkedToMomentId ? { momentId: a.linkedToMomentId } : a.linkedToItemId ? { itemId: a.linkedToItemId } : a.duration != null ? undefined : item.linkedTo };
  const items = [...state.sequence!.items];
  items[index] = clean(next) as SequenceItem;
  const st = withItems(state, items);
  checkCycles(st);
  const at = itemStart(st, item.id);
  return { state: st, changes: [{ kind: "updated", id: item.id, target: "item", summary: `Hold now ${fmt(itemSeconds(st, next))}`, at }] };
}

// ── speed ───────────────────────────────────────────────────────────────────

export function setSpeed(state0: SeqState, a: { itemId: string; rate?: number; keyframes?: { atLocal: number; rate: number }[]; pitch?: "follow" | "preserve" }): OpResult {
  const { state } = ensureSequence(state0);
  const { item, index } = findItem(state, a.itemId);
  if (item.kind !== "clip") throw new OpError("unsupported", "A frozen frame has no playback speed — change its hold instead.");
  let curve: SpeedCurve | undefined;
  if (a.keyframes?.length) {
    const total = itemSeconds(state, item);
    const ks = a.keyframes.map((k) => {
      if (!(k.rate >= MIN_RATE && k.rate <= MAX_RATE)) throw new OpError("bad_args", `Speed must be between ${MIN_RATE}× and ${MAX_RATE}× (got ${k.rate}).`);
      if (k.atLocal < -1e-9 || k.atLocal > total + 1e-9) throw new OpError("out_of_range", `Keyframe at ${fmt(k.atLocal)} is outside the clip (0–${fmt(total)}).`);
      // Keyframe positions are given in the clip's CURRENT output time; store them in source time.
      return { at: r3(sourceAfterOutput(item.speed, item.sourceIn, item.sourceOut, k.atLocal)), rate: k.rate };
    });
    curve = { keyframes: ks };
  } else if (a.rate != null) {
    if (!(a.rate >= MIN_RATE && a.rate <= MAX_RATE)) throw new OpError("bad_args", `Speed must be between ${MIN_RATE}× and ${MAX_RATE}× (got ${a.rate}).`);
    curve = Math.abs(a.rate - 1) < 1e-9 ? undefined : { keyframes: [{ at: item.sourceIn, rate: a.rate }] };
  } else if (!a.pitch) throw new OpError("bad_args", "Give a rate, speed keyframes, or a pitch mode.");
  const next: SequenceClip = { ...item, ...(a.rate != null || a.keyframes?.length ? { speed: curve } : {}), ...(a.pitch ? { audio: { ...(item.audio ?? {}), pitch: a.pitch } } : {}) };
  const items = [...state.sequence!.items];
  items[index] = clean(next) as SequenceItem;
  const st = withItems(state, items);
  const at = itemStart(st, item.id);
  const desc = a.keyframes?.length ? `speed ramp ${a.keyframes.map((k) => `${k.rate}×`).join(" → ")}` : a.rate != null ? `${a.rate}× speed` : `pitch ${a.pitch}`;
  return { state: st, changes: [{ kind: "updated", id: item.id, target: "item", summary: `Set ${desc} on the clip at ${fmt(at)} (now ${fmt(itemSeconds(st, next))})`, at }] };
}

// ── fades + transitions ─────────────────────────────────────────────────────

export function setFade(state0: SeqState, a: { itemId: string; fadeIn?: number; fadeOut?: number }): OpResult {
  const { state } = ensureSequence(state0);
  const { item, index } = findItem(state, a.itemId);
  const total = itemSeconds(state, item);
  for (const v of [a.fadeIn, a.fadeOut]) if (v != null && (v < 0 || v > total)) throw new OpError("out_of_range", `A fade must be between 0 and the clip's length (${fmt(total)}).`);
  const opacity = clean({ ...(item.opacity ?? {}), ...(a.fadeIn != null ? { fadeIn: r3(a.fadeIn) || undefined } : {}), ...(a.fadeOut != null ? { fadeOut: r3(a.fadeOut) || undefined } : {}) });
  const items = [...state.sequence!.items];
  items[index] = clean({ ...item, opacity: opacity && Object.keys(opacity).length ? opacity : undefined }) as SequenceItem;
  const st = withItems(state, items);
  const at = itemStart(st, item.id);
  const bits = [a.fadeIn != null ? `fade in ${fmt(a.fadeIn)}` : null, a.fadeOut != null ? `fade out ${fmt(a.fadeOut)}` : null].filter(Boolean);
  return { state: st, changes: [{ kind: "updated", id: item.id, target: "item", summary: `Set ${bits.join(", ")} on the clip at ${fmt(at)}`, at }] };
}

export function setTransition(state0: SeqState, a: { itemId: string; kind: Transition["kind"] | "none"; duration?: number; color?: string; audio?: "crossfade" | "cut" }): OpResult {
  const { state } = ensureSequence(state0);
  const { item, index } = findItem(state, a.itemId);
  const items = [...state.sequence!.items];
  if (a.kind === "none") {
    if (!item.transitionIn) throw new OpError("no_change", "There is no transition into that clip.");
    items[index] = clean({ ...item, transitionIn: undefined }) as SequenceItem;
    const st = withItems(state, items);
    return { state: st, changes: [{ kind: "updated", id: item.id, target: "item", summary: "Removed the transition", at: itemStart(st, item.id) }] };
  }
  if (index === 0) throw new OpError("constraint", "The first clip has nothing before it to transition from — use a fade in instead.");
  const duration = a.duration ?? 0.75;
  if (!(duration > 0.05)) throw new OpError("bad_args", "Transition duration must be more than 0.05s.");
  const feas = transitionFeasibility(state.sequence!, index, duration, state.assets, state.sourceDuration);
  if (!feas.ok) throw new OpError("constraint", `${feas.reason} Options: use ${feas.maxDuration}s, trim the shots to create handles, or fade instead.`);
  const prevSec = itemSeconds(state, items[index - 1]);
  const thisSec = itemSeconds(state, item);
  if (duration / 2 > prevSec || duration / 2 > thisSec) throw new OpError("constraint", `Both shots must be at least ${fmt(duration / 2)} long for a ${fmt(duration)} transition.`);
  const t: Transition = { kind: a.kind, duration: r3(duration), ...(a.color ? { color: a.color } : {}), ...(a.audio ? { audio: a.audio } : {}) };
  items[index] = { ...item, transitionIn: t };
  const st = withItems(state, items);
  const at = itemStart(st, item.id);
  return { state: st, changes: [{ kind: "updated", id: item.id, target: "item", summary: `Added a ${fmt(duration)} ${a.kind === "dip" ? `dip to ${a.color ?? "black"}` : "cross-dissolve"} into the clip at ${fmt(at)}`, at }] };
}

// ── audio ───────────────────────────────────────────────────────────────────

export function setClipAudio(state0: SeqState, a: { itemId: string; patch: Partial<Pick<ClipAudio, "gain" | "fadeIn" | "fadeOut" | "muted" | "pitch" | "keyframes">> }): OpResult {
  const { state } = ensureSequence(state0);
  const { item, index } = findItem(state, a.itemId);
  if (item.kind !== "clip") {
    if (a.patch.gain != null || a.patch.muted != null) {
      const items = [...state.sequence!.items];
      items[index] = { ...item, gain: a.patch.muted ? 0 : a.patch.gain ?? item.gain, audio: a.patch.muted ? "silent" : item.audio };
      const st = withItems(state, items);
      return { state: st, changes: [{ kind: "updated", id: item.id, target: "item", summary: "Updated the hold's sound", at: itemStart(st, item.id) }] };
    }
    throw new OpError("unsupported", "A frozen frame has no linked audio to shape (only gain/mute).");
  }
  if (a.patch.gain != null && !(a.patch.gain >= 0 && a.patch.gain <= 4)) throw new OpError("bad_args", "Gain is a linear factor from 0 (silent) to 4.");
  const audio = clean({ ...(item.audio ?? {}), ...a.patch }) as ClipAudio;
  const items = [...state.sequence!.items];
  items[index] = clean({ ...item, audio: Object.keys(audio).length ? audio : undefined }) as SequenceItem;
  const st = withItems(state, items);
  const at = itemStart(st, item.id);
  const bits = Object.entries(a.patch).map(([k, v]) => `${k} ${Array.isArray(v) ? `${v.length} keyframes` : String(v)}`);
  return { state: st, changes: [{ kind: "updated", id: item.id, target: "item", summary: `Audio of the clip at ${fmt(at)}: ${bits.join(", ")}`, at }] };
}

/** Detach a clip's sound into an independent track at the same position (picture keeps playing; sound no longer follows edits to the picture). */
export function detachAudio(state0: SeqState, a: { itemId: string; newTrackId: string }): OpResult {
  const { state } = ensureSequence(state0);
  const { item, index } = findItem(state, a.itemId);
  if (item.kind !== "clip") throw new OpError("unsupported", "A frozen frame has no audio to detach.");
  if (item.audio?.linked === false) throw new OpError("no_change", "That clip's audio is already detached.");
  if (item.speed && item.speed.keyframes.length > 1) throw new OpError("unsupported", "Detach the audio before adding a speed ramp (an independent track plays at 1×).");
  const rate = rateAt(item.speed, item.sourceIn);
  if (Math.abs(rate - 1) > 1e-6) throw new OpError("unsupported", "Detached audio plays at 1×; set the clip's speed back to 1× first.");
  const start = itemStart(state, item.id);
  const track: AudioTrackItem = {
    id: a.newTrackId,
    assetId: item.audio?.assetId ?? item.assetId,
    outputStart: r3(start),
    sourceIn: item.audio?.sourceIn ?? item.sourceIn,
    sourceOut: r3((item.audio?.sourceIn ?? item.sourceIn) + (item.sourceOut - item.sourceIn)),
    ...(item.audio?.gain != null ? { gain: item.audio.gain } : {}),
    ...(item.audio?.fadeIn ? { fadeIn: item.audio.fadeIn } : {}),
    ...(item.audio?.fadeOut ? { fadeOut: item.audio.fadeOut } : {}),
    label: `Audio of ${item.label ?? "clip"}`,
  };
  const items = [...state.sequence!.items];
  items[index] = { ...item, audio: { linked: false } };
  const st = withItems(state, items, [...(state.sequence!.audioTracks ?? []), track]);
  return { state: st, changes: [{ kind: "updated", id: item.id, target: "item", summary: `Detached the clip's audio into its own track`, at: start }, { kind: "added", id: a.newTrackId, target: "track", summary: `Audio track at ${fmt(start)}`, at: start }] };
}

export function addAudioTrack(state0: SeqState, a: Omit<AudioTrackItem, "id"> & { id: string }): OpResult {
  const { state } = ensureSequence(state0);
  const dur = assetDuration(state.assets, a.assetId, state.sourceDuration);
  if (!(dur > 0)) throw new OpError("not_found", `No asset "${a.assetId}" in this project — add it first.`);
  const sIn = a.sourceIn;
  const sOut = a.sourceOut;
  if (sIn < -1e-6 || sOut > dur + 1e-6 || !(sOut - sIn >= MIN_ITEM_SECONDS)) throw new OpError("out_of_range", `The range ${fmt(a.sourceIn)}–${fmt(a.sourceOut)} is outside the asset (0–${fmt(dur)}) or too short.`);
  if (a.outputStart < 0) throw new OpError("out_of_range", "A track can't start before the video.");
  const track: AudioTrackItem = clean({ ...a, sourceIn: r3(sIn), sourceOut: r3(sOut), outputStart: r3(a.outputStart) }) as AudioTrackItem;
  const st = withItems(state, state.sequence!.items, [...(state.sequence!.audioTracks ?? []), track]);
  return { state: st, changes: [{ kind: "added", id: a.id, target: "track", summary: `Added "${assetName(state, a.assetId)}" as an audio track from ${fmt(a.outputStart)}${a.duck ? " (ducked under speech)" : ""}`, at: a.outputStart }] };
}

export function updateAudioTrack(state0: SeqState, a: { trackId: string; patch: Partial<Omit<AudioTrackItem, "id" | "assetId">> }): OpResult {
  const { state } = ensureSequence(state0);
  const tracks = state.sequence!.audioTracks ?? [];
  const idx = tracks.findIndex((t) => t.id === a.trackId);
  if (idx < 0) throw new OpError("not_found", `No audio track "${a.trackId}".`);
  const next = clean({ ...tracks[idx], ...a.patch }) as AudioTrackItem;
  const out = [...tracks];
  out[idx] = next;
  const st = withItems(state, state.sequence!.items, out);
  return { state: st, changes: [{ kind: "updated", id: a.trackId, target: "track", summary: `Updated the audio track: ${Object.keys(a.patch).join(", ")}`, at: next.outputStart }] };
}

export function removeAudioTrack(state0: SeqState, a: { trackId: string }): OpResult {
  const { state } = ensureSequence(state0);
  const tracks = state.sequence!.audioTracks ?? [];
  const t = tracks.find((x) => x.id === a.trackId);
  if (!t) throw new OpError("not_found", `No audio track "${a.trackId}".`);
  const st = withItems(state, state.sequence!.items, tracks.filter((x) => x.id !== a.trackId));
  return { state: st, changes: [{ kind: "removed", id: a.trackId, target: "track", summary: "Removed the audio track", at: t.outputStart }] };
}

// ── assets ──────────────────────────────────────────────────────────────────

export function addAsset(state: SeqState, asset: ProjectAsset): OpResult {
  if (!asset.id || asset.id === SOURCE_ASSET_ID) throw new OpError("bad_args", 'Asset id must be set and not "source".');
  if (!(asset.duration > 0)) throw new OpError("bad_args", "An asset needs a known duration.");
  if (state.assets.some((x) => x.id === asset.id)) {
    const assets = state.assets.map((x) => (x.id === asset.id ? { ...x, ...asset } : x));
    return { state: { ...state, assets }, changes: [{ kind: "updated", id: asset.id, target: "asset", summary: `Updated asset "${asset.title ?? asset.id}"`, at: 0 }] };
  }
  return { state: { ...state, assets: [...state.assets, asset] }, changes: [{ kind: "added", id: asset.id, target: "asset", summary: `Added asset "${asset.title ?? asset.id}" (${fmt(asset.duration)})`, at: 0 }] };
}

// ── range helpers used by legacy commands on a sequence ─────────────────────

/** Remove a SOURCE range of one asset from wherever it plays (split + delete pieces). */
export function removeSourceRange(state0: SeqState, a: { assetId: string; start: number; end: number; mintId: () => string }): OpResult {
  const { state: s0 } = ensureSequence(state0);
  let state = s0;
  const changes: SeqChange[] = [];
  // Iterate until no clip of the asset overlaps the range.
  for (let guard = 0; guard < 64; guard++) {
    const hit = state.sequence!.items.find((i) => i.kind === "clip" && i.assetId === a.assetId && i.sourceIn < a.end && i.sourceOut > a.start) as SequenceClip | undefined;
    if (!hit) break;
    const cutIn = Math.max(hit.sourceIn, a.start);
    const cutOut = Math.min(hit.sourceOut, a.end);
    const localIn = outputSecondsFor(hit.speed, hit.sourceIn, cutIn);
    const localOut = outputSecondsFor(hit.speed, hit.sourceIn, cutOut);
    const total = itemSeconds(state, hit);
    const removesAll = localIn <= MIN_ITEM_SECONDS && localOut >= total - MIN_ITEM_SECONDS;
    if (removesAll) {
      if (state.sequence!.items.length === 1) throw new OpError("constraint", "That would remove the whole video.");
      const r = deleteItem(state, { itemId: hit.id });
      state = r.state;
      changes.push(...r.changes);
      continue;
    }
    if (localIn <= MIN_ITEM_SECONDS) {
      const r = trimItem(state, { itemId: hit.id, edge: "start", seconds: localOut });
      state = r.state;
      changes.push(...r.changes);
      continue;
    }
    if (localOut >= total - MIN_ITEM_SECONDS) {
      const r = trimItem(state, { itemId: hit.id, edge: "end", seconds: total - localIn });
      state = r.state;
      changes.push(...r.changes);
      continue;
    }
    // Middle: split at the end of the removed range, then trim the tail off the left part.
    const rightId = a.mintId();
    const sp = splitItem(state, { itemId: hit.id, atLocal: localOut, newId: rightId });
    state = sp.state;
    const tr = trimItem(state, { itemId: hit.id, edge: "end", seconds: localOut - localIn });
    state = tr.state;
    changes.push({ kind: "removed", id: hit.id, target: "item", summary: `Removed ${fmt(cutOut - cutIn)} from the clip`, at: itemStart(state, hit.id) + localIn });
  }
  if (!changes.length) throw new OpError("not_found", `Nothing of that range (${fmt(a.start)}–${fmt(a.end)}) is on the timeline.`);
  return { state, changes };
}

/** Items of the asset overlapping a source range, split at the range edges so the range maps to whole items. */
export function isolateSourceRange(state0: SeqState, a: { assetId: string; start: number; end: number; mintId: () => string }): { state: SeqState; itemIds: string[] } {
  let { state } = ensureSequence(state0);
  for (let guard = 0; guard < 64; guard++) {
    const hit = state.sequence!.items.find((i) => i.kind === "clip" && i.assetId === a.assetId && ((i.sourceIn < a.start && i.sourceOut > a.start + 1e-6) || (i.sourceIn < a.end - 1e-6 && i.sourceOut > a.end))) as SequenceClip | undefined;
    if (!hit) break;
    const edge = hit.sourceIn < a.start && hit.sourceOut > a.start + 1e-6 ? a.start : a.end;
    const local = outputSecondsFor(hit.speed, hit.sourceIn, edge);
    const total = itemSeconds(state, hit);
    if (local <= MIN_ITEM_SECONDS || local >= total - MIN_ITEM_SECONDS) break;
    state = splitItem(state, { itemId: hit.id, atLocal: local, newId: a.mintId() }).state;
  }
  const itemIds = state.sequence!.items.filter((i) => i.kind === "clip" && i.assetId === a.assetId && i.sourceIn < a.end - 1e-6 && i.sourceOut > a.start + 1e-6).map((i) => i.id);
  return { state, itemIds };
}

function clean<T extends object>(o: T | undefined): T | undefined {
  if (!o) return o;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
