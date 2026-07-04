/**
 * Timeline LANE model — locks the per-type lane split that replaced the single
 * "Overlays" lane. Every edit type routes to its own lane, grouped into
 * collapsible sections; old projects (unified overlay storage) load into the
 * correct new lanes purely by effectType (no migration).
 *
 * Run with:  npm test   (node --test, native TS strip).
 * `laneModel.ts` uses only type-only imports, so it loads via a relative path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  laneForEffectType,
  planTimelineLanes,
  LANE_DEFS,
  EFFECT_TO_LANE,
  type LaneId,
  type PlannedGroup,
} from "../src/components/dashboard/real-editor/timeline/laneModel.ts";

let seq = 0;
/** Minimal moment — the lane model only reads `effectType` (+ `enabled`). */
function mom(effectType: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `m${seq}`,
    effectType,
    startTime: 0,
    endTime: 1,
    label: "",
    reason: "",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    ...extra,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function group(plan: PlannedGroup[], id: string) {
  return plan.find((g) => g.def.id === id);
}
function laneIds(plan: PlannedGroup[], groupId: string): LaneId[] {
  return (group(plan, groupId)?.lanes ?? []).map((l) => l.def.id);
}
function lane(plan: PlannedGroup[], laneId: LaneId) {
  for (const g of plan) {
    const l = g.lanes.find((x) => x.def.id === laneId);
    if (l) return l;
  }
  return undefined;
}

test("laneForEffectType routes EVERY effect type to its own lane", () => {
  const expected: Record<string, LaneId> = {
    zoom: "camera",
    "click-highlight": "camera",
    "cursor-focus": "camera",
    cut: "cut",
    "speed-up": "speed",
    crop: "smart-crop",
    captions: "captions",
    "hook-text": "hook-text",
    "text-overlay": "text-overlay",
    "smart-crop": "smart-crop",
    callout: "callout",
    "blur-redaction": "blur-redaction",
    transition: "transition",
    "branding-cta": "branding-cta",
  };
  for (const [effect, laneId] of Object.entries(expected)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(laneForEffectType(effect as any), laneId, `${effect} → ${laneId}`);
  }
  // The static map is exhaustive over the schema union (compile-time guarantee).
  assert.deepEqual(
    new Set(Object.keys(EFFECT_TO_LANE)),
    new Set(Object.keys(expected)),
    "EFFECT_TO_LANE covers exactly the known effect types"
  );
});

test("each overlay type lands in its OWN lane — there is NO single 'Overlays' lane", () => {
  const plan = planTimelineLanes([
    mom("zoom"),
    mom("captions"),
    mom("hook-text"),
    mom("text-overlay"),
    mom("callout"),
    mom("branding-cta"),
    mom("transition"),
    mom("smart-crop"),
  ]);
  // No lane (or group) is a generic "overlays" bucket.
  assert.ok(!LANE_DEFS.some((l) => l.id === ("overlays" as LaneId)), "no generic overlays lane def");
  for (const g of plan) {
    assert.ok(!g.lanes.some((l) => (l.def.id as string) === "overlays"), "no overlays lane in plan");
  }
  // Captions / hook / text / callout / CTA each get a distinct lane.
  assert.equal(lane(plan, "captions")?.count, 1);
  assert.equal(lane(plan, "hook-text")?.count, 1);
  assert.equal(lane(plan, "text-overlay")?.count, 1);
  assert.equal(lane(plan, "callout")?.count, 1);
  assert.equal(lane(plan, "branding-cta")?.count, 1);
  // Transitions live under Pacing; captions/hook/text/callout/CTA under Visual
  // overlays; smart crop under Canvas.
  assert.ok(laneIds(plan, "pacing").includes("transition"), "transition under Pacing");
  assert.ok(laneIds(plan, "overlays").includes("captions"), "captions under Visual overlays");
  assert.ok(laneIds(plan, "canvas").includes("smart-crop"), "smart crop under Canvas");
});

test("smart crop (and legacy crop) go to the Smart crop / Canvas lane", () => {
  const plan = planTimelineLanes([mom("zoom"), mom("smart-crop"), mom("crop")]);
  const canvas = group(plan, "canvas");
  assert.ok(canvas, "Canvas group present");
  assert.deepEqual(laneIds(plan, "canvas"), ["smart-crop"]);
  assert.equal(lane(plan, "smart-crop")?.count, 2, "smart-crop + legacy crop share the Canvas lane");
});

test("Blur lane appears ONLY when blur moments exist", () => {
  const without = planTimelineLanes([mom("zoom"), mom("captions")]);
  assert.equal(lane(without, "blur-redaction"), undefined, "no blur lane without blur moments");

  const withBlur = planTimelineLanes([mom("zoom"), mom("blur-redaction")]);
  assert.equal(lane(withBlur, "blur-redaction")?.count, 1, "blur lane shows when blur exists");
});

test("core lanes (camera / cut / speed) always show — even empty", () => {
  const plan = planTimelineLanes([]);
  assert.deepEqual(laneIds(plan, "camera"), ["camera"]);
  assert.deepEqual(laneIds(plan, "pacing"), ["cut", "speed"], "cut + speed core lanes, transitions hidden when empty");
  // Empty overlay/canvas groups are dropped entirely (no wall of empty rows).
  assert.equal(group(plan, "overlays"), undefined);
  assert.equal(group(plan, "canvas"), undefined);
});

test("old unified-overlay projects load into the distinct new lanes", () => {
  // A project analyzed before per-type lanes: all overlay types in one array.
  const legacy = [
    mom("captions"),
    mom("captions"),
    mom("hook-text"),
    mom("text-overlay"),
    mom("callout"),
    mom("branding-cta"),
    mom("smart-crop"),
  ];
  const plan = planTimelineLanes(legacy);
  // They spread across ≥5 distinct overlay/canvas lanes, not one.
  const overlayLaneCount = laneIds(plan, "overlays").length + laneIds(plan, "canvas").length;
  assert.ok(overlayLaneCount >= 6, `expected ≥6 distinct overlay/canvas lanes, got ${overlayLaneCount}`);
  assert.equal(lane(plan, "captions")?.count, 2, "both caption moments land in the Captions lane");
});

test("a disabled overlay still routes to its correct lane (kept, shown dimmed by the pill)", () => {
  const plan = planTimelineLanes([mom("zoom"), mom("captions", { enabled: false })]);
  const captions = lane(plan, "captions");
  assert.equal(captions?.count, 1, "disabled caption still appears in the Captions lane");
  assert.equal(captions?.moments[0].enabled, false, "its disabled flag is preserved for the pill to dim");
});

test("lanes are grouped Camera / Pacing / Visual overlays / Canvas in order", () => {
  const plan = planTimelineLanes([
    mom("zoom"),
    mom("cut"),
    mom("transition"),
    mom("captions"),
    mom("smart-crop"),
  ]);
  assert.deepEqual(
    plan.map((g) => g.def.id),
    ["camera", "pacing", "overlays", "canvas"],
    "group order top-to-bottom"
  );
});
