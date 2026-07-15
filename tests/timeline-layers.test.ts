/**
 * TIMELINE LAYERS — one show/hide switch per lane.
 *
 * The contract, in the user's words: "Disabling a layer must hide every edit
 * inside that layer from preview and export without deleting or changing the
 * individual edits. Re-enabling must restore all its edits exactly as before."
 *
 * That is a statement about DATA, not just pixels, and it is what these tests
 * pin down. Layer visibility lives in its own field (`ProjectDoc.timelineLayers`)
 * and the moments are never rewritten — so "restore exactly as before" is true by
 * construction rather than by a careful save/restore dance. The tests below prove
 * both halves: the edits DON'T change, and the render DOES.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EFFECT_TO_LAYER,
  TIMELINE_LAYER_IDS,
  hiddenLayerIds,
  isLayerVisible,
  layerForEffectType,
  normalizeLayerVisibility,
  visibleMoments,
} from "../src/lib/timeline/layers.ts";
import { buildTimelineMap } from "../src/lib/timeline/crop-speed.ts";
import { resolveCameraFrame } from "../src/lib/timeline/camera.ts";
import { activeOverlays } from "../src/lib/render/overlay-draw.ts";
import { buildRenderRecipe } from "../src/lib/render/recipe.ts";
import { materializeProject } from "../src/lib/firebase/materialize-project.ts";
import { DEFAULT_EFFECTS_SETTINGS } from "../src/lib/firebase/schema.ts";
import type {
  DetectedMoment,
  EffectType,
  LayerVisibility,
} from "../src/lib/firebase/schema.ts";

const SOURCE = 120;

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

/** A timeline with one edit in each of the layers the user named. */
function fullTimeline(): DetectedMoment[] {
  return [
    moment("z1", "zoom", 10, 16),
    moment("cut1", "cut", 20, 40), // 20s
    moment("sp1", "speed-up", 50, 70), // 20s @2× → 10s
    moment("cap1", "captions", 80, 84),
    moment("call1", "callout", 85, 88),
    moment("tr1", "transition", 90, 91),
  ];
}

/** The export's view of a timeline, after layer visibility is applied. */
function recipeFor(moments: DetectedMoment[], layers?: LayerVisibility) {
  return buildRenderRecipe({
    sourceWidth: 1920,
    sourceHeight: 1080,
    fps: 30,
    resolution: "1080p",
    format: "Source",
    sourceDuration: SOURCE,
    moments: visibleMoments(moments, layers),
    effects: DEFAULT_EFFECTS_SETTINGS,
    sourceCrop: null,
    applyWatermark: false,
  });
}

/* ── The mapping ──────────────────────────────────────────────────────────── */

test("every effect type belongs to exactly one layer", () => {
  assert.equal(layerForEffectType("zoom"), "camera");
  assert.equal(layerForEffectType("click-highlight"), "camera");
  assert.equal(layerForEffectType("cursor-focus"), "camera");
  assert.equal(layerForEffectType("cut"), "cut");
  assert.equal(layerForEffectType("speed-up"), "speed");
  assert.equal(layerForEffectType("captions"), "captions");
  assert.equal(layerForEffectType("callout"), "callout");
  assert.equal(layerForEffectType("transition"), "transition");
  // Unknown/legacy effectType falls back to camera rather than vanishing.
  assert.equal(layerForEffectType(undefined), "camera");
});

test("absent visibility means visible — an untouched project renders unchanged", () => {
  const moments = fullTimeline();
  assert.equal(isLayerVisible(undefined, "captions"), true);
  assert.equal(isLayerVisible({}, "captions"), true);
  // `true` is never stored, but honour it if some older doc has it.
  assert.equal(isLayerVisible({ captions: true }, "captions"), true);
  assert.equal(isLayerVisible({ captions: false }, "captions"), false);

  // Same ARRAY REFERENCE back when nothing is hidden — the preview's useMemo
  // depends on this not churning.
  assert.equal(visibleMoments(moments, undefined), moments);
  assert.equal(visibleMoments(moments, {}), moments);
  assert.deepEqual(hiddenLayerIds({ cut: false, captions: false }).sort(), [
    "captions",
    "cut",
  ]);
});

/* ── Hiding a layer changes the RENDER ────────────────────────────────────── */

test("hiding CUTS gives the footage back — nothing is removed from the export", () => {
  const moments = fullTimeline();
  // Enabled: the 20s cut is removed and the 20s speed section halves to 10s.
  assert.equal(recipeFor(moments).outputDuration, SOURCE - 20 - 10);

  const map = buildTimelineMap(visibleMoments(moments, { cut: false }), SOURCE);
  assert.equal(map.totalRemoved, 0, "no source time removed");
  assert.equal(map.activeCuts, 0);
  assert.equal(
    recipeFor(moments, { cut: false }).outputDuration,
    SOURCE - 10,
    "only the speed compression remains"
  );
});

test("hiding SPEED plays that range at 1×", () => {
  const moments = fullTimeline();
  const out = recipeFor(moments, { speed: false }).outputDuration;
  assert.equal(out, SOURCE - 20, "the cut still removes 20s; nothing is compressed");
  const segs = buildTimelineMap(visibleMoments(moments, { speed: false }), SOURCE).segments;
  assert.ok(
    segs.every((s) => s.speedMultiplier === 1),
    "every surviving segment plays at 1×"
  );
});

test("hiding ZOOM & FOCUS leaves the camera at identity", () => {
  const moments = fullTimeline();
  const t = 12; // inside z1

  const on = resolveCameraFrame(visibleMoments(moments, {}), t, { autoZoom: 50 });
  assert.equal(on.moment?.id, "z1", "enabled: the zoom drives the camera");

  const off = resolveCameraFrame(visibleMoments(moments, { camera: false }), t, {
    autoZoom: 50,
  });
  assert.equal(off.moment, null, "hidden: no camera moment is active");
  assert.equal(off.camera.scale, 1, "…so the camera holds identity");
});

test("hiding CAPTIONS / CALLOUTS / TRANSITIONS stops them drawing", () => {
  const moments = fullTimeline();

  // Captions + transitions draw in OUTPUT space, callouts INSIDE the camera.
  assert.equal(activeOverlays(visibleMoments(moments, {}), 82).output.length, 1);
  assert.equal(
    activeOverlays(visibleMoments(moments, { captions: false }), 82).output.length,
    0,
    "captions layer off → nothing drawn at 82s"
  );

  assert.equal(activeOverlays(visibleMoments(moments, {}), 86).inCamera.length, 1);
  assert.equal(
    activeOverlays(visibleMoments(moments, { callout: false }), 86).inCamera.length,
    0,
    "callouts layer off → nothing drawn at 86s"
  );

  assert.equal(
    activeOverlays(visibleMoments(moments, { transition: false }), 90.5).output.length,
    0,
    "transitions layer off → nothing drawn at 90.5s"
  );
});

test("hiding one layer leaves the OTHER layers untouched", () => {
  const moments = fullTimeline();
  const visible = visibleMoments(moments, { captions: false });
  assert.deepEqual(
    visible.map((m) => m.id),
    ["z1", "cut1", "sp1", "call1", "tr1"],
    "only the caption is withheld from the renderer"
  );
});

/* ── …but NOT the edits ───────────────────────────────────────────────────── */

test("hiding a layer does not delete or change a single edit", () => {
  const moments = fullTimeline();
  const before = structuredClone(moments);

  const layers: LayerVisibility = { cut: false, captions: false };
  visibleMoments(moments, layers);
  recipeFor(moments, layers);

  assert.deepEqual(moments, before, "the moment array is untouched — no writes, no flags");
  assert.equal(moments.length, 6, "nothing was deleted");
});

test("re-enabling a layer restores its edits EXACTLY — including per-edit hides", () => {
  // cap1 is hidden individually; cap2 is not. This is the case a bulk
  // `enabled: false` sweep over the lane would destroy: re-enabling the layer
  // would resurrect cap1, which the user had deliberately hidden on its own.
  const moments = [
    moment("cap1", "captions", 80, 84, { enabled: false }),
    moment("cap2", "captions", 86, 90),
    moment("cut1", "cut", 20, 40),
  ];
  const before = structuredClone(moments);

  // Hide the whole Captions layer…
  const hidden = visibleMoments(moments, { captions: false });
  assert.equal(hidden.length, 1, "no caption reaches the renderer");
  assert.equal(hidden[0].id, "cut1");

  // …and show it again.
  const restored = visibleMoments(moments, {});
  assert.deepEqual(moments, before, "the edits themselves never changed");
  assert.deepEqual(
    restored.map((m) => m.id),
    ["cap1", "cap2", "cut1"],
    "every caption is back on the render list"
  );

  // The two gates compose: cap1 is STILL individually hidden, so it still draws
  // nothing — the layer toggle didn't silently re-enable it.
  const drawn = activeOverlays(restored, 82).output;
  assert.equal(drawn.length, 0, "cap1 stays hidden by its OWN flag");
  assert.equal(activeOverlays(restored, 88).output[0]?.id, "cap2", "cap2 draws again");
});

/* ── Persistence ──────────────────────────────────────────────────────────── */

test("timelineLayers survives the Firestore round-trip (the materialize whitelist)", () => {
  // `materializeProject` is a WHITELIST: a field it doesn't list reads back as
  // undefined forever, however successfully it was written. That bug shipped once
  // already (Smart Clips), so pin this field down.
  const p = materializeProject("p1", {
    userId: "u1",
    title: "t",
    timelineLayers: { cut: false, captions: false },
  });
  assert.deepEqual(p.timelineLayers, { cut: false, captions: false });
  assert.equal(isLayerVisible(p.timelineLayers, "cut"), false);
  assert.equal(isLayerVisible(p.timelineLayers, "zoom" as "camera"), true);

  // A project written before this field existed: every layer visible.
  const legacy = materializeProject("p2", { userId: "u1", title: "t" });
  assert.equal(legacy.timelineLayers, undefined);
  assert.equal(visibleMoments(fullTimeline(), legacy.timelineLayers).length, 6);
});

test("a persisted layer map is EXPLICIT — a Firestore merge can never strand a stale hide", () => {
  // The doc is written with `merge: true`, which DEEP-MERGES maps: a write that
  // simply omits `captions` cannot remove an existing `captions: false`. So every
  // write states every layer. Without this, re-showing a layer (and undoing a
  // hide) would appear to work and then read back hidden.
  const afterHidingCaptions = normalizeLayerVisibility({ captions: false });
  assert.equal(afterHidingCaptions.captions, false);
  assert.equal(afterHidingCaptions.cut, true, "every other layer is stated, not omitted");
  assert.equal(
    Object.keys(afterHidingCaptions).length,
    TIMELINE_LAYER_IDS.length,
    "all layers present in the write"
  );

  // Re-showing writes `captions: true` — which DOES overwrite the stored false.
  const afterShowingAgain = normalizeLayerVisibility({ captions: true });
  assert.equal(afterShowingAgain.captions, true);

  // Simulate the merge Firestore would perform, to prove the stale value is gone.
  const stored = { ...afterHidingCaptions, ...afterShowingAgain };
  assert.equal(isLayerVisible(stored, "captions"), true, "the layer really came back");
  assert.deepEqual(hiddenLayerIds(stored), [], "nothing is left hidden");
});

test("the timeline lane model and the render gate share ONE effect→layer mapping", async () => {
  // If they ever forked, hiding a layer would hide a lane the user wasn't
  // looking at: the menu would toggle "Captions" while the gate withheld
  // something else.
  const { EFFECT_TO_LANE } = await import(
    "../src/components/dashboard/real-editor/timeline/laneModel.ts"
  );
  assert.equal(EFFECT_TO_LANE, EFFECT_TO_LAYER);
});
