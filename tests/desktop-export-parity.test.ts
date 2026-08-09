/**
 * Render-recipe parity across ALL FOUR engines.
 *
 * Framevo can produce the same video four ways — the editor preview, the
 * in-browser (Editframe/mediabunny) export, the cloud render, and now the
 * desktop app's local render. The rule that keeps them identical is that not
 * one of them describes the edit itself: they all feed the SAME inputs to
 * `buildRenderRecipe`, and the recipe is what every compositor consumes.
 *
 * This test is the guard. If someone adds a desktop-only tweak — a different
 * canvas size, a dropped moment, a re-derived timeline — the recipes stop being
 * deep-equal and this fails, long before anyone notices drift in an exported
 * file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { serializeRecipeInput } from "../src/components/export/desktop-export-recipe.ts";
import { buildEditframeComposition } from "../src/lib/export/editframe/build-composition.ts";
import { buildRenderRecipe } from "../src/lib/render/recipe.ts";
import { DEFAULT_EFFECTS_SETTINGS } from "../src/lib/firebase/schema.ts";
import type { DetectedMoment, SerializedRenderRecipe } from "../src/lib/firebase/schema.ts";

const FULL: DetectedMoment["focusRegion"] = { x: 0, y: 0, width: 1, height: 1 };

/** One of every currently-enabled edit family, so the map covers real work. */
const moments: DetectedMoment[] = [
  { id: "cut1", startTime: 2, endTime: 4, label: "", reason: "", focusRegion: FULL, effectType: "cut", cut: { active: true } },
  { id: "spd1", startTime: 6, endTime: 10, label: "", reason: "", focusRegion: FULL, effectType: "speed-up", speed: { multiplier: 2, audioMode: "mute", transition: "cut" } },
  { id: "zoom1", startTime: 12, endTime: 15, label: "", reason: "", focusRegion: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 }, effectType: "zoom" },
  { id: "cap1", startTime: 1, endTime: 3, label: "", reason: "", focusRegion: FULL, effectType: "captions", captions: { text: "hello", stylePreset: "clean", position: "bottom" } },
  { id: "call1", startTime: 5, endTime: 7, label: "", reason: "", focusRegion: FULL, effectType: "callout", callout: { text: "Look here", shape: "box", x: 0.2, y: 0.2, width: 0.3, height: 0.2 } },
  { id: "text1", startTime: 8, endTime: 9, label: "", reason: "", focusRegion: FULL, effectType: "text-overlay", textOverlay: { text: "Framevo", position: "top" } },
  { id: "cta1", startTime: 16, endTime: 18, label: "", reason: "", focusRegion: FULL, effectType: "cta", cta: { text: "Try it free", position: "bottom" } },
  { id: "brand1", startTime: 0, endTime: 20, label: "", reason: "", focusRegion: FULL, effectType: "branding", branding: { text: "framevo.app", position: "top-right" } },
  { id: "trans1", startTime: 11, endTime: 11.5, label: "", reason: "", focusRegion: FULL, effectType: "transition", transition: { style: "fade" } },
  { id: "click1", startTime: 13, endTime: 13.6, label: "", reason: "", focusRegion: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 }, effectType: "click-highlight" },
];

const desktopInput = {
  projectId: "p1",
  projectTitle: "Launch demo",
  mediaId: "media12345",
  sourceWidth: 1920,
  sourceHeight: 1080,
  sourceDuration: 20,
  moments,
  effects: {
    ...DEFAULT_EFFECTS_SETTINGS,
    outputCanvas: {
      aspectRatio: "9:16" as const,
      fitMode: "fit" as const,
      backgroundMode: "blur" as const,
    },
  },
  sourceCrop: { enabled: true, x: 0.05, y: 0.0, width: 0.9, height: 0.94 },
  applyWatermark: true,
  resolution: "1080p" as const,
  fps: 30 as const,
  format: "TikTok 9:16" as const,
};

/** What `POST /api/export/cloud` stores on the job (see lib/export/create-job.ts). */
function cloudSnapshot(): SerializedRenderRecipe {
  return {
    sourceWidth: desktopInput.sourceWidth,
    sourceHeight: desktopInput.sourceHeight,
    fps: desktopInput.fps,
    resolution: desktopInput.resolution,
    format: desktopInput.format,
    sourceDuration: desktopInput.sourceDuration,
    moments: desktopInput.moments,
    effects: desktopInput.effects,
    sourceCrop: desktopInput.sourceCrop,
    applyWatermark: desktopInput.applyWatermark,
  };
}

test("the desktop snapshot is byte-identical to the cloud job's stored recipe", () => {
  assert.deepEqual(serializeRecipeInput(desktopInput), cloudSnapshot());
});

test("desktop, cloud and in-browser resolve to the SAME render recipe", () => {
  const desktopRecipe = buildRenderRecipe({
    ...serializeRecipeInput(desktopInput),
    debugBorders: false,
  });
  const cloudRecipe = buildRenderRecipe({ ...cloudSnapshot(), debugBorders: false });
  const browserRecipe = buildEditframeComposition(
    {
      id: desktopInput.projectId,
      title: desktopInput.projectTitle,
      originalVideoUrl: "https://example.com/source.mp4",
      width: desktopInput.sourceWidth,
      height: desktopInput.sourceHeight,
      effects: desktopInput.effects,
      sourceCrop: desktopInput.sourceCrop,
      applyWatermark: desktopInput.applyWatermark,
    },
    {
      moments: desktopInput.moments,
      sourceDuration: desktopInput.sourceDuration,
      resolution: desktopInput.resolution,
      fps: desktopInput.fps,
      format: desktopInput.format,
      outputFormat: "9:16 · 1080p · 30fps · MP4",
    }
  ).recipe;

  assert.deepEqual(desktopRecipe, cloudRecipe, "desktop vs cloud");
  assert.deepEqual(desktopRecipe, browserRecipe, "desktop vs in-browser");
});

test("every enabled edit survives into the recipe the desktop renderer receives", () => {
  const recipe = buildRenderRecipe({
    ...serializeRecipeInput(desktopInput),
    debugBorders: false,
  });
  // Moments are carried RAW — the compositor's own resolvers select per frame,
  // which is exactly why no engine can silently drop an edit type.
  assert.equal(recipe.moments.length, moments.length);
  const types = new Set(recipe.moments.map((m) => m.effectType));
  for (const expected of [
    "cut",
    "speed-up",
    "zoom",
    "captions",
    "callout",
    "text-overlay",
    "cta",
    "branding",
    "transition",
    "click-highlight",
  ]) {
    assert.ok(types.has(expected as DetectedMoment["effectType"]), `${expected} reached the recipe`);
  }

  // Cuts and speed changes are baked into the timeline map, not re-derived.
  assert.ok(recipe.outputDuration < desktopInput.sourceDuration, "the cut shortened the output");
  assert.equal(recipe.applyWatermark, true);
  // 9:16 at 1080p, from a 1920×1080 source with a crop applied.
  assert.equal(recipe.canvasH > recipe.canvasW, true, "portrait canvas");
  assert.equal(recipe.sourceRect.cropActive, true);
});

test("the project's zoom style reaches the desktop, cloud and in-browser renderers alike", () => {
  // Camera feel is a project setting, and the three engines only ever see the
  // SERIALIZED recipe — so if it didn't survive this hop, a video exported from
  // the desktop app (or the cloud) would quietly render with the default style
  // while the editor previewed something else.
  const styled = {
    ...desktopInput,
    effects: { ...desktopInput.effects, zoomPreset: "emphasis" as const, zoomSpeed: 82 },
  };
  const desktop = buildRenderRecipe({ ...serializeRecipeInput(styled), debugBorders: false });
  const browser = buildEditframeComposition(
    {
      id: styled.projectId,
      title: styled.projectTitle,
      originalVideoUrl: "https://example.com/source.mp4",
      width: styled.sourceWidth,
      height: styled.sourceHeight,
      effects: styled.effects,
      sourceCrop: styled.sourceCrop,
      applyWatermark: styled.applyWatermark,
    },
    {
      moments: styled.moments,
      sourceDuration: styled.sourceDuration,
      resolution: styled.resolution,
      fps: styled.fps,
      format: styled.format,
      outputFormat: "9:16 · 1080p · 30fps · MP4",
    }
  ).recipe;

  for (const [name, recipe] of [
    ["desktop", desktop],
    ["in-browser", browser],
  ] as const) {
    assert.equal(recipe.effects.zoomPreset, "emphasis", `${name} lost the zoom style`);
    assert.equal(recipe.effects.zoomSpeed, 82, `${name} lost the camera speed`);
  }
  assert.deepEqual(desktop.effects, browser.effects);
});

test("a local project's watermark policy matches the in-browser engine's", () => {
  // Free tier ⇒ watermark, on BOTH local engines. (Paid cloud renders never set
  // it; see lib/export/create-job.ts.)
  const free = serializeRecipeInput({ ...desktopInput, applyWatermark: true });
  const paid = serializeRecipeInput({ ...desktopInput, applyWatermark: false });
  assert.equal(buildRenderRecipe({ ...free, debugBorders: false }).applyWatermark, true);
  assert.equal(buildRenderRecipe({ ...paid, debugBorders: false }).applyWatermark, false);
});
