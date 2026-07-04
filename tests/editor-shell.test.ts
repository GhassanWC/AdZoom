/**
 * Fullscreen editor shell behaviour — the pure logic behind the editor-route
 * shell switch, the Previous/Next edit review navigation, and the
 * Before/After preview bypass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isEditorRoute,
  momentReviewOrder,
  momentReviewPosition,
  adjacentMomentId,
  applyCompareBypass,
} from "@/components/dashboard/real-editor/editor-shell-behavior";

/* ── isEditorRoute ───────────────────────────────────────────────────────── */

test("the project editor detail route gets the fullscreen shell", () => {
  assert.equal(isEditorRoute("/dashboard/projects/abc123"), true);
  assert.equal(isEditorRoute("/dashboard/projects/abc123/"), true);
});

test("all other dashboard routes keep the regular chrome", () => {
  assert.equal(isEditorRoute("/dashboard/projects"), false); // the list page
  assert.equal(isEditorRoute("/dashboard/projects/"), false);
  assert.equal(isEditorRoute("/dashboard"), false);
  assert.equal(isEditorRoute("/dashboard/exports"), false);
  assert.equal(isEditorRoute("/dashboard/projects/abc/extra"), false);
  assert.equal(isEditorRoute("/pricing"), false);
});

/* ── Review navigation ───────────────────────────────────────────────────── */

const M = (id: string, startTime: number, enabled?: boolean) => ({ id, startTime, enabled });
const moments = [M("c", 30), M("a", 10), M("b", 20), M("b2", 20)];

test("review order sorts by start time with id tiebreak, without mutating", () => {
  const input = [...moments];
  const order = momentReviewOrder(input).map((m) => m.id);
  assert.deepEqual(order, ["a", "b", "b2", "c"]);
  assert.deepEqual(input, moments); // untouched
});

test("review position is 1-based ('2 of 4') and null for unknown ids", () => {
  assert.deepEqual(momentReviewPosition(moments, "b"), { index: 2, total: 4 });
  assert.deepEqual(momentReviewPosition(moments, "a"), { index: 1, total: 4 });
  assert.equal(momentReviewPosition(moments, "nope"), null);
  assert.equal(momentReviewPosition(moments, null), null);
});

test("next/prev walk the review order and stop at the ends (no wrap)", () => {
  assert.equal(adjacentMomentId(moments, "a", "next"), "b");
  assert.equal(adjacentMomentId(moments, "b", "next"), "b2");
  assert.equal(adjacentMomentId(moments, "c", "next"), null); // last → disabled
  assert.equal(adjacentMomentId(moments, "b", "prev"), "a");
  assert.equal(adjacentMomentId(moments, "a", "prev"), null); // first → disabled
});

test("with no selection, next enters at the first edit and prev at the last", () => {
  assert.equal(adjacentMomentId(moments, null, "next"), "a");
  assert.equal(adjacentMomentId(moments, null, "prev"), "c");
  assert.equal(adjacentMomentId([], null, "next"), null);
});

/* ── Before/After bypass ─────────────────────────────────────────────────── */

test("compare bypass REMOVES only the compared moment, without mutating", () => {
  const input = [M("a", 10, true), M("b", 20)];
  const out = applyCompareBypass(input, "a");
  assert.deepEqual(out.map((m) => m.id), ["b"]); // "a" gone from preview
  assert.equal(out.find((m) => m.id === "b"), input[1]); // others untouched (same ref)
  assert.equal(input.length, 2); // original intact
});

test("no bypass (or unknown id) returns the SAME array for memo stability", () => {
  const input = [M("a", 10)];
  assert.equal(applyCompareBypass(input, null), input);
  assert.equal(applyCompareBypass(input, "ghost"), input);
});
