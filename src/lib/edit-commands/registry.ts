/**
 * The editor's CAPABILITY REGISTRY — every sequence operation, declared once
 * with its typed inputs, supported targets, preconditions, timing semantics
 * and what it affects. Three things are generated from it:
 *
 *   - the AI tool definitions (flat JSON-schema parameters, one per op),
 *   - the executor dispatch (`runCapability`), which the chat executor AND the
 *     manual timeline call — so a manual split and a chat split are the same
 *     function with the same validation,
 *   - the capability matrix the assistant can describe to the user.
 *
 * An operation that cannot be performed returns the precise missing capability
 * or input; nothing here substitutes a different edit.
 */

import type { ToolDef } from "./tools";
import * as ops from "@/lib/timeline/sequence-ops";
import type { OpResult, SeqState } from "@/lib/timeline/sequence-ops";
import { SOURCE_ASSET_ID } from "@/lib/timeline/sequence";

type Args = Record<string, unknown>;

export interface Capability {
  op: string;
  title: string;
  description: string;
  targets: ("clip" | "freeze" | "track" | "asset" | "timeline")[];
  /** Flat JSON-schema properties (model-friendly). */
  params: Record<string, unknown>;
  required: string[];
  /** Timing semantics the caller must know. */
  timing: string;
  /** What the op changes. */
  affects: string[];
  /** Validates and executes. `mint` yields deterministic ids for the request. */
  run: (state: SeqState, args: Args, ctx: { mint: () => string }) => OpResult;
}

const num = (description: string) => ({ type: "number", description });
const str = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });
const en = (description: string, values: string[]) => ({ type: "string", enum: values, description });

const n = (a: Args, k: string): number | undefined => (typeof a[k] === "number" && Number.isFinite(a[k]) ? (a[k] as number) : undefined);
const s = (a: Args, k: string): string | undefined => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);
const b = (a: Args, k: string): boolean | undefined => (typeof a[k] === "boolean" ? (a[k] as boolean) : undefined);
const req = (a: Args, k: string, kind: "number" | "string" = "string"): never | string | number => {
  const v = kind === "number" ? n(a, k) : s(a, k);
  if (v === undefined) throw new ops.OpError("bad_args", `Missing ${k}.`);
  return v;
};

const CLIP_ID = str("The clip's id (from get_timeline / get_sequence).");

export const CAPABILITIES: readonly Capability[] = [
  {
    op: "split_clip",
    title: "Split a clip",
    description: "Cut one clip into two at a point. The left part keeps the id; item-attached effects after the point move to the new right part.",
    targets: ["clip", "freeze"],
    params: { clip_id: CLIP_ID, at: num("Seconds into the clip (its own output time) to split at.") },
    required: ["clip_id", "at"],
    timing: "at is LOCAL output seconds from the clip's start.",
    affects: ["clip boundaries", "item-anchored effects"],
    run: (st, a, ctx) => ops.splitItem(st, { itemId: req(a, "clip_id") as string, atLocal: req(a, "at", "number") as number, newId: ctx.mint() }),
  },
  {
    op: "trim_item",
    title: "Trim a clip",
    description: "Shorten a clip from its start or end by a number of seconds of OUTPUT time (the viewer's seconds).",
    targets: ["clip", "freeze"],
    params: { clip_id: CLIP_ID, edge: en("Which edge.", ["start", "end"]), seconds: num("Seconds to remove.") },
    required: ["clip_id", "edge", "seconds"],
    timing: "Output seconds; through a speed curve the removed SOURCE span is rate × seconds.",
    affects: ["clip in/out", "downstream positions"],
    run: (st, a) => ops.trimItem(st, { itemId: req(a, "clip_id") as string, edge: s(a, "edge") === "start" ? "start" : "end", seconds: req(a, "seconds", "number") as number }),
  },
  {
    op: "delete_item",
    title: "Delete a clip",
    description: "Remove a clip or frozen frame from the sequence (its attached effects go with it; later clips move up).",
    targets: ["clip", "freeze"],
    params: { clip_id: CLIP_ID },
    required: ["clip_id"],
    timing: "Downstream items shift earlier by the removed length; sequence-pinned items do not move.",
    affects: ["sequence order", "item-anchored effects"],
    run: (st, a) => ops.deleteItem(st, { itemId: req(a, "clip_id") as string }),
  },
  {
    op: "move_clip",
    title: "Move / reorder a clip",
    description: "Move a clip to another position in the sequence (0-based index). Its transition-in is dropped (transitions belong to boundaries).",
    targets: ["clip", "freeze"],
    params: { clip_id: CLIP_ID, to_index: num("New position, 0-based.") },
    required: ["clip_id", "to_index"],
    timing: "Picture and LINKED audio move together; independent audio tracks stay where they are.",
    affects: ["sequence order"],
    run: (st, a) => ops.moveItem(st, { itemId: req(a, "clip_id") as string, toIndex: req(a, "to_index", "number") as number }),
  },
  {
    op: "insert_clip",
    title: "Insert footage",
    description: "Insert a span of an asset (\"source\" = the original upload, or an added asset id) as a new clip at a position.",
    targets: ["timeline"],
    params: { asset_id: str('Asset id ("source" or an added asset).'), source_in: num("Asset seconds, start."), source_out: num("Asset seconds, end."), at_index: num("Position, 0-based; omit to append.") },
    required: ["asset_id", "source_in", "source_out"],
    timing: "Later clips shift by the inserted length; source-anchored captions follow their footage; sequence-pinned items stay.",
    affects: ["sequence order", "output length"],
    run: (st, a, ctx) => ops.insertClip(st, { assetId: req(a, "asset_id") as string, sourceIn: req(a, "source_in", "number") as number, sourceOut: req(a, "source_out", "number") as number, atIndex: n(a, "at_index"), newId: ctx.mint() }),
  },
  {
    op: "replace_source",
    title: "Replace a clip's footage",
    description: "Swap the footage of a clip for another asset at the same length. picture_only=true keeps the ORIGINAL sound under the new picture (a B-roll cut-away).",
    targets: ["clip"],
    params: { clip_id: CLIP_ID, asset_id: str("The replacement asset id."), source_in: num("In point in the new asset (seconds); default = same as before."), picture_only: bool("Keep the original audio (default false).") },
    required: ["clip_id", "asset_id"],
    timing: "Length, position and speed are unchanged.",
    affects: ["clip picture", "clip audio source"],
    run: (st, a) => ops.replaceSource(st, { itemId: req(a, "clip_id") as string, assetId: req(a, "asset_id") as string, sourceIn: n(a, "source_in"), pictureOnly: b(a, "picture_only") ?? false }),
  },
  {
    op: "freeze_frame",
    title: "Freeze frame",
    description: "Hold ONE exact frame of a clip for a duration (or for as long as an animation — link_moment_id). The footage after the hold resumes from that same frame. This is a FOOTAGE edit, not an overlay: never substitute a longer graphic for it.",
    targets: ["clip"],
    params: {
      clip_id: CLIP_ID,
      at: num("Seconds into the clip where the frame is frozen."),
      duration: num("Hold seconds (default 2). Ignored when link_moment_id is set."),
      link_moment_id: str("Hold exactly as long as this animation/effect (its id); the animation is re-anchored to start with the hold."),
      audio: en("Linked sound during the hold: silent (default) or continue playing.", ["silent", "continue"]),
    },
    required: ["clip_id", "at"],
    timing: "Source time stays fixed during the hold while output time and overlays advance.",
    affects: ["sequence (new freeze item + split)", "linked animation anchor"],
    run: (st, a, ctx) => ops.freezeFrame(st, { itemId: req(a, "clip_id") as string, atLocal: req(a, "at", "number") as number, duration: n(a, "duration"), linkedToMomentId: s(a, "link_moment_id"), audio: s(a, "audio") === "continue" ? "continue" : s(a, "audio") === "silent" ? "silent" : undefined, newIds: { freeze: ctx.mint(), right: ctx.mint() } }),
  },
  {
    op: "set_hold",
    title: "Change a freeze's hold",
    description: "Set a frozen frame's duration, or link it to an animation / another clip's length.",
    targets: ["freeze"],
    params: { clip_id: str("The freeze item id."), duration: num("Seconds."), link_moment_id: str("Hold as long as this animation."), link_clip_id: str("Hold as long as this clip.") },
    required: ["clip_id"],
    timing: "Changing a linked animation's length changes the hold and the resume point automatically.",
    affects: ["hold length", "downstream positions"],
    run: (st, a) => ops.setFreezeDuration(st, { itemId: req(a, "clip_id") as string, duration: n(a, "duration"), linkedToMomentId: s(a, "link_moment_id"), linkedToItemId: s(a, "link_clip_id") }),
  },
  {
    op: "set_clip_speed",
    title: "Speed / slow motion / ramp",
    description: "Constant speed (rate: 0.25 = quarter speed slow motion, 2 = double) or a RAMP (ramp_from_rate at ramp_start → ramp_to_rate at ramp_end, seconds into the clip; the rate interpolates linearly in source time). pitch: follow (chipmunk/deep) or preserve.",
    targets: ["clip"],
    params: { clip_id: CLIP_ID, rate: num("Constant rate 0.1–16 (1 = normal)."), ramp_start: num("Seconds into the clip where the ramp starts."), ramp_from_rate: num("Rate at ramp_start."), ramp_end: num("Seconds into the clip where the ramp ends."), ramp_to_rate: num("Rate at ramp_end."), pitch: en("Audio pitch policy.", ["follow", "preserve"]) },
    required: ["clip_id"],
    timing: "Output length = ∫ds/rate over the clip's source span; source in/out are preserved. Linked audio is retimed with the picture.",
    affects: ["clip length", "linked audio rate", "downstream positions"],
    run: (st, a) => {
      const kf: { atLocal: number; rate: number }[] = [];
      if (n(a, "ramp_from_rate") != null && n(a, "ramp_to_rate") != null) {
        kf.push({ atLocal: n(a, "ramp_start") ?? 0, rate: n(a, "ramp_from_rate")! }, { atLocal: n(a, "ramp_end") ?? Number.MAX_SAFE_INTEGER, rate: n(a, "ramp_to_rate")! });
        if (kf[1].atLocal === Number.MAX_SAFE_INTEGER) kf[1].atLocal = ops.itemSeconds(ops.ensureSequence(st).state, ops.findItem(ops.ensureSequence(st).state, req(a, "clip_id") as string).item);
      }
      return ops.setSpeed(st, { itemId: req(a, "clip_id") as string, rate: n(a, "rate"), keyframes: kf.length ? kf : undefined, pitch: s(a, "pitch") === "preserve" ? "preserve" : s(a, "pitch") === "follow" ? "follow" : undefined });
    },
  },
  {
    op: "set_fade",
    title: "Fade a clip in/out",
    description: "Opacity fade from/to transparent (black unless a canvas background shows) at a clip's start and/or end. Linked audio does NOT fade unless set_clip_audio says so.",
    targets: ["clip", "freeze"],
    params: { clip_id: CLIP_ID, fade_in: num("Seconds (0 = none)."), fade_out: num("Seconds (0 = none).") },
    required: ["clip_id"],
    timing: "Measured in the clip's local output time.",
    affects: ["clip opacity"],
    run: (st, a) => ops.setFade(st, { itemId: req(a, "clip_id") as string, fadeIn: n(a, "fade_in"), fadeOut: n(a, "fade_out") }),
  },
  {
    op: "set_transition",
    title: "Transition between two clips",
    description: "A cross-dissolve or dip-to-colour INTO a clip from the previous one, centred on the cut. Needs handle media on both sides (duration/2 each); an unsatisfied handle is reported with the maximum feasible duration before anything changes.",
    targets: ["clip", "freeze"],
    params: { clip_id: str("The INCOMING clip's id."), kind: en("dissolve, dip, or none to remove.", ["dissolve", "dip", "none"]), duration: num("Seconds (default 0.75)."), color: str('Dip colour "#rrggbb" (default black).'), audio: en("Audio under it: crossfade (default) or cut.", ["crossfade", "cut"]) },
    required: ["clip_id", "kind"],
    timing: "Output length unchanged; the outgoing clip shows duration/2 past its out point, the incoming starts duration/2 early. Layer order: incoming on top.",
    affects: ["boundary", "handle media", "audio crossfade"],
    run: (st, a) => ops.setTransition(st, { itemId: req(a, "clip_id") as string, kind: (s(a, "kind") as "dissolve" | "dip" | "none") ?? "dissolve", duration: n(a, "duration"), color: s(a, "color"), audio: s(a, "audio") === "cut" ? "cut" : s(a, "audio") === "crossfade" ? "crossfade" : undefined }),
  },
  {
    op: "set_clip_audio",
    title: "Clip audio: gain, fades, mute, pitch",
    description: "Shape a clip's LINKED audio: linear gain (1 = unchanged), fade in/out seconds, mute, pitch policy for retimed clips.",
    targets: ["clip", "freeze"],
    params: { clip_id: CLIP_ID, gain: num("0–4, linear."), fade_in: num("Seconds."), fade_out: num("Seconds."), muted: bool("Silence the clip's own sound."), pitch: en("follow or preserve.", ["follow", "preserve"]) },
    required: ["clip_id"],
    timing: "Fades are in the clip's local output time; under a freeze the linked sound is silent unless the freeze says continue.",
    affects: ["clip audio envelope"],
    run: (st, a) => ops.setClipAudio(st, { itemId: req(a, "clip_id") as string, patch: { ...(n(a, "gain") != null ? { gain: n(a, "gain") } : {}), ...(n(a, "fade_in") != null ? { fadeIn: n(a, "fade_in") } : {}), ...(n(a, "fade_out") != null ? { fadeOut: n(a, "fade_out") } : {}), ...(b(a, "muted") != null ? { muted: b(a, "muted") } : {}), ...(s(a, "pitch") ? { pitch: s(a, "pitch") as "follow" | "preserve" } : {}) } }),
  },
  {
    op: "detach_audio",
    title: "Detach a clip's audio",
    description: "Turn a clip's sound into an independent audio track at the same position, so the picture can be replaced, reordered or frozen while the sound continues.",
    targets: ["clip"],
    params: { clip_id: CLIP_ID },
    required: ["clip_id"],
    timing: "The new track is pinned to sequence time; the clip becomes picture-only.",
    affects: ["clip audio", "audio tracks"],
    run: (st, a, ctx) => ops.detachAudio(st, { itemId: req(a, "clip_id") as string, newTrackId: ctx.mint() }),
  },
  {
    op: "add_audio_track",
    title: "Add music / narration",
    description: "Lay an asset's audio on an independent track at a sequence time, with gain, fades and optional ducking under speech.",
    targets: ["timeline"],
    params: { asset_id: str("Audio or video asset id."), at: num("Sequence seconds where it starts."), source_in: num("Asset seconds, start (default 0)."), source_out: num("Asset seconds, end (default: asset end)."), gain: num("0–4 linear (default 1)."), fade_in: num("Seconds."), fade_out: num("Seconds."), duck_amount: num("0–1: lower the track by this fraction under speech (0.7 = −70%).") },
    required: ["asset_id", "at"],
    timing: "Pinned to sequence time; unaffected by freezes and speed changes of the picture.",
    affects: ["audio tracks"],
    run: (st, a, ctx) => {
      const assetId = req(a, "asset_id") as string;
      const dur = st.assets.find((x) => x.id === assetId)?.duration ?? (assetId === SOURCE_ASSET_ID ? st.sourceDuration : 0);
      return ops.addAudioTrack(st, { id: ctx.mint(), assetId, outputStart: req(a, "at", "number") as number, sourceIn: n(a, "source_in") ?? 0, sourceOut: n(a, "source_out") ?? dur, ...(n(a, "gain") != null ? { gain: n(a, "gain") } : {}), ...(n(a, "fade_in") ? { fadeIn: n(a, "fade_in") } : {}), ...(n(a, "fade_out") ? { fadeOut: n(a, "fade_out") } : {}), ...(n(a, "duck_amount") ? { duck: { amount: n(a, "duck_amount")! } } : {}) });
    },
  },
  {
    op: "update_audio_track",
    title: "Change an audio track",
    description: "Move or reshape an independent audio track: start time, gain, fades, mute, ducking.",
    targets: ["track"],
    params: { track_id: str("The track id."), at: num("New sequence start."), gain: num("0–4."), fade_in: num("Seconds."), fade_out: num("Seconds."), muted: bool("Mute."), duck_amount: num("0–1; 0 removes ducking.") },
    required: ["track_id"],
    timing: "Sequence time.",
    affects: ["audio tracks"],
    run: (st, a) => ops.updateAudioTrack(st, { trackId: req(a, "track_id") as string, patch: { ...(n(a, "at") != null ? { outputStart: n(a, "at") } : {}), ...(n(a, "gain") != null ? { gain: n(a, "gain") } : {}), ...(n(a, "fade_in") != null ? { fadeIn: n(a, "fade_in") } : {}), ...(n(a, "fade_out") != null ? { fadeOut: n(a, "fade_out") } : {}), ...(b(a, "muted") != null ? { muted: b(a, "muted") } : {}), ...(n(a, "duck_amount") != null ? { duck: n(a, "duck_amount")! > 0 ? { amount: n(a, "duck_amount")! } : undefined } : {}) } }),
  },
  {
    op: "remove_audio_track",
    title: "Remove an audio track",
    description: "Delete an independent audio track.",
    targets: ["track"],
    params: { track_id: str("The track id.") },
    required: ["track_id"],
    timing: "—",
    affects: ["audio tracks"],
    run: (st, a) => ops.removeAudioTrack(st, { trackId: req(a, "track_id") as string }),
  },
];

export const CAPABILITY_BY_OP = new Map(CAPABILITIES.map((c) => [c.op, c]));

/** AI tool definitions generated from the registry (flat parameters). */
export function capabilityTools(): ToolDef[] {
  return CAPABILITIES.map((c) => ({
    name: c.op,
    kind: "edit" as const,
    description: `${c.description} Timing: ${c.timing}`,
    parameters: { type: "object", properties: c.params, required: c.required },
  }));
}

export function isCapabilityOp(op: string): boolean {
  return CAPABILITY_BY_OP.has(op);
}

/** Execute one capability; OpError propagates with its code (the executor maps it). */
export function runCapability(op: string, state: SeqState, args: Args, ctx: { mint: () => string }): OpResult {
  const c = CAPABILITY_BY_OP.get(op);
  if (!c) throw new ops.OpError("unsupported", `No capability "${op}".`);
  return c.run(state, args, ctx);
}

/** A model-readable matrix: what the editor can do and the precise semantics. */
export function describeCapabilities(): { op: string; title: string; targets: string[]; inputs: string[]; timing: string; affects: string[] }[] {
  return CAPABILITIES.map((c) => ({ op: c.op, title: c.title, targets: c.targets, inputs: Object.keys(c.params), timing: c.timing, affects: c.affects }));
}
