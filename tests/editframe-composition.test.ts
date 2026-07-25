/**
 * Editframe beta adapter parity gate.
 *
 * The whole point of `buildEditframeComposition` is that it reuses Framevo's
 * shared render core with the SAME inputs the cloud exporter uses, so the recipe
 * (and therefore every rendered pixel) is byte-identical to Cloud/Remotion. This
 * test locks that: the adapter's recipe must deep-equal `buildRenderRecipe` for
 * the same inputs, and it must honour resolution + cuts/speed in the timeline map.
 *
 * Pure (no DOM / no mediabunny) — runs under `npm test` (node --test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildEditframeComposition } from "../src/lib/export/editframe/build-composition.ts";
import { buildRenderRecipe } from "../src/lib/render/recipe.ts";
import { DEFAULT_EFFECTS_SETTINGS } from "../src/lib/firebase/schema.ts";
import type { DetectedMoment } from "../src/lib/firebase/schema.ts";

const FULL: DetectedMoment["focusRegion"] = { x: 0, y: 0, width: 1, height: 1 };

const moments: DetectedMoment[] = [
  { id: "cut1", startTime: 2, endTime: 4, label: "", reason: "", focusRegion: FULL, effectType: "cut", cut: { active: true } },
  { id: "spd1", startTime: 6, endTime: 10, label: "", reason: "", focusRegion: FULL, effectType: "speed-up", speed: { multiplier: 2, audioMode: "mute", transition: "cut" } },
  { id: "zoom1", startTime: 12, endTime: 15, label: "", reason: "", focusRegion: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 }, effectType: "zoom" },
  { id: "cap1", startTime: 1, endTime: 3, label: "", reason: "", focusRegion: FULL, effectType: "captions", captions: { text: "hello", stylePreset: "clean", position: "bottom" } },
];

const project = {
  id: "p1",
  title: "Test",
  originalVideoUrl: "https://example.com/v.mp4",
  width: 1920,
  height: 1080,
  effects: DEFAULT_EFFECTS_SETTINGS,
  sourceCrop: null,
  applyWatermark: false,
} as const;

const timeline = {
  moments,
  sourceDuration: 30,
  resolution: "1080p",
  fps: 30,
  format: "YouTube 16:9",
  outputFormat: "16:9 · 1080p · 30fps · MP4",
} as const;

test("Editframe adapter recipe is byte-identical to the cloud buildRenderRecipe", () => {
  const plan = buildEditframeComposition(project, timeline);
  const cloudRecipe = buildRenderRecipe({
    sourceWidth: project.width,
    sourceHeight: project.height,
    fps: timeline.fps,
    resolution: timeline.resolution,
    format: timeline.format,
    sourceDuration: timeline.sourceDuration,
    moments,
    effects: project.effects,
    visualAnalysis: undefined,
    sourceCrop: null,
    applyWatermark: false,
    debugBorders: false,
  });
  assert.deepEqual(plan.recipe, cloudRecipe);
  assert.equal(plan.sourceUrl, project.originalVideoUrl);
  assert.equal(plan.fps, 30);
  assert.equal(plan.resolution, "1080p");
});

test("cuts + speed shorten the output duration below the source duration", () => {
  const plan = buildEditframeComposition(project, timeline);
  // cut 2..4 (−2s) and speed 6..10 @2x (4s → 2s) both compress the timeline.
  assert.ok(
    plan.recipe.outputDuration < timeline.sourceDuration,
    `expected outputDuration < ${timeline.sourceDuration}, got ${plan.recipe.outputDuration}`
  );
});

test("720p and 1080p resolve to different output canvas heights", () => {
  const p720 = buildEditframeComposition(project, { ...timeline, resolution: "720p" });
  const p1080 = buildEditframeComposition(project, { ...timeline, resolution: "1080p" });
  assert.ok(
    p1080.recipe.canvasH > p720.recipe.canvasH,
    `expected 1080p (${p1080.recipe.canvasH}) taller than 720p (${p720.recipe.canvasH})`
  );
});

test("the free-tier watermark flag flows into the recipe", () => {
  const watermarked = buildEditframeComposition(
    { ...project, applyWatermark: true },
    timeline
  );
  assert.equal(watermarked.recipe.applyWatermark, true);
  const clean = buildEditframeComposition(project, timeline);
  assert.equal(clean.recipe.applyWatermark, false);
});
