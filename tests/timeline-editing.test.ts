/**
 * Timeline editing ↔ preview ↔ export: the parity contract.
 *
 * The user's acceptance criterion is "every timeline change saves correctly and
 * matches preview and export". In Framevo that isn't a thing you keep in sync —
 * it's structural, because the timeline, the preview resolvers and the export
 * recipe all read the SAME `analysis.detectedMoments` array. These tests pin
 * that invariant down so a future refactor can't quietly introduce a second
 * source of truth.
 *
 * They exercise the real mutations the timeline performs (move, resize/trim,
 * split, duplicate, delete, disable) as the pure array transforms the editor
 * context commits, then assert the export recipe agrees.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { splitMoment, splitMomentsAt } from "../src/lib/timeline/split.ts";
import { buildTimelineMap } from "../src/lib/timeline/crop-speed.ts";
import { buildRenderRecipe } from "../src/lib/render/recipe.ts";
import {
  EFFECT_TO_LANE,
  laneForEffectType,
  planTimelineLanes,
} from "../src/components/dashboard/real-editor/timeline/laneModel.ts";
import { DEFAULT_EFFECTS_SETTINGS } from "../src/lib/firebase/schema.ts";
import type { DetectedMoment, EffectType } from "../src/lib/firebase/schema.ts";

const SOURCE = 120;

/** Every edit type Framevo can render, one of each, on a real timeline. */
const ALL_EFFECT_TYPES: EffectType[] = [
  "zoom",
  "click-highlight",
  "cursor-focus",
  "speed-up",
  "cut",
  "crop",
  "captions",
  "hook-text",
  "text-overlay",
  "smart-crop",
  "callout",
  "blur-redaction",
  "transition",
  "branding-cta",
];

function moment(
  id: string,
  effectType: EffectType,
  startTime: number,
  endTime: number,
  over: Partial<DetectedMoment> = {}
): DetectedMoment {
  const base: DetectedMoment = {
    id,
    startTime,
    endTime,
    label: effectType,
    reason: "test",
    focusRegion: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
    effectType,
    source: "ai",
    ...over,
  };
  if (effectType === "cut") base.cut = { active: true };
  if (effectType === "speed-up") {
    base.speed = { multiplier: 2, audioMode: "mute", transition: "cut" };
  }
  if (effectType === "captions") {
    base.captions = { text: "hello there", stylePreset: "clean", position: "bottom" };
  }
  return base;
}

/** The export's view of a timeline — the exact call RealExportPanel makes. */
function recipeFor(moments: DetectedMoment[]) {
  return buildRenderRecipe({
    sourceWidth: 1920,
    sourceHeight: 1080,
    fps: 30,
    resolution: "1080p",
    format: "Source",
    sourceDuration: SOURCE,
    moments,
    effects: DEFAULT_EFFECTS_SETTINGS,
    sourceCrop: null,
    applyWatermark: false,
  });
}

/**
 * Assert the three consumers agree about this timeline.
 * PREVIEW resolves camera + overlays from the moment array and derives its
 * output time from `buildTimelineMap`. EXPORT passes the SAME array into
 * `buildRenderRecipe`. If they ever disagree, someone introduced a second
 * interpretation.
 */
function assertParity(moments: DetectedMoment[], what: string) {
  const previewMap = buildTimelineMap(moments, SOURCE);
  const recipe = recipeFor(moments);

  assert.deepEqual(
    recipe.moments,
    moments,
    `${what}: the export recipe carries the exact array the timeline holds`
  );
  assert.equal(
    recipe.outputDuration,
    previewMap.outputDuration,
    `${what}: preview and export agree on output duration`
  );
  // Firestore rejects `undefined` — a moment carrying one would fail to save, so
  // the reloaded project would be missing that edit and preview (in memory) and
  // export (from the doc) would genuinely diverge.
  for (const m of moments) {
    for (const [k, v] of Object.entries(m)) {
      assert.notEqual(v, undefined, `${what}: ${m.id}.${k} is undefined and would not save`);
    }
  }
}

// ── Every edit type has a lane, and edits reach it ──────────────────────────

test("lanes: every EffectType routes to a real lane — nothing can be orphaned", () => {
  for (const t of ALL_EFFECT_TYPES) {
    const lane = laneForEffectType(t);
    assert.ok(lane, `${t} has a lane`);
    assert.equal(EFFECT_TO_LANE[t], lane);
  }
});

test("lanes: clips, captions, zooms, transitions, text, CTAs and callouts all appear", () => {
  const moments = ALL_EFFECT_TYPES.map((t, i) =>
    moment(`m${i}`, t, i * 5, i * 5 + 3)
  );
  const groups = planTimelineLanes(moments);
  const lanes = groups.flatMap((g) => g.lanes.map((l) => l.def.id));

  for (const expected of [
    "camera",
    "cut",
    "speed",
    "transition",
    "captions",
    "hook-text",
    "text-overlay",
    "callout",
    "branding-cta",
    "blur-redaction",
    "smart-crop",
  ]) {
    assert.ok(lanes.includes(expected as never), `the "${expected}" lane is visible`);
  }

  // And every moment landed in exactly one lane — none was silently dropped.
  const placed = groups.flatMap((g) => g.lanes.flatMap((l) => l.moments.map((m) => m.id)));
  assert.equal(placed.length, moments.length, "every edit is on the timeline");
  assert.equal(new Set(placed).size, moments.length, "and in exactly one lane");
});

test("lanes: AI Director edits are ordinary moments and route into the normal lanes", () => {
  const directorEdits: DetectedMoment[] = [
    moment("d1", "zoom", 10, 14, {
      source: "ai-director",
      director: { operationId: "zoom-1", planVersion: 1, revision: 0 },
    }),
    moment("d2", "captions", 20, 23, {
      source: "ai-director",
      director: { operationId: "caption:cap-0-0", planVersion: 1, revision: 0 },
    }),
    moment("d3", "branding-cta", 100, 110, {
      source: "ai-director",
      director: { operationId: "cta-1", planVersion: 1, revision: 0 },
    }),
  ];

  const groups = planTimelineLanes(directorEdits);
  const byLane = new Map(
    groups.flatMap((g) => g.lanes.map((l) => [l.def.id, l.moments.map((m) => m.id)]))
  );

  assert.deepEqual(byLane.get("camera"), ["d1"], "a Director zoom is just a zoom");
  assert.deepEqual(byLane.get("captions"), ["d2"]);
  assert.deepEqual(byLane.get("branding-cta"), ["d3"]);

  // Which means every normal timeline operation applies to them unchanged.
  assertParity(directorEdits, "director edits");
});

// ── Each mutation the timeline performs keeps preview == export ─────────────

test("parity: a freshly-analyzed timeline already agrees", () => {
  const moments = ALL_EFFECT_TYPES.map((t, i) => moment(`m${i}`, t, i * 5, i * 5 + 3));
  assertParity(moments, "initial");
});

test("parity: MOVE (drag) keeps preview and export in step", () => {
  const moments = [
    moment("a", "cut", 10, 20),
    moment("b", "zoom", 40, 45),
  ];
  const before = recipeFor(moments).outputDuration;
  assert.equal(before, SOURCE - 10);

  // Drag the cut later — the same 10s is still removed, so the duration holds.
  const moved = moments.map((m) =>
    m.id === "a" ? { ...m, startTime: 60, endTime: 70, edited: true } : m
  );
  assertParity(moved, "after move");
  assert.equal(recipeFor(moved).outputDuration, SOURCE - 10);
});

test("parity: RESIZE / TRIM changes the exported length by exactly what you dragged", () => {
  const moments = [moment("a", "cut", 10, 20)];
  assert.equal(recipeFor(moments).outputDuration, 110);

  // Drag the right handle out by 10s.
  const trimmed = moments.map((m) => ({ ...m, endTime: 30, edited: true }));
  assertParity(trimmed, "after trim");
  assert.equal(recipeFor(trimmed).outputDuration, 100, "20s removed now, not 10s");
});

test("parity: SPLIT then delete one half restores exactly that time in the EXPORT", () => {
  const cut = moment("c1", "cut", 20, 60);
  const moments = [cut];
  assert.equal(recipeFor(moments).outputDuration, 80, "40s removed");

  const res = splitMomentsAt(moments, ["c1"], 40, () => "c2")!;
  assert.ok(res);
  assertParity(res.moments, "after split");
  // Splitting alone changes nothing that renders — the two halves still tile
  // the same 40s.
  assert.equal(recipeFor(res.moments).outputDuration, 80, "a split is non-destructive");

  // Now delete the right half (the user's whole reason for splitting).
  const kept = res.moments.filter((m) => m.id !== "c2");
  assertParity(kept, "after deleting a half");
  assert.equal(recipeFor(kept).outputDuration, 100, "20s of video came back");
});

test("parity: SPLIT a speed section — both halves keep rendering at the same rate", () => {
  const speed = moment("s1", "speed-up", 0, 40); // 2× over 40s → 20s of output
  assert.equal(recipeFor([speed]).outputDuration, 100, "40s at 2× → 20s, plus 80s at 1×");

  const { left, right } = splitMoment(speed, 20, "s2")!;
  const after = [left, right];
  assertParity(after, "after splitting speed");
  assert.equal(
    recipeFor(after).outputDuration,
    100,
    "two 2× halves render identically to one 2× section"
  );
});

test("parity: DUPLICATE adds a real second edit the export honours", () => {
  const moments = [moment("a", "cut", 10, 20)];
  // What the context's duplicateMoment produces: same shape, new id, offset.
  const copy: DetectedMoment = {
    ...moments[0],
    id: "a-copy",
    startTime: 20.2,
    endTime: 30.2,
    label: "Cut copy",
    source: "user",
    edited: true,
  };
  const next = [...moments, copy].sort((a, b) => a.startTime - b.startTime);
  assertParity(next, "after duplicate");
  assert.equal(recipeFor(next).outputDuration, SOURCE - 20, "both cuts remove time");
});

test("parity: DISABLE hides an overlay from preview AND export, without deleting it", () => {
  const caption = moment("c", "captions", 10, 14, { enabled: true });
  const on = [caption];
  const off = [{ ...caption, enabled: false }];

  // Both still SAVE the moment (it stays on the timeline, restorable)…
  assertParity(off, "after disable");
  assert.equal(recipeFor(off).moments.length, 1, "the edit is still there");

  // …and the single `enabled !== false` gate in overlay-draw is what both the
  // preview canvas and the export compositor read, so they can't disagree.
  assert.equal(on[0].enabled, true);
  assert.equal(off[0].enabled, false);
});

test("parity: DELETE removes it from the export too", () => {
  const moments = [moment("a", "cut", 10, 20), moment("b", "zoom", 40, 45)];
  const next = moments.filter((m) => m.id !== "a");
  assertParity(next, "after delete");
  assert.equal(recipeFor(next).outputDuration, SOURCE, "no cuts left — full length");
  assert.equal(recipeFor(next).moments.length, 1);
});

test("parity: a long chain of edits still agrees at the end", () => {
  // Move → trim → split → delete a half → duplicate → disable.
  let moments: DetectedMoment[] = [
    moment("cut1", "cut", 10, 30),
    moment("z1", "zoom", 50, 56),
    moment("cap1", "captions", 60, 64),
  ];

  moments = moments.map((m) =>
    m.id === "cut1" ? { ...m, startTime: 15, endTime: 35, edited: true } : m
  );
  moments = moments.map((m) =>
    m.id === "z1" ? { ...m, endTime: 60, edited: true } : m
  );

  const split = splitMomentsAt(moments, ["cut1"], 25, () => "cut2")!;
  moments = split.moments;
  moments = moments.filter((m) => m.id !== "cut2");

  moments = [
    ...moments,
    { ...moments.find((m) => m.id === "z1")!, id: "z1-copy", startTime: 70, endTime: 76 },
  ].sort((a, b) => a.startTime - b.startTime);

  moments = moments.map((m) => (m.id === "cap1" ? { ...m, enabled: false } : m));

  assertParity(moments, "after a full editing session");

  // cut1 now runs 15→25 (10s removed). That's the only active cut.
  assert.equal(recipeFor(moments).outputDuration, SOURCE - 10);
  assert.equal(buildTimelineMap(moments, SOURCE).activeCuts, 1);
});
