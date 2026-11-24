import { test } from "node:test";
import assert from "node:assert/strict";
import { changedElementIds, commandTarget, describeTimelineDiff } from "../src/lib/timeline/diff.ts";
import { momentOutputSpan, outputSpanToMomentTimes, projectMomentsToOutput } from "../src/lib/timeline/project-to-output.ts";
import type { DetectedMoment } from "../src/lib/firebase/schema.ts";
import type { Sequence } from "../src/lib/timeline/sequence.ts";

const mom = (p: Partial<DetectedMoment> & { id: string; startTime: number; endTime: number; effectType: DetectedMoment["effectType"] }): DetectedMoment =>
  ({ label: p.id, reason: "", focusRegion: { x: 0, y: 0, width: 1, height: 1 }, ...p }) as DetectedMoment;
const seq: Sequence = {
  version: 1,
  items: [
    { id: "a", kind: "clip", assetId: "source", sourceIn: 2, sourceOut: 5 },
    { id: "f", kind: "freeze", assetId: "source", sourceAt: 5, duration: 1 },
    { id: "b", kind: "clip", assetId: "B", sourceIn: 0, sourceOut: 2 },
  ],
};

test("changedElementIds names the property that changed; order changes count", () => {
  const before = { moments: [mom({ id: "t", startTime: 1, endTime: 2, effectType: "text-overlay" })], sequence: seq };
  const after = {
    moments: [mom({ id: "t", startTime: 1, endTime: 3, effectType: "text-overlay" })],
    sequence: { ...seq, items: [seq.items[1], { ...seq.items[0], speed: { keyframes: [{ at: 2, rate: 2 }] } }, seq.items[2]] } as Sequence,
  };
  const c = changedElementIds(before, after);
  assert.deepEqual(c.get("t"), ["endTime"]);
  assert.ok(c.get("a")!.includes("speed") && c.get("a")!.includes("position"));
  assert.ok(c.get("f")!.includes("position"));
  assert.equal(c.has("b"), false);
});

test("describeTimelineDiff reports the committed change, including the length delta", () => {
  const before = { moments: [], sequence: seq, sourceDuration: 12 };
  const after = { moments: [], sequence: { ...seq, items: seq.items.filter((i) => i.id !== "b") }, sourceDuration: 12 };
  const lines = describeTimelineDiff(before, after);
  assert.ok(lines.some((l) => /Removed "B" clip 0:00\.0–0:02\.0/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /Video length 0:06\.0 → 0:04\.0/.test(l)), lines.join(" | "));
  assert.deepEqual(describeTimelineDiff(before, before), []);
  assert.deepEqual(describeTimelineDiff({ moments: [], sequence: null, sourceDuration: 12 }, before)[0], "Converted the timeline to a sequence");
});

test("commandTarget identifies the element a command addresses", () => {
  assert.equal(commandTarget({ op: "capability", capability: "set_fade", args: { clip_id: "a", fade_in: 1 } }), "a");
  assert.equal(commandTarget({ op: "update_element", elementId: "t", end: 3 }), "t");
  assert.equal(commandTarget({ op: "remove_range", start: 1, end: 2 }), null);
});

test("projection: source-anchored, item-anchored and sequence-pinned moments land where they play; drags map back", () => {
  const rev = { sequence: seq, moments: [], sourceDuration: 12 };
  const cap = mom({ id: "cap", startTime: 3, endTime: 4, effectType: "captions" }); // source 3–4 → output 1–2
  const held = mom({ id: "held", startTime: 0.2, endTime: 0.8, effectType: "text-overlay", anchor: { kind: "item", itemId: "f" } }); // freeze cut at 3 → 3.2–3.8
  const pin = mom({ id: "pin", startTime: 4.5, endTime: 5.5, effectType: "graphic", anchor: { kind: "sequence" } });
  const gone = mom({ id: "gone", startTime: 8, endTime: 9, effectType: "captions" }); // footage not in the sequence
  assert.deepEqual(momentOutputSpan(rev, cap), { start: 1, end: 2, partial: false });
  assert.deepEqual(momentOutputSpan(rev, held), { start: 3.2, end: 3.8, partial: false });
  assert.deepEqual(momentOutputSpan(rev, pin), { start: 4.5, end: 5.5, partial: false });
  assert.equal(momentOutputSpan(rev, gone), null);
  const { moments, spans } = projectMomentsToOutput(rev, [cap, held, pin, gone]);
  assert.deepEqual(moments.map((m) => m.id), ["cap", "held", "pin"]);
  assert.equal(spans.size, 3);
  // Dragging the caption to output 1.5–2.5 writes source 3.5–4.5.
  assert.deepEqual(outputSpanToMomentTimes(rev, cap, 1.5, 2.5), { startTime: 3.5, endTime: 4.5 });
  // Dragging it onto the B clip (another asset) is refused.
  assert.equal(outputSpanToMomentTimes(rev, cap, 4.5, 5.5), null);
  assert.deepEqual(outputSpanToMomentTimes(rev, held, 3.4, 3.9), { startTime: 0.4, endTime: 0.9 });
});
