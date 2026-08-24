/**
 * Preview playback — skipping past cuts without stuttering.
 *
 * The bug these lock down presented as "the video pauses all the time": on a
 * 6-minute edit the preview played, stalled, played, stalled. It was not a
 * buffering problem in the usual sense — it was the cut-skip in the preview's
 * rAF loop seeking to `cut.endTime` EXACTLY.
 *
 * `activeCutAt` excludes the end boundary (`t >= endTime` is outside), so a seek
 * has to land strictly past it. Browsers snap a seek to a keyframe and routinely
 * land a hair short, which put the playhead back INSIDE the cut — so the next
 * frame seeked again, and again. Every one of those is a decoder flush plus, on
 * a remote source, a fresh HTTP range request.
 *
 * The second half is the same story with adjacent cuts: `activeCutAt` returns
 * one cut, so a run of them used to cost a full seek + rebuffer EACH.
 *
 * The rule, in one line: **the returned time must be strictly outside every
 * active cut.** That is what these assert, because it's the property that makes
 * the seek final — and a seek that isn't final is a stutter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  activeCutAt,
  cutSkipTarget,
  isActiveCut,
} from "../src/lib/timeline/crop-speed.ts";
import type { DetectedMoment } from "../src/lib/firebase/schema.ts";

/** A minimal active cut. */
function cut(id: string, startTime: number, endTime: number, active = true): DetectedMoment {
  return {
    id,
    effectType: "cut",
    startTime,
    endTime,
    cut: { active },
  } as unknown as DetectedMoment;
}

/** A non-cut edit, to prove they're ignored. */
function zoom(id: string, startTime: number, endTime: number): DetectedMoment {
  return { id, effectType: "zoom", startTime, endTime } as unknown as DetectedMoment;
}

test("P1. outside any cut, there is nothing to skip", () => {
  const moments = [cut("c1", 10, 12)];
  assert.equal(cutSkipTarget(moments, 5), null);
  assert.equal(cutSkipTarget(moments, 12), null, "the end boundary is already outside");
  assert.equal(cutSkipTarget(moments, 30), null);
  assert.equal(cutSkipTarget([], 5), null);
  assert.equal(cutSkipTarget(null, 5), null);
});

test("P2. THE BUG: the target lands strictly PAST the cut, never on its edge", () => {
  const moments = [cut("c1", 10, 12)];
  const target = cutSkipTarget(moments, 11)!;

  assert.ok(target > 12, `must clear the boundary (got ${target})`);
  assert.equal(
    activeCutAt(moments, target),
    null,
    "landing here must not re-trigger the skip — that re-trigger IS the stutter"
  );
});

test("P3. a run of adjacent cuts is ONE jump, not one per cut", () => {
  // Three cuts butted together. Seeking to the first one's end lands inside the
  // second, and so on — the old code paid a full seek + rebuffer for each.
  const moments = [cut("c1", 10, 12), cut("c2", 12, 14), cut("c3", 14, 16)];
  const target = cutSkipTarget(moments, 11)!;

  assert.ok(target > 16, `must clear ALL three (got ${target})`);
  assert.equal(activeCutAt(moments, target), null);
});

test("P3b. overlapping cuts are cleared too, in any order", () => {
  const moments = [cut("c2", 11, 20), cut("c1", 10, 12), cut("c3", 19.5, 25)];
  const target = cutSkipTarget(moments, 10.5)!;

  assert.ok(target > 25, `must clear the whole overlapping run (got ${target})`);
  assert.equal(activeCutAt(moments, target), null);
});

test("P4. the target never runs past the end of the video", () => {
  const DURATION = 20;
  const moments = [cut("c1", 18, 20)];
  const target = cutSkipTarget(moments, 19, DURATION)!;

  assert.ok(target <= DURATION, `must not seek past the end (got ${target})`);
});

test("P5. restored and disabled cuts are not skipped", () => {
  // A restored cut (`active: false`) plays normally — skipping it would silently
  // remove footage the user explicitly put back.
  assert.equal(cutSkipTarget([cut("c1", 10, 12, false)], 11), null);

  const disabled = { ...cut("c1", 10, 12), enabled: false } as DetectedMoment;
  assert.equal(isActiveCut(disabled), false);
  assert.equal(cutSkipTarget([disabled], 11), null);
});

test("P6. non-cut edits are never skipped", () => {
  // A zoom covering the playhead must not move it. If this ever regressed the
  // preview would fast-forward through every zoom in the project.
  assert.equal(cutSkipTarget([zoom("z1", 10, 12)], 11), null);
});

test("P7. the skip is idempotent — applying it twice changes nothing", () => {
  // This is the stutter property stated directly: once you have jumped out of a
  // cut, jumping again must be a no-op. A non-null second result would mean the
  // rAF loop seeks forever.
  const moments = [cut("c1", 10, 12), cut("c2", 12, 14), cut("c3", 30, 31)];
  const first = cutSkipTarget(moments, 10.01)!;
  assert.equal(cutSkipTarget(moments, first), null, "second application is a no-op");
});

test("P8. every instant inside a cut resolves outside it", () => {
  // Sweep the whole cut rather than testing one convenient point — keyframe
  // snapping means the playhead can enter a cut anywhere.
  const moments = [cut("c1", 10, 12), cut("c2", 12, 13.5)];
  for (let t = 10; t < 13.5; t += 0.05) {
    const target = cutSkipTarget(moments, t);
    assert.ok(target !== null, `t=${t.toFixed(2)} is inside a cut`);
    assert.equal(
      activeCutAt(moments, target!),
      null,
      `t=${t.toFixed(2)} → ${target!.toFixed(4)} must be outside every cut`
    );
  }
});
