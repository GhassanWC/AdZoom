/**
 * The timing contract: sequence model + evaluateTimeline.
 *
 * Pins (1) parity with the legacy `buildTimelineMap` for cut/speed projects,
 * (2) speed-curve integrals and their inverse, (3) freezes (fixed + linked,
 * cycle detection), (4) transitions (handles, layers, opacity, crossfade),
 * (5) multi-source + anchors, (6) audio stems, tracks and ducking, (7) the
 * exporter plans.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTimelineMap, sourceTimeForOutput } from "../src/lib/timeline/crop-speed.ts";
import { TICKS_PER_SECOND, toTicks, fromTicks, frameTicks } from "../src/lib/timeline/ticks.ts";
import {
  layoutSequence,
  outputSecondsFor,
  rateAt,
  sequenceFromMoments,
  sourceAfterOutput,
  transitionFeasibility,
  type Sequence,
} from "../src/lib/timeline/sequence.ts";
import {
  evaluateTimeline,
  outputDurationOf,
  outputTimeForSource,
  planAudio,
  planVideo,
  resolveHolds,
  TimelineError,
  type TimelineRevision,
} from "../src/lib/timeline/evaluate.ts";
import type { DetectedMoment } from "../src/lib/firebase/schema.ts";

const mom = (p: Partial<DetectedMoment> & { id: string; startTime: number; endTime: number; effectType: DetectedMoment["effectType"] }): DetectedMoment =>
  ({ label: p.id, reason: "", focusRegion: { x: 0, y: 0, width: 1, height: 1 }, ...p }) as DetectedMoment;
const cut = (id: string, a: number, b: number) => mom({ id, startTime: a, endTime: b, effectType: "cut", cut: { active: true } });
const speed = (id: string, a: number, b: number, multiplier: number, audioMode: "mute" | "keep" | "pitch-correct" = "keep") =>
  mom({ id, startTime: a, endTime: b, effectType: "speed-up", speed: { multiplier, audioMode, transition: "cut" } });

test("ticks: integer frame boundaries at every supported rate", () => {
  for (const fps of [24, 25, 30, 48, 50, 60, 120]) assert.equal(Number.isInteger(TICKS_PER_SECOND / fps), true, `${fps}fps`);
  assert.equal(fromTicks(toTicks(1.5)), 1.5);
  assert.equal(frameTicks(30) * 30, TICKS_PER_SECOND);
});

test("legacy parity: evaluateTimeline reproduces sourceTimeForOutput for cuts + constant speed", () => {
  const moments = [cut("c1", 2, 3.5), speed("s1", 5, 8, 2), cut("c2", 7, 7.25), speed("s2", 9, 9.8, 3, "mute")];
  const dur = 12;
  const map = buildTimelineMap(moments, dur);
  const rev: TimelineRevision = { moments, sourceDuration: dur };
  assert.ok(Math.abs(outputDurationOf(rev) - map.outputDuration) < 1e-6);
  for (let f = 0; f < Math.floor(map.outputDuration * 30); f++) {
    const o = f / 30;
    const legacy = sourceTimeForOutput(map, o);
    const e = evaluateTimeline(rev, o);
    assert.equal(e.layers.length, 1, `one layer at ${o}`);
    const got = e.layers[0].sourceTime;
    // Exact boundaries may land on either side by float noise in the legacy map; both sides are valid there.
    const nearBoundary = map.segments.some((s) => Math.abs(s.outputStart - o) < 1e-6 || Math.abs(s.outputEnd - o) < 1e-6);
    if (!nearBoundary) assert.ok(Math.abs(got - legacy) < 1e-6, `o=${o}: ${got} vs ${legacy}`);
    else assert.ok(map.segments.some((s) => Math.abs(got - s.sourceStart) < 1e-6 || Math.abs(got - s.sourceEnd) < 1e-6 || Math.abs(got - legacy) < 1e-6));
  }
  // Audio: the muted speed section carries no stem; the kept one does, at 2×.
  const inMuted = evaluateTimeline(rev, map.segments.find((s) => s.speedMultiplier === 3)!.outputStart + 0.1);
  assert.equal(inMuted.audio.length, 0);
  const in2x = evaluateTimeline(rev, map.segments.find((s) => s.speedMultiplier === 2)!.outputStart + 0.1);
  assert.equal(in2x.audio[0].rate, 2);
});

test("speed curves: integral and inverse agree; ramps interpolate linearly in source time", () => {
  const curve = { keyframes: [{ at: 10, rate: 1 }, { at: 12, rate: 0.25 }] };
  assert.equal(rateAt(curve, 9), 1);
  assert.equal(rateAt(curve, 11), 0.625);
  assert.equal(rateAt(curve, 13), 0.25);
  // Constant 1× before, then a 2 s source ramp that takes (2/(0.25-1))·ln(0.25) = 3.6968 s, then 0.25×.
  const o = outputSecondsFor(curve, 8, 14);
  assert.ok(Math.abs(o - (2 + (2 / -0.75) * Math.log(0.25) + 2 / 0.25)) < 1e-9);
  for (const t of [0, 0.5, 2, 3, 5, 9, 13.69]) {
    const s = sourceAfterOutput(curve, 8, 14, t);
    assert.ok(Math.abs(outputSecondsFor(curve, 8, s) - t) < 1e-7, `round trip at ${t}`);
  }
  assert.equal(sourceAfterOutput(curve, 8, 14, 99), 14, "clamps at the out point");
  // Slow motion is slow: 0.5× doubles output time.
  assert.equal(outputSecondsFor({ keyframes: [{ at: 0, rate: 0.5 }] }, 0, 3), 6);
});

const ASSETS = [
  { id: "B", kind: "video" as const, url: "b.mp4", duration: 10, hasAudio: true },
  { id: "music", kind: "audio" as const, url: "m.mp3", duration: 60, hasAudio: true },
];

test("freeze: picture holds while sequence time and anchored animations advance; resume skips nothing", () => {
  const seq: Sequence = {
    version: 1,
    items: [
      { id: "a", kind: "clip", assetId: "source", sourceIn: 0, sourceOut: 4 },
      { id: "hold", kind: "freeze", assetId: "source", sourceAt: 4, duration: 1.5 },
      { id: "b", kind: "clip", assetId: "source", sourceIn: 4, sourceOut: 8 },
    ],
  };
  const title = mom({ id: "t", startTime: 0.2, endTime: 1.2, effectType: "text-overlay", anchor: { kind: "item", itemId: "hold" } });
  const rev: TimelineRevision = { sequence: seq, moments: [title], sourceDuration: 12 };
  assert.equal(outputDurationOf(rev), 9.5);
  const mid = evaluateTimeline(rev, 4.75);
  assert.equal(mid.layers[0].sourceTime, 4, "source time fixed");
  assert.equal(mid.layers[0].frozen, true);
  assert.equal(mid.overlays.length, 1);
  assert.ok(Math.abs(mid.overlays[0].localTime - 0.55) < 1e-9, "the animation is 0.55 s in");
  assert.equal(evaluateTimeline(rev, 5.4).overlays.length, 0, "and has ended by 1.2 s into the hold");
  assert.equal(evaluateTimeline(rev, 5.5).layers[0].sourceTime, 4, "resumes at the frozen frame, nothing skipped");
  assert.equal(mid.audio.length, 0, "linked audio is silent during a hold");
  // Linked to the title: changing the title's duration changes the hold and the resume point.
  const linked: TimelineRevision = { ...rev, sequence: { ...seq, items: seq.items.map((i) => (i.id === "hold" ? { ...i, duration: undefined, linkedTo: { momentId: "t" } } : i)) } };
  assert.equal(outputDurationOf(linked), 8 + 1.0);
  const longer = { ...linked, moments: [{ ...title, endTime: 2.2 }] };
  assert.equal(outputDurationOf(longer), 10);
  assert.equal(evaluateTimeline(longer, 6.0).layers[0].sourceTime, 4);
  assert.ok(Math.abs(evaluateTimeline(longer, 6.5).layers[0].sourceTime - 4.5) < 1e-6);
});

test("freeze: a circular linked duration is reported, never evaluated forever", () => {
  const seq: Sequence = {
    version: 1,
    items: [
      { id: "f1", kind: "freeze", assetId: "source", sourceAt: 1, linkedTo: { itemId: "f2" } },
      { id: "f2", kind: "freeze", assetId: "source", sourceAt: 2, linkedTo: { itemId: "f1" } },
    ],
  };
  assert.throws(() => resolveHolds(seq, []), (e: unknown) => e instanceof TimelineError && e.code === "circular_dependency");
  const ok: Sequence = { version: 1, items: [{ id: "c", kind: "clip", assetId: "source", sourceIn: 0, sourceOut: 2 }, { id: "f", kind: "freeze", assetId: "source", sourceAt: 2, linkedTo: { itemId: "c" } }] };
  assert.equal(resolveHolds(ok, []).get("f"), 2, "linked to a clip: as long as the clip");
});

test("transitions: handle check, two layers, dissolve opacity and equal-power audio crossfade", () => {
  const base: Sequence = {
    version: 1,
    items: [
      { id: "a", kind: "clip", assetId: "source", sourceIn: 0, sourceOut: 4 },
      { id: "b", kind: "clip", assetId: "B", sourceIn: 0, sourceOut: 3 },
    ],
  };
  // B starts at its first frame: no handle before its in point.
  const no = transitionFeasibility(base, 1, 1, ASSETS, 12);
  assert.equal(no.ok, false);
  assert.match(no.reason!, /before the incoming shot/);
  const withHandles: Sequence = { ...base, items: [base.items[0], { ...base.items[1], sourceIn: 1, sourceOut: 4, transitionIn: { kind: "dissolve", duration: 1 } }] } as Sequence;
  assert.equal(transitionFeasibility(withHandles, 1, 1, ASSETS, 12).ok, true);
  assert.equal(transitionFeasibility(withHandles, 1, 3, ASSETS, 12).ok, false, "2 s of handle each side at most");
  const rev: TimelineRevision = { sequence: withHandles, moments: [], sourceDuration: 12, assets: ASSETS };
  assert.equal(outputDurationOf(rev), 7, "a centred transition does not change the length");
  const before = evaluateTimeline(rev, 3.4);
  assert.equal(before.layers.length, 1);
  const during = evaluateTimeline(rev, 3.75); // overlap is [3.5, 4.5): progress 0.25
  assert.equal(during.layers.length, 2);
  assert.equal(during.layers[0].itemId, "a");
  assert.equal(during.layers[1].itemId, "b");
  assert.ok(Math.abs(during.layers[1].opacity - 0.25) < 1e-9);
  assert.ok(Math.abs(during.layers[0].sourceTime - 3.75) < 1e-9, "A plays its handle past 3.5… wait: A's own media ends at 4; at 3.75 it is still inside");
  assert.ok(Math.abs(during.layers[1].sourceTime - 0.75) < 1e-9, "B shows handle media 0.25 s before its in point (1.0)");
  const late = evaluateTimeline(rev, 4.25); // A past its out point: tail handle
  assert.ok(Math.abs(late.layers[0].sourceTime - 4.25) < 1e-9);
  assert.equal(late.dominant!.itemId, "b");
  const a = during.audio.find((s) => s.id === "item:a")!;
  const b = during.audio.find((s) => s.id === "item:b")!;
  assert.ok(Math.abs(a.gain ** 2 + b.gain ** 2 - 1) < 1e-9, "equal power");
  const after = evaluateTimeline(rev, 4.6);
  assert.equal(after.layers.length, 1);
  assert.equal(after.layers[0].itemId, "b");
  // Dip to colour: plate reported, outgoing gone by the midpoint.
  const dip: TimelineRevision = { ...rev, sequence: { ...withHandles, items: [withHandles.items[0], { ...withHandles.items[1], transitionIn: { kind: "dip", duration: 1, color: "#ffffff" } }] } as Sequence };
  const d = evaluateTimeline(dip, 4.0);
  assert.equal(d.plateColor, "#ffffff");
  assert.ok(d.layers[0].opacity < 1e-9 && d.layers[1].opacity < 1e-9, "fully on the plate at the midpoint");
});

test("clip fades, multi-source order, anchors and reuse of the same asset", () => {
  const seq: Sequence = {
    version: 1,
    items: [
      { id: "b1", kind: "clip", assetId: "B", sourceIn: 2, sourceOut: 4, opacity: { fadeIn: 0.5 } },
      { id: "a1", kind: "clip", assetId: "source", sourceIn: 6, sourceOut: 8 },
      { id: "b2", kind: "clip", assetId: "B", sourceIn: 0, sourceOut: 1, opacity: { fadeOut: 0.5 } },
    ],
  };
  const caption = mom({ id: "cap", startTime: 6.5, endTime: 7.5, effectType: "captions" }); // source-anchored to the original
  const bTitle = mom({ id: "bt", startTime: 2.1, endTime: 3.0, effectType: "text-overlay", anchor: { kind: "source", assetId: "B" } });
  const lowerThird = mom({ id: "lt", startTime: 1.0, endTime: 4.0, effectType: "graphic", anchor: { kind: "sequence" } });
  const rev: TimelineRevision = { sequence: seq, moments: [caption, bTitle, lowerThird], sourceDuration: 12, assets: ASSETS };
  assert.equal(outputDurationOf(rev), 5);
  const e0 = evaluateTimeline(rev, 0.25);
  assert.equal(e0.layers[0].assetId, "B");
  assert.ok(Math.abs(e0.layers[0].opacity - 0.5) < 1e-9, "fading in");
  assert.deepEqual(e0.overlays.map((o) => o.moment.id), ["bt"], "B's own title shows, the original's caption does not");
  const e1 = evaluateTimeline(rev, 2.5); // a1 at source 6.5
  assert.equal(e1.layers[0].assetId, "source");
  assert.ok(Math.abs(e1.layers[0].sourceTime - 6.5) < 1e-9);
  assert.deepEqual(e1.overlays.map((o) => o.moment.id).sort(), ["cap", "lt"]);
  assert.ok(Math.abs(e1.overlays.find((o) => o.moment.id === "lt")!.localTime - 1.5) < 1e-9, "sequence-pinned: 1.5 s in");
  const e2 = evaluateTimeline(rev, 4.9);
  assert.equal(e2.layers[0].itemId, "b2");
  assert.ok(Math.abs(e2.layers[0].opacity - 0.2) < 1e-9, "fading out");
  assert.equal(outputTimeForSource(rev, "source", 7), 3, "caption position in sequence time");
  assert.equal(outputTimeForSource(rev, "source", 1), null, "footage not in the sequence");
  assert.equal(evaluateTimeline(rev, 99).layers[0].itemId, "b2", "past the end holds the last item");
});

test("audio: picture-only replacement keeps the original sound; detached clips are silent; tracks duck under speech", () => {
  const seq: Sequence = {
    version: 1,
    items: [
      { id: "x", kind: "clip", assetId: "B", sourceIn: 1, sourceOut: 3, audio: { assetId: "source", sourceIn: 5, gain: 0.5 } },
      { id: "y", kind: "clip", assetId: "source", sourceIn: 8, sourceOut: 10, audio: { linked: false } },
    ],
    audioTracks: [{ id: "m", assetId: "music", outputStart: 0, sourceIn: 10, sourceOut: 14, gain: 0.8, fadeIn: 1, duck: { amount: 0.75, attack: 0.5, release: 0.5 } }],
  };
  const rev: TimelineRevision = { sequence: seq, moments: [], sourceDuration: 12, assets: ASSETS, speech: [{ start: 5.5, end: 6.5 }] };
  const e = evaluateTimeline(rev, 1.0); // x: picture B@2, sound source@6 (inside speech)
  const pic = e.layers[0];
  assert.equal(pic.assetId, "B");
  assert.ok(Math.abs(pic.sourceTime - 2) < 1e-9);
  const clipAudio = e.audio.find((s) => s.id === "item:x")!;
  assert.equal(clipAudio.assetId, "source");
  assert.ok(Math.abs(clipAudio.sourceTime - 6) < 1e-9);
  assert.equal(clipAudio.gain, 0.5);
  const music = e.audio.find((s) => s.id === "track:m")!;
  assert.ok(Math.abs(music.gain - 0.8 * 1.0 * 0.25) < 1e-9, "fade-in complete, ducked to 25%");
  assert.ok(Math.abs(evaluateTimeline(rev, 0.25).audio.find((s) => s.id === "track:m")!.gain - 0.8 * 0.25 * (1 - 0.75 * 0.5)) < 1e-9, "fading in and half-way through the duck attack");
  const y = evaluateTimeline(rev, 3.0);
  assert.equal(y.audio.find((s) => s.id === "item:y"), undefined, "detached picture is silent");
  assert.ok(y.audio.find((s) => s.id === "track:m")!.gain > 0.79, "music continues at full gain");
});

test("plans: constant-rate runs for decoders and gain envelopes for mixers", () => {
  const seq: Sequence = {
    version: 1,
    items: [
      { id: "a", kind: "clip", assetId: "source", sourceIn: 0, sourceOut: 2, speed: { keyframes: [{ at: 0, rate: 1 }, { at: 2, rate: 0.5 }] }, audio: { fadeOut: 0.5 } },
      { id: "f", kind: "freeze", assetId: "source", sourceAt: 2, duration: 1 },
    ],
  };
  const rev: TimelineRevision = { sequence: seq, moments: [], sourceDuration: 12 };
  const v = planVideo(rev);
  assert.ok(v.filter((r) => r.itemId === "a").length > 4, "ramp sampled into several constant runs");
  assert.ok(v.every((r, i) => i === 0 || r.outputStart >= v[i - 1].outputStart));
  const fz = v.find((r) => r.kind === "freeze")!;
  assert.equal(fz.rate, 0);
  assert.equal(fz.sourceStart, 2);
  const rates = v.filter((r) => r.itemId === "a").map((r) => r.rate);
  assert.ok(rates[0] > rates[rates.length - 1], "rate falls through the ramp");
  const a = planAudio(rev);
  const stem = a.filter((r) => r.stemId === "item:a");
  assert.ok(stem.length > 0);
  const last = stem[stem.length - 1];
  assert.ok(last.gain[last.gain.length - 1].gain < 0.1, "fade-out reaches ~0 at the end");
  assert.equal(a.find((r) => r.stemId === "item:f"), undefined, "silent freeze has no audio run");
});

test("layout boundaries: the later item owns an exact cut tick", () => {
  const seq: Sequence = { version: 1, items: [{ id: "a", kind: "clip", assetId: "source", sourceIn: 0, sourceOut: 1 }, { id: "b", kind: "clip", assetId: "source", sourceIn: 5, sourceOut: 6 }] };
  const rev: TimelineRevision = { sequence: seq, moments: [], sourceDuration: 12 };
  const lay = layoutSequence(seq, () => 0);
  assert.equal(lay.items[1].cut, toTicks(1));
  assert.equal(evaluateTimeline(rev, 1).layers[0].itemId, "b");
  assert.equal(evaluateTimeline(rev, 1 - 1 / TICKS_PER_SECOND).layers[0].itemId, "a");
  assert.equal(sequenceFromMoments([cut("c", 1, 5)], 6).items.length, 2);
});

// Motion ON a freeze: a zoom anchored to the freeze item runs on elapsed time
// within the hold while the held frame stays fixed; the clip after the freeze
// falls back to its own source-anchored camera from its first frame.
test("freeze: an item-anchored zoom progresses over the hold while the picture stays fixed", async () => {
  const { cameraForLayer } = await import("../src/lib/timeline/evaluate.ts");
  const { resolveCameraFrame } = await import("../src/lib/timeline/camera.ts");
  const seq: Sequence = {
    version: 1,
    items: [
      { id: "a", kind: "clip", assetId: "source", sourceIn: 0, sourceOut: 4 },
      { id: "hold", kind: "freeze", assetId: "source", sourceAt: 4, duration: 3 },
      { id: "b", kind: "clip", assetId: "source", sourceIn: 4, sourceOut: 8 },
    ],
  };
  const zoomOnHold = mom({ id: "z", startTime: 0, endTime: 3, effectType: "zoom", anchor: { kind: "item", itemId: "hold" }, focusRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
  const sourceZoom = mom({ id: "s", startTime: 1, endTime: 2, effectType: "zoom", focusRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
  const rev: TimelineRevision = { sequence: seq, moments: [zoomOnHold, sourceZoom], sourceDuration: 12 };
  const scaleAt = (t: number) => {
    const ev = evaluateTimeline(rev, t);
    const layer = ev.layers[ev.layers.length - 1];
    const cam = cameraForLayer(rev.moments, layer);
    return { layer, cam, scale: resolveCameraFrame(cam.moments, cam.t, { autoZoom: true }).camera.scale };
  };
  const early = scaleAt(4.3);
  const mid = scaleAt(5.5);
  const late = scaleAt(6.9);
  assert.equal(early.layer.sourceTime, 4, "held frame");
  assert.equal(mid.layer.sourceTime, 4, "held frame");
  assert.equal(early.cam.base, "item");
  assert.ok(Math.abs(early.cam.t - 0.3) < 1e-9 && Math.abs(mid.cam.t - 1.5) < 1e-9, "camera time = elapsed time in the hold");
  assert.ok(mid.scale > early.scale && mid.scale > 1.05, `zoom progresses over the hold (${early.scale.toFixed(3)} → ${mid.scale.toFixed(3)})`);
  assert.ok(late.scale < mid.scale, "and eases back out before the hold ends");
  const resume = scaleAt(7.0);
  assert.equal(resume.layer.sourceTime, 4, "first frame after the hold is the frozen frame");
  assert.equal(resume.cam.base, "source", "the clip after the freeze uses its own source camera");
  assert.ok(Math.abs(resume.scale - 1) < 1e-6, "no zoom carried over");
  // Stable identities per moments array: the schedule cache in camera.ts keys on the array.
  assert.equal(cameraForLayer(rev.moments, early.layer).moments, early.cam.moments);
  // The source zoom on clip a still works as before.
  const onA = scaleAt(1.5);
  assert.equal(onA.cam.base, "source");
  assert.ok(onA.scale > 1.05);
});
