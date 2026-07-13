/**
 * Timeline split — the contract.
 *
 * The two things that make splitting non-trivial, and that a naive
 * "copy the moment and move the edges" implementation gets silently wrong:
 *
 *   • keyframes are RELATIVE (t: 0..1 within the moment), so copying them into
 *     both halves would re-time every camera move
 *   • captions carry real ASR word timings, so the words must follow the audio
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_SPLIT_LEN,
  canSplit,
  splitBlockedMessage,
  splitMoment,
  splitMomentsAt,
  splitReason,
} from "../src/lib/timeline/split.ts";
import { buildTimelineMap } from "../src/lib/timeline/crop-speed.ts";
import type { DetectedMoment } from "../src/lib/firebase/schema.ts";

function zoom(over: Partial<DetectedMoment> = {}): DetectedMoment {
  return {
    id: "z1",
    startTime: 10,
    endTime: 20,
    label: "Zoom",
    reason: "test",
    focusRegion: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
    effectType: "zoom",
    intensity: 0.7,
    source: "ai",
    ...over,
  };
}

// ── Guards ──────────────────────────────────────────────────────────────────

test("split: refuses a point outside the moment", () => {
  const m = zoom();
  assert.equal(splitReason(m, 5), "outside");
  assert.equal(splitReason(m, 25), "outside");
  assert.equal(splitReason(m, 10), "outside", "the start edge is not a split");
  assert.equal(splitReason(m, 20), "outside", "the end edge is not a split");
  assert.equal(splitMoment(m, 5, "new"), null);
});

test("split: refuses to make a half shorter than the minimum", () => {
  const m = zoom({ startTime: 10, endTime: 20 });
  assert.equal(splitReason(m, 10.1), "left-too-short");
  assert.equal(splitReason(m, 19.9), "right-too-short");
  assert.equal(canSplit(m, 10 + MIN_SPLIT_LEN), true, "exactly at the minimum is fine");
  // And the block is explained, not silent.
  assert.match(splitBlockedMessage("left-too-short"), /0\.3s/);
  assert.match(splitBlockedMessage("outside"), /playhead/i);
});

// ── The basics ──────────────────────────────────────────────────────────────

test("split: produces two abutting halves that exactly tile the original", () => {
  const m = zoom({ startTime: 10, endTime: 20 });
  const { left, right } = splitMoment(m, 14, "z2")!;

  assert.equal(left.startTime, 10);
  assert.equal(left.endTime, 14);
  assert.equal(right.startTime, 14);
  assert.equal(right.endTime, 20);
  assert.equal(left.endTime, right.startTime, "no gap, no overlap");

  assert.equal(left.id, "z1", "the LEFT half keeps the id — selection stays valid");
  assert.equal(right.id, "z2");

  assert.equal(left.edited, true, "a split is a user decision and must survive re-analysis");
  assert.equal(right.edited, true);
});

test("split: shared settings are copied to both halves verbatim", () => {
  const m = zoom({
    effectType: "speed-up",
    speed: { multiplier: 2.5, audioMode: "mute", transition: "cut" },
    startTime: 0,
    endTime: 10,
  });
  const { left, right } = splitMoment(m, 4, "s2")!;
  assert.deepEqual(left.speed, m.speed);
  assert.deepEqual(right.speed, m.speed);
  assert.equal(left.effectType, "speed-up");
  assert.equal(right.effectType, "speed-up");
});

test("split: an AI Director edit keeps its plan back-link on both halves", () => {
  const m = zoom({
    source: "ai-director",
    director: { operationId: "zoom-3", planVersion: 1, revision: 0 },
  });
  const { left, right } = splitMoment(m, 15, "z2")!;
  assert.equal(left.source, "ai-director");
  assert.equal(right.source, "ai-director");
  assert.deepEqual(left.director, m.director, "still traceable to the plan");
  assert.deepEqual(right.director, m.director);
});

// ── Keyframes: the thing a naive split gets wrong ───────────────────────────

test("split: keyframes are re-normalized into each half, not duplicated", () => {
  // A 10s zoom (10→20) with a camera path at 0%, 50%, 100% — i.e. 10s, 15s, 20s.
  const m = zoom({
    startTime: 10,
    endTime: 20,
    keyframes: [
      { t: 0, x: 0.1, y: 0.1, scale: 0.2 },
      { t: 0.5, x: 0.5, y: 0.5, scale: 0.6 },
      { t: 1, x: 0.9, y: 0.9, scale: 1 },
    ],
  });

  // Split at 15s — exactly on the middle keyframe.
  const { left, right } = splitMoment(m, 15, "z2")!;

  // LEFT is 10→15. The 10s keyframe is at t=0, the 15s one at t=1.
  assert.deepEqual(
    left.keyframes!.map((k) => k.t),
    [0, 1],
    "left keyframes re-normalized to its own 0..1 span"
  );
  assert.equal(left.keyframes![0].scale, 0.2);
  assert.equal(left.keyframes![1].scale, 0.6);

  // RIGHT is 15→20. The 15s keyframe is at t=0, the 20s one at t=1.
  assert.deepEqual(right.keyframes!.map((k) => k.t), [0, 1]);
  assert.equal(right.keyframes![0].scale, 0.6);
  assert.equal(right.keyframes![1].scale, 1);

  // The boundary keyframe is in BOTH — dropping it from either side would make
  // the camera jump at the cut.
  assert.equal(left.keyframes![1].scale, right.keyframes![0].scale);
});

test("split: keyframes land in the correct half when the split is off-centre", () => {
  // Keyframes at t=0.1 (11s), t=0.9 (19s) on a 10→20 zoom.
  const m = zoom({
    startTime: 10,
    endTime: 20,
    keyframes: [
      { t: 0.1, x: 0.1, y: 0.1, scale: 0.2 },
      { t: 0.9, x: 0.9, y: 0.9, scale: 0.9 },
    ],
  });

  const { left, right } = splitMoment(m, 12, "z2")!; // left = 10→12, right = 12→20

  assert.equal(left.keyframes!.length, 1, "only the 11s keyframe is in the left half");
  // 11s in a 10→12 span = t 0.5.
  assert.ok(Math.abs(left.keyframes![0].t - 0.5) < 1e-6);

  assert.equal(right.keyframes!.length, 1, "only the 19s keyframe is in the right half");
  // 19s in a 12→20 span = t 0.875.
  assert.ok(Math.abs(right.keyframes![0].t - 0.875) < 1e-6);
});

test("split: a half with no keyframes drops the array entirely", () => {
  const m = zoom({
    startTime: 10,
    endTime: 20,
    keyframes: [{ t: 0.1, x: 0.1, y: 0.1, scale: 0.2 }], // 11s only
  });
  const { left, right } = splitMoment(m, 15, "z2")!;
  assert.equal(left.keyframes!.length, 1);
  assert.equal(
    "keyframes" in right,
    false,
    "the right half has no keyframes and carries no empty array"
  );
});

// ── Captions: the words must follow the audio ───────────────────────────────

test("split: caption words are partitioned by their REAL timings", () => {
  const m: DetectedMoment = {
    id: "c1",
    startTime: 10,
    endTime: 14,
    label: "Caption",
    reason: "",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType: "captions",
    captions: {
      text: "click the upgrade button now",
      stylePreset: "clean",
      position: "bottom",
      words: [
        { text: "click", start: 10.0, end: 10.5 },
        { text: "the", start: 10.5, end: 10.8 },
        { text: "upgrade", start: 10.8, end: 11.6 },
        { text: "button", start: 12.4, end: 13.0 },
        { text: "now", start: 13.0, end: 13.6 },
      ],
    },
  };

  const { left, right } = splitMoment(m, 12, "c2")!;

  assert.equal(left.captions!.text, "click the upgrade");
  assert.equal(right.captions!.text, "button now");

  assert.deepEqual(
    left.captions!.words!.map((w) => w.text),
    ["click", "the", "upgrade"]
  );
  assert.deepEqual(
    right.captions!.words!.map((w) => w.text),
    ["button", "now"]
  );

  // No word is torn in two or duplicated.
  const total = left.captions!.words!.length + right.captions!.words!.length;
  assert.equal(total, 5, "every word went to exactly one half");
});

test("split: a word straddling the cut goes to the half holding its midpoint", () => {
  const m: DetectedMoment = {
    id: "c1",
    startTime: 0,
    endTime: 4,
    label: "Caption",
    reason: "",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType: "captions",
    captions: {
      text: "one straddle two",
      stylePreset: "clean",
      position: "bottom",
      words: [
        { text: "one", start: 0, end: 1 },
        // Straddles a split at 2.0 — midpoint 2.25 is on the RIGHT.
        { text: "straddle", start: 1.5, end: 3.0 },
        { text: "two", start: 3.0, end: 4.0 },
      ],
    },
  };

  const { left, right } = splitMoment(m, 2, "c2")!;
  assert.deepEqual(left.captions!.words!.map((w) => w.text), ["one"]);
  assert.deepEqual(right.captions!.words!.map((w) => w.text), ["straddle", "two"]);
});

test("split: captions with no word timings fall back to a proportional split", () => {
  const m: DetectedMoment = {
    id: "c1",
    startTime: 0,
    endTime: 10,
    label: "Caption",
    reason: "",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType: "captions",
    captions: {
      text: "one two three four",
      stylePreset: "clean",
      position: "bottom",
    },
  };

  const { left, right } = splitMoment(m, 5, "c2")!;
  assert.equal(left.captions!.text, "one two");
  assert.equal(right.captions!.text, "three four");
  assert.equal(left.captions!.words, undefined);
});

test("split: stale highlightedWords indices are dropped, not carried onto wrong words", () => {
  const m: DetectedMoment = {
    id: "c1",
    startTime: 0,
    endTime: 4,
    label: "Caption",
    reason: "",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType: "captions",
    captions: {
      text: "a b c d",
      stylePreset: "clean",
      position: "bottom",
      highlightedWords: [3],
      words: [
        { text: "a", start: 0, end: 1 },
        { text: "b", start: 1, end: 2 },
        { text: "c", start: 2, end: 3 },
        { text: "d", start: 3, end: 4 },
      ],
    },
  };
  const { left, right } = splitMoment(m, 2, "c2")!;
  assert.equal(left.captions!.highlightedWords, undefined);
  assert.equal(right.captions!.highlightedWords, undefined);
});

// ── Splitting a cut really changes the rendered timeline ────────────────────

test("split: splitting a CUT and deleting one half genuinely restores that time", () => {
  const SOURCE = 100;
  const cut: DetectedMoment = {
    id: "cut1",
    startTime: 20,
    endTime: 60,
    label: "Cut",
    reason: "dead",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType: "cut",
    cut: { active: true },
    source: "ai",
  };

  const before = buildTimelineMap([cut], SOURCE);
  assert.equal(before.outputDuration, 60, "40s removed from 100s");

  // Split at 40s, then drop the right half (40→60) — restoring 20s.
  const { left } = splitMoment(cut, 40, "cut2")!;
  const after = buildTimelineMap([left], SOURCE);

  assert.equal(after.outputDuration, 80, "only 20s is removed now");
  assert.equal(after.totalRemoved, 20);
});

// ── Batch splitting ────────────────────────────────────────────────────────

test("splitMomentsAt: splits only the targeted moments containing the playhead", () => {
  const a = zoom({ id: "a", startTime: 0, endTime: 10 });
  const b = zoom({ id: "b", startTime: 20, endTime: 30 });
  let n = 0;
  const mint = () => `new${++n}`;

  const res = splitMomentsAt([a, b], ["a", "b"], 5, mint)!;
  assert.ok(res);
  assert.equal(res.newIds.length, 1, "only `a` contains t=5");
  assert.equal(res.moments.length, 3);
  assert.deepEqual(
    res.moments.map((m) => m.id),
    ["a", "new1", "b"],
    "sorted by start time"
  );
  // `b` is untouched.
  assert.deepEqual(res.moments.find((m) => m.id === "b"), b);
});

test("splitMomentsAt: returns null when nothing was splittable (never a silent no-op)", () => {
  const a = zoom({ id: "a", startTime: 0, endTime: 10 });
  assert.equal(splitMomentsAt([a], ["a"], 50, () => "x"), null);
  // Too close to the edge to split.
  assert.equal(splitMomentsAt([a], ["a"], 0.05, () => "x"), null);
});

test("splitMomentsAt: splits several selected moments at the same playhead", () => {
  const a = zoom({ id: "a", startTime: 0, endTime: 10 });
  const b = zoom({ id: "b", startTime: 2, endTime: 12 });
  let n = 0;
  const res = splitMomentsAt([a, b], ["a", "b"], 6, () => `new${++n}`)!;
  assert.equal(res.newIds.length, 2, "both were split");
  assert.equal(res.moments.length, 4);
  for (const m of res.moments) {
    assert.ok(m.endTime > m.startTime, "no zero-length halves");
  }
});
