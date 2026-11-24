/**
 * Event targeting helpers: ordinal parsing, mark resolution (a user's pick
 * wins and is retained), and merge rules (never replace a user mark).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventQuery, resolveFromMarks, mergeMarks, candidateLabel } from "../src/lib/effects/event-marks.ts";
import type { EventMark } from "../src/lib/firebase/schema.ts";

const mark = (p: Partial<EventMark> & { time: number }): EventMark => ({ id: `m${p.time}`, query: "goal", assetId: "source", x: 0.5, y: 0.5, source: "verified", label: "", at: 1, ...p });

test("parseEventQuery strips ordinals and filler", () => {
  assert.deepEqual(parseEventQuery("the second goal"), { query: "goal", ordinal: 2 });
  assert.deepEqual(parseEventQuery("When the first goal goes in"), { query: "goal", ordinal: 1 });
  assert.deepEqual(parseEventQuery("the ball hits the net"), { query: "ball hits net" });
  assert.deepEqual(parseEventQuery("the last goal"), { query: "goal", ordinal: -1 });
  assert.equal(candidateLabel({ time: 27.2, description: "ball crosses the line" }), "0:27.2 — ball crosses the line");
});

test("resolveFromMarks: ordinal lookup, user pick wins, ambiguity without a pick is null", () => {
  const marks = [mark({ time: 13.9, ordinal: 1 }), mark({ time: 27.0, ordinal: 2 }), mark({ time: 45.3, ordinal: 3 })];
  assert.equal(resolveFromMarks(marks, "goal", 2, "source")?.time, 27.0);
  assert.equal(resolveFromMarks(marks, "goal", undefined, "source"), null, "three verified goals, no pick → not unique");
  const withPick = mergeMarks(marks, [mark({ time: 45.3, source: "user", at: 5 })]);
  assert.equal(resolveFromMarks(withPick, "goal", undefined, "source")?.time, 45.3, "the user's pick resolves the bare query");
  assert.equal(resolveFromMarks(withPick, "goal", 2, "source")?.time, 27.0, "ordinals still resolve by order");
  assert.equal(resolveFromMarks(withPick, "goal", 1, "B"), null, "other asset");
});

test("mergeMarks: same instant updates in place, a user mark is never downgraded, newest wins", () => {
  const base = [mark({ time: 45.3, source: "user", ordinal: 3, at: 5 })];
  const merged = mergeMarks(base, [mark({ time: 45.4, source: "verified", at: 9 })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "user", "verified never replaces a user pick");
  const again = mergeMarks(merged, [mark({ time: 45.0, source: "user", ordinal: 3, label: "0:45.0", at: 11 })]);
  assert.equal(again.length, 1);
  assert.equal(again[0].time, 45.0, "a newer user pick for the same ordinal replaces the old one");
  const other = mergeMarks(again, [mark({ time: 13.9, ordinal: 1 })]);
  assert.equal(other.length, 2);
});
