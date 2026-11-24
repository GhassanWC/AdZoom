/**
 * Sequence operations through the SHARED executor (applyEditCommands): legacy
 * projects convert on first use, legacy footage ops route onto the sequence,
 * every capability validates its preconditions, and the result evaluates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEditCommands } from "../src/lib/edit-commands/apply.ts";
import { capabilityTools, describeCapabilities, CAPABILITIES } from "../src/lib/edit-commands/registry.ts";
import { evaluateTimeline, outputDurationOf, type TimelineRevision } from "../src/lib/timeline/evaluate.ts";
import type { DetectedMoment } from "../src/lib/firebase/schema.ts";
import type { EditCommand, EditState } from "../src/lib/edit-commands/types.ts";
import type { Sequence } from "../src/lib/timeline/sequence.ts";

const mom = (p: Partial<DetectedMoment> & { id: string; startTime: number; endTime: number; effectType: DetectedMoment["effectType"] }): DetectedMoment =>
  ({ label: p.id, reason: "", focusRegion: { x: 0, y: 0, width: 1, height: 1 }, ...p }) as DetectedMoment;
const cap = (capability: string, args: Record<string, unknown>): EditCommand => ({ op: "capability", capability, args });
const ASSETS = [{ id: "B", kind: "video" as const, url: "b.mp4", duration: 10, hasAudio: true }];
const base = (over: Partial<EditState> = {}): EditState => ({ moments: [], sourceDuration: 12, canvasWidth: 1920, canvasHeight: 1080, assets: ASSETS, ...over });
const ok = (r: ReturnType<typeof applyEditCommands>) => {
  assert.ok(r.ok, JSON.stringify((r as { errors: unknown }).errors));
  return r as Extract<typeof r, { ok: true }>;
};
const revOf = (r: Extract<ReturnType<typeof applyEditCommands>, { ok: true }>, st: EditState): TimelineRevision => ({ sequence: r.sequence ?? st.sequence ?? null, moments: r.moments, assets: r.assets ?? st.assets, sourceDuration: st.sourceDuration });

test("registry: every capability becomes a flat AI tool and a matrix row", () => {
  const tools = capabilityTools();
  assert.equal(tools.length, CAPABILITIES.length);
  for (const t of tools) {
    const props = (t.parameters as { properties: Record<string, { type: string }> }).properties;
    for (const [k, v] of Object.entries(props)) assert.ok(["number", "string", "boolean"].includes(v.type), `${t.name}.${k} must be flat`);
  }
  assert.ok(describeCapabilities().some((c) => c.op === "freeze_frame" && /hold/i.test(c.timing)));
});

test("a legacy project converts to a sequence on its first sequence op; cuts/speed moments are absorbed", () => {
  const st = base({ moments: [mom({ id: "c", startTime: 2, endTime: 4, effectType: "cut", cut: { active: true } }), mom({ id: "t", startTime: 5, endTime: 6, effectType: "text-overlay" })] });
  const r = ok(applyEditCommands(st, [cap("split_clip", { clip_id: "seg_1", at: 1 })], "rq1"));
  assert.ok(r.sequence, "sequence materialised");
  assert.equal(r.moments.some((m) => m.effectType === "cut"), false, "the cut moment is gone — the sequence has the gap");
  assert.equal(r.moments.some((m) => m.id === "t"), true, "overlays untouched");
  assert.deepEqual(r.sequence!.items.map((i) => [i.kind === "clip" ? i.sourceIn : 0, i.kind === "clip" ? i.sourceOut : 0]), [[0, 2], [4, 5], [5, 12]]);
  assert.ok(r.changes.some((c) => /converted to a sequence/.test(c.summary)));
  assert.ok(Math.abs(outputDurationOf(revOf(r, st)) - 10) < 1e-9, "same output length as the cut timeline");
  // Ids: left keeps "seg_1", right is minted from the request → deterministic on retry.
  const again = ok(applyEditCommands(st, [cap("split_clip", { clip_id: "seg_1", at: 1 })], "rq1"));
  assert.deepEqual(again.sequence!.items.map((i) => i.id), r.sequence!.items.map((i) => i.id));
});

test("legacy footage commands route onto the sequence (trim / delete / remove_range / set_speed / tighten_pauses)", () => {
  const seq: Sequence = { version: 1, items: [{ id: "a", kind: "clip", assetId: "source", sourceIn: 0, sourceOut: 6 }, { id: "b", kind: "clip", assetId: "B", sourceIn: 0, sourceOut: 4 }] };
  const st = base({ sequence: seq });
  const r1 = ok(applyEditCommands(st, [{ op: "trim_clip", clipId: "a", edge: "start", seconds: 1 }], "t1"));
  assert.equal((r1.sequence!.items[0] as { sourceIn: number }).sourceIn, 1);
  const r2 = ok(applyEditCommands(st, [{ op: "remove_range", start: 2, end: 3 }], "t2"));
  assert.deepEqual(r2.sequence!.items.map((i) => (i.kind === "clip" ? [i.sourceIn, i.sourceOut] : null)), [[0, 2], [3, 6], [0, 4]]);
  const r3 = ok(applyEditCommands(st, [{ op: "set_speed", start: 2, end: 4, multiplier: 2 }], "t3"));
  const sped = r3.sequence!.items.find((i) => i.kind === "clip" && i.sourceIn === 2)!;
  assert.deepEqual((sped as { speed?: { keyframes: { rate: number }[] } }).speed?.keyframes.map((k) => k.rate), [2]);
  assert.ok(Math.abs(outputDurationOf(revOf(r3, st)) - 9) < 1e-9, "6 + 4 − 1 (2 s at 2×)");
  const slow = ok(applyEditCommands(st, [{ op: "set_speed", start: 0, end: 6, multiplier: 0.5 }], "t4"));
  assert.ok(Math.abs(outputDurationOf(revOf(slow, st)) - 16) < 1e-9, "slow motion is allowed on a sequence");
  const r5 = ok(applyEditCommands({ ...st, silences: [{ start: 1, end: 3 }] }, [{ op: "tighten_pauses", minPause: 1, keep: 0.5 }], "t5"));
  assert.ok(r5.changes.some((c) => /Tightened 1 pause/.test(c.summary)));
  const rr = applyEditCommands(st, [{ op: "restore_range", start: 0, end: 1 }], "t6");
  assert.equal(rr.ok, false);
  assert.equal((rr as { errors: { code: string }[] }).errors[0].code, "unsupported");
  const del = ok(applyEditCommands(st, [{ op: "delete_clip", clipId: "a" }], "t7"));
  assert.deepEqual(del.sequence!.items.map((i) => i.id), ["b"]);
});

test("freeze: fixed and linked holds; resume frame; a title linked to the hold grows the hold", () => {
  const seq: Sequence = { version: 1, items: [{ id: "a", kind: "clip", assetId: "source", sourceIn: 0, sourceOut: 6 }] };
  const title = mom({ id: "title", startTime: 2.0, endTime: 3.5, effectType: "text-overlay" });
  const st = base({ sequence: seq, moments: [title] });
  const r = ok(applyEditCommands(st, [cap("freeze_frame", { clip_id: "a", at: 2, link_moment_id: "title" })], "f1"));
  const items = r.sequence!.items;
  assert.deepEqual(items.map((i) => i.kind), ["clip", "freeze", "clip"]);
  const fz = items[1] as { sourceAt: number; linkedTo?: unknown };
  assert.equal(fz.sourceAt, 2);
  assert.deepEqual(fz.linkedTo, { momentId: "title" });
  assert.equal((items[2] as { sourceIn: number }).sourceIn, 2, "resumes from the frozen frame");
  const rev = revOf(r, st);
  assert.ok(Math.abs(outputDurationOf(rev) - 7.5) < 1e-9, "6 + 1.5 s hold (the title's length)");
  const t = r.moments.find((m) => m.id === "title")!;
  assert.deepEqual(t.anchor, { kind: "item", itemId: items[1].id });
  assert.equal(t.startTime, 0);
  const mid = evaluateTimeline(rev, 2.7);
  assert.equal(mid.layers[0].sourceTime, 2);
  assert.equal(mid.overlays[0]?.moment.id, "title");
  // Revising the animation changes the hold (derived) — one transaction.
  const longer = ok(applyEditCommands({ ...st, sequence: r.sequence, moments: r.moments }, [{ op: "update_element", elementId: "title", end: 3.0 }], "f2"));
  assert.ok(Math.abs(outputDurationOf(revOf(longer, { ...st, sequence: r.sequence })) - 9) < 1e-9);
  assert.ok(Math.abs(evaluateTimeline(revOf(longer, { ...st, sequence: r.sequence }), 5.5).layers[0].sourceTime - 2.5) < 1e-6, "resume point moved with the longer hold");
  // Fixed hold at the end of a clip.
  const tail = ok(applyEditCommands(st, [cap("freeze_frame", { clip_id: "a", at: 6, duration: 1 })], "f3"));
  assert.deepEqual(tail.sequence!.items.map((i) => i.kind), ["clip", "freeze"]);
  // Substituting an overlay is not possible here: the capability either freezes or errors.
  const bad = applyEditCommands(st, [cap("freeze_frame", { clip_id: "nope", at: 1 })], "f4");
  assert.equal(bad.ok, false);
  assert.match((bad as { errors: { message: string }[] }).errors[0].message, /No clip "nope"/);
});

test("transitions report the exact handle constraint before applying; fades and speed ramps apply", () => {
  const seq: Sequence = { version: 1, items: [{ id: "a", kind: "clip", assetId: "source", sourceIn: 0, sourceOut: 6 }, { id: "b", kind: "clip", assetId: "B", sourceIn: 0, sourceOut: 4 }] };
  const st = base({ sequence: seq });
  const no = applyEditCommands(st, [cap("set_transition", { clip_id: "b", kind: "dissolve", duration: 1 })], "x1");
  assert.equal(no.ok, false);
  const err = (no as { errors: { code: string; message: string }[] }).errors[0];
  assert.equal(err.code, "constraint");
  assert.match(err.message, /before the incoming shot.*max 0\.00s/);
  const withHandle = base({ sequence: { ...seq, items: [seq.items[0], { ...(seq.items[1] as object), sourceIn: 1, sourceOut: 5 } as never] } });
  const yes = ok(applyEditCommands(withHandle, [cap("set_transition", { clip_id: "b", kind: "dissolve", duration: 1 })], "x2"));
  assert.deepEqual((yes.sequence!.items[1] as { transitionIn: unknown }).transitionIn, { kind: "dissolve", duration: 1 });
  const first = applyEditCommands(st, [cap("set_transition", { clip_id: "a", kind: "dip", duration: 0.5 })], "x3");
  assert.equal(first.ok, false, "nothing before the first clip");
  const fade = ok(applyEditCommands(st, [cap("set_fade", { clip_id: "a", fade_in: 0.5, fade_out: 0.25 })], "x4"));
  assert.deepEqual((fade.sequence!.items[0] as { opacity: unknown }).opacity, { fadeIn: 0.5, fadeOut: 0.25 });
  const ramp = ok(applyEditCommands(st, [cap("set_clip_speed", { clip_id: "a", ramp_start: 2, ramp_from_rate: 1, ramp_end: 6, ramp_to_rate: 0.25, pitch: "preserve" })], "x5"));
  const a = ramp.sequence!.items[0] as { speed: { keyframes: { at: number; rate: number }[] }; audio: { pitch: string } };
  assert.deepEqual(a.speed.keyframes, [{ at: 2, rate: 1 }, { at: 6, rate: 0.25 }]);
  assert.equal(a.audio.pitch, "preserve");
  assert.ok(outputDurationOf(revOf(ramp, st)) > 10, "ramp lengthens the clip");
  const badRate = applyEditCommands(st, [cap("set_clip_speed", { clip_id: "a", rate: 40 })], "x6");
  assert.equal(badRate.ok, false);
});

test("multi-source: insert, move, replace picture-only, detach audio, music track with ducking", () => {
  const seq: Sequence = { version: 1, items: [{ id: "a", kind: "clip", assetId: "source", sourceIn: 0, sourceOut: 6 }] };
  const st = base({ sequence: seq });
  const r = ok(
    applyEditCommands(
      st,
      [
        cap("insert_clip", { asset_id: "B", source_in: 1, source_out: 3, at_index: 0 }),
        cap("add_audio_track", { asset_id: "B", at: 0, source_in: 0, source_out: 8, gain: 0.6, duck_amount: 0.7 }),
      ],
      "m1"
    )
  );
  assert.equal(r.sequence!.items[0].assetId, "B");
  assert.match(r.sequence!.items[0].id, /_1$/, "minted from the request id");
  const insertedId = r.sequence!.items[0].id;
  assert.equal(r.sequence!.audioTracks?.[0].duck?.amount, 0.7);
  const st2 = { ...st, sequence: r.sequence, moments: r.moments };
  const moved = ok(applyEditCommands(st2, [cap("move_clip", { clip_id: insertedId, to_index: 1 })], "m2"));
  assert.deepEqual(moved.sequence!.items.map((i) => i.id), ["a", insertedId]);
  const rep = ok(applyEditCommands(st2, [cap("replace_source", { clip_id: "a", asset_id: "B", source_in: 2, picture_only: true })], "m3"));
  const a = rep.sequence!.items.find((i) => i.id === "a") as { assetId: string; sourceIn: number; sourceOut: number; audio: { assetId: string; sourceIn: number } };
  assert.equal(a.assetId, "B");
  assert.deepEqual([a.sourceIn, a.sourceOut], [2, 8]);
  assert.deepEqual(a.audio, { assetId: "source", sourceIn: 0 }, "original sound retained");
  const ev = evaluateTimeline(revOf(rep, st2), 3.0); // item a now at 2..8 (after the 2 s B clip)
  assert.equal(ev.layers[0].assetId, "B");
  assert.equal(ev.audio.find((s) => s.id === "item:a")?.assetId, "source");
  const det = ok(applyEditCommands(st2, [cap("detach_audio", { clip_id: "a" })], "m4"));
  assert.equal((det.sequence!.items.find((i) => i.id === "a") as { audio: { linked: boolean } }).audio.linked, false);
  assert.equal(det.sequence!.audioTracks!.length, 2);
  assert.equal(det.sequence!.audioTracks![1].outputStart, 2, "track pinned where the clip's sound was");
  const tooLong = applyEditCommands(st2, [cap("insert_clip", { asset_id: "B", source_in: 8, source_out: 12 })], "m5");
  assert.equal(tooLong.ok, false);
  assert.match((tooLong as { errors: { message: string }[] }).errors[0].message, /outside the asset/);
});

test("the audio lock still blocks footage retiming on a sequence; effects pass", () => {
  const st = base({ sequence: { version: 1, items: [{ id: "a", kind: "clip", assetId: "source", sourceIn: 0, sourceOut: 6 }] }, audioLocked: true });
  const r = applyEditCommands(st, [cap("set_clip_speed", { clip_id: "a", rate: 2 }), cap("set_fade", { clip_id: "a", fade_in: 0.3 }), cap("freeze_frame", { clip_id: "a", at: 2, duration: 1, audio: "continue" })], "l1", { partial: true });
  assert.ok(r.ok);
  const res = r as Extract<typeof r, { ok: true }>;
  assert.deepEqual(res.errors.map((e) => [e.commandIndex, e.code]), [[0, "locked"]], "retiming is blocked; a fade and a hold that keeps the sound playing pass");
  assert.deepEqual(res.sequence!.items.map((i) => i.kind), ["clip", "freeze", "clip"]);
});
