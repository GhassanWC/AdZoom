/**
 * Preview playback — smart rebuffering decisions.
 *
 * The bug these lock down presented as "the video stops, freezes, continues,
 * then stops again" while reviewing edits on the web. It was genuine network
 * buffering, made worse by the browser's default recovery: it resumes the
 * instant it has a few frames, drains them, and stalls again — a thrash the
 * user reads as a broken editor. The fix holds playback through an underrun
 * until a REAL buffer builds, then resumes once (see buffer-health.ts and
 * RealVideoPlayer's useSmartBuffering).
 *
 * These tests pin the decision logic:
 *   1. `bufferedAheadSeconds` measures only CONTIGUOUS runway ahead of t
 *      (joining keyframe-rounded near-touching ranges, never jumping gaps).
 *   2. A hold starts only on a genuinely thin buffer (hysteresis below the
 *      resume goal), and never in the tail where nothing more is coming.
 *   3. The resume goal scales with playbackRate (speed sections drain faster)
 *      and caps at the time remaining.
 *   4. A trickling connection eventually force-resumes; a dead one does not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bufferedAheadSeconds,
  canResume,
  FORCE_RESUME_MIN_S,
  HOLD_LOW_WATER_S,
  HOLD_MAX_MS,
  REBUFFER_GOAL_S,
  resumeGoalSeconds,
  shouldForceResume,
  shouldHold,
  type BufferedRangesLike,
} from "../src/lib/timeline/buffer-health.ts";

/** Build a TimeRanges-alike from [start, end] pairs. */
function ranges(...pairs: Array<[number, number]>): BufferedRangesLike {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i][0],
    end: (i: number) => pairs[i][1],
  };
}

// ── bufferedAheadSeconds ────────────────────────────────────────────────────

test("ahead: inside a single range", () => {
  assert.equal(bufferedAheadSeconds(ranges([0, 10]), 4), 6);
});

test("ahead: zero when t is not buffered at all", () => {
  assert.equal(bufferedAheadSeconds(ranges([10, 20]), 4), 0);
  assert.equal(bufferedAheadSeconds(ranges(), 4), 0);
  assert.equal(bufferedAheadSeconds(null, 4), 0);
});

test("ahead: t at the exact range start counts (currentTime sits on edges)", () => {
  assert.equal(bufferedAheadSeconds(ranges([4, 10]), 4), 6);
});

test("ahead: near-touching ranges chain (keyframe rounding splits one load)", () => {
  // 0.05s gap — the browser reporting one continuous load as two ranges.
  assert.equal(bufferedAheadSeconds(ranges([0, 10], [10.05, 20]), 4), 16);
});

test("ahead: a REAL gap stops the runway", () => {
  // 5s hole between ranges: the runway ends at 10, whatever lies beyond.
  assert.equal(bufferedAheadSeconds(ranges([0, 10], [15, 30]), 4), 6);
});

test("ahead: unsorted ranges still chain (order is not assumed)", () => {
  assert.equal(bufferedAheadSeconds(ranges([10.05, 20], [0, 10]), 4), 16);
});

// ── shouldHold ──────────────────────────────────────────────────────────────

test("hold: a genuine underrun (nothing ahead) holds", () => {
  assert.equal(shouldHold(0, 300), true);
});

test("hold: a transient waiting with runway does NOT hold (hysteresis)", () => {
  // Plenty buffered — some browsers fire `waiting` mid-seek anyway.
  assert.equal(shouldHold(HOLD_LOW_WATER_S + 0.1, 300), false);
});

test("hold: never in the tail where nothing more is coming", () => {
  // 0.4s of video left, 0.4s buffered: everything left is already here.
  assert.equal(shouldHold(0.4, 0.4), false);
  assert.equal(shouldHold(0, 0), false);
});

// ── resumeGoalSeconds / canResume ───────────────────────────────────────────

test("resume goal: base at 1×, scaled by playbackRate", () => {
  assert.equal(resumeGoalSeconds(1, 300), REBUFFER_GOAL_S);
  assert.equal(resumeGoalSeconds(2, 300), REBUFFER_GOAL_S * 2);
});

test("resume goal: slow-motion never shrinks it below the base", () => {
  assert.equal(resumeGoalSeconds(0.5, 300), REBUFFER_GOAL_S);
});

test("resume goal: capped by the time remaining (end of video)", () => {
  const goal = resumeGoalSeconds(1, 1);
  assert.ok(goal < 1, `goal ${goal} must be under the 1s remaining`);
  // ...so buffering the whole tail resumes even though it's under the base goal.
  assert.equal(canResume(1, goal), true);
});

test("resume: at the goal resumes, under it keeps holding", () => {
  assert.equal(canResume(REBUFFER_GOAL_S, REBUFFER_GOAL_S), true);
  assert.equal(canResume(REBUFFER_GOAL_S - 0.1, REBUFFER_GOAL_S), false);
});

test("hysteresis: the hold trigger sits well below the resume goal", () => {
  // If these ever cross, the hold begins and instantly resumes — the thrash
  // this system exists to remove, reintroduced by configuration.
  assert.ok(HOLD_LOW_WATER_S < REBUFFER_GOAL_S / 2);
});

// ── shouldForceResume ───────────────────────────────────────────────────────

test("force-resume: a trickle that never reaches the goal eventually plays", () => {
  assert.equal(shouldForceResume(HOLD_MAX_MS, FORCE_RESUME_MIN_S), true);
});

test("force-resume: never before the deadline, never with an empty buffer", () => {
  assert.equal(shouldForceResume(HOLD_MAX_MS - 1, 10), false);
  // A dead connection keeps the (honest) spinner rather than playing 0 frames.
  assert.equal(shouldForceResume(HOLD_MAX_MS * 2, 0), false);
});
