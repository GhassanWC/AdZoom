/**
 * Editor → export caption integrity — the invariants that make the exported
 * MP4 match the preview: the render snapshot carries EVERY caption (and every
 * other edit) verbatim with its styling bag; the edit-count summary used by
 * the stage logs reports them faithfully; the canonical output→source time
 * mapping keeps captions glued to the video across cuts + speed changes; and
 * the shared overlay gate renders enabled captions only.
 *
 * Root-cause context: the 109-captions→0 bug was a STALE deployed render
 * bundle (built before overlays/captions existed), not a schema strip — these
 * tests + the [export-create]/[export-render] count logs make any recurrence
 * (at any stage) visible immediately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildRenderRecipe } from "@/lib/render/recipe";
import { summarizeEditsForLog } from "@/lib/render/edit-counts";
import { activeOverlays } from "@/lib/render/overlay-draw";
import {
  buildTimelineMap,
  sourceTimeForOutput,
} from "@/lib/timeline/crop-speed";
import type { DetectedMoment, EffectsSettings } from "@/lib/firebase/schema";

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const caption = (id: string, start: number, end: number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    startTime: start,
    endTime: end,
    label: `cap ${id}`,
    effectType: "captions",
    captions: {
      text: `caption ${id}`,
      stylePreset: "bold_social",
      position: "bottom",
      direction: "rtl",
      lang: "ar",
    },
    ...extra,
  }) as unknown as DetectedMoment;

const moment = (id: string, effectType: string, start: number, end: number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    startTime: start,
    endTime: end,
    label: id,
    effectType,
    ...extra,
  }) as unknown as DetectedMoment;

const EFFECTS = { pacing: "balanced" } as unknown as EffectsSettings;

/* ── 1. The snapshot carries every edit verbatim ─────────────────────────── */

test("buildRenderRecipe carries ALL 109 captions + styling bags verbatim", () => {
  const captions = Array.from({ length: 109 }, (_, i) => caption(`c${i}`, i, i + 0.9));
  const others = [
    moment("z1", "zoom", 5, 8, { intensity: 1.3 }),
    moment("cut1", "cut", 20, 22, { cut: { active: true } }),
    moment("sp1", "speed-up", 30, 40, { speed: { multiplier: 2 } }),
    moment("h1", "hook-text", 0, 3, { hookText: { text: "hook!", stylePreset: "bold", position: "center", animation: "pop" } }),
  ];
  const recipe = buildRenderRecipe({
    sourceWidth: 1920,
    sourceHeight: 1080,
    fps: 30,
    resolution: "1080p",
    format: "Source",
    sourceDuration: 120,
    moments: [...captions, ...others],
    effects: EFFECTS,
  });
  // The SAME array, unfiltered — captions, zooms, cuts, speed, hook text.
  assert.equal(recipe.moments.length, 113);
  const outCaptions = recipe.moments.filter((m) => m.effectType === "captions");
  assert.equal(outCaptions.length, 109);
  // Styling bag intact (text, preset, position, direction, lang).
  const c0 = outCaptions[0] as unknown as { captions: Record<string, unknown> };
  assert.deepEqual(c0.captions, {
    text: "caption c0",
    stylePreset: "bold_social",
    position: "bottom",
    direction: "rtl",
    lang: "ar",
  });
});

test("disabled captions survive the snapshot (non-destructive disable)", () => {
  const recipe = buildRenderRecipe({
    sourceWidth: 1280,
    sourceHeight: 720,
    fps: 30,
    resolution: "720p",
    format: "Source",
    sourceDuration: 30,
    moments: [caption("on", 1, 2), caption("off", 3, 4, { enabled: false })],
    effects: EFFECTS,
  });
  assert.equal(recipe.moments.length, 2); // kept in the snapshot…
  const { output } = activeOverlays(recipe.moments, 3.5);
  assert.equal(output.length, 0); // …but not rendered (shared gate)
  assert.equal(activeOverlays(recipe.moments, 1.5).output.length, 1);
});

/* ── 2. Stage-log counts ─────────────────────────────────────────────────── */

test("summarizeEditsForLog reports 109 captions + per-type counts", () => {
  const moments = [
    ...Array.from({ length: 109 }, (_, i) => caption(`c${i}`, i, i + 0.5)),
    moment("z1", "zoom", 1, 2),
    moment("z2", "zoom", 3, 4, { enabled: false }),
    moment("cut1", "cut", 5, 6),
  ];
  const s = summarizeEditsForLog(moments);
  assert.equal(s.total, 112);
  assert.equal(s.captionCount, 109);
  assert.equal(s.enabledCaptionCount, 109);
  assert.equal(s.captionsEnabled, true);
  assert.equal(s.byType.captions, 109);
  assert.equal(s.byType.zoom, 1); // disabled zoom not counted as renderable
  assert.equal(s.byType.cut, 1);
  assert.equal(s.disabled, 1);
});

test("summarizeEditsForLog handles empty/missing snapshots safely", () => {
  assert.equal(summarizeEditsForLog(null).total, 0);
  assert.equal(summarizeEditsForLog(undefined).captionsEnabled, false);
  const disabledOnly = summarizeEditsForLog([caption("c", 0, 1, { enabled: false })]);
  assert.equal(disabledOnly.captionCount, 1);
  assert.equal(disabledOnly.enabledCaptionCount, 0);
  assert.equal(disabledOnly.captionsEnabled, false);
});

/* ── 3. Caption timing across cuts + speed (canonical mapping) ───────────── */

test("captions stay on the correct source frames across a cut", () => {
  // Source: 0..10s with a cut removing 2..4. Caption at 5..6 (source time).
  const moments = [
    moment("cut", "cut", 2, 4, { cut: { active: true } }),
    caption("c", 5, 6),
  ];
  const map = buildTimelineMap(moments, 10);
  assert.equal(map.outputDuration, 8); // 10 − 2s cut
  // Output 3.5s = source 5.5s (cut removed) → caption ACTIVE.
  const srcMid = sourceTimeForOutput(map, 3.5);
  assert.equal(srcMid, 5.5);
  assert.equal(activeOverlays(moments, srcMid).output.length, 1);
  // Output 1.5s = source 1.5s (before the cut) → caption not active yet.
  assert.equal(activeOverlays(moments, sourceTimeForOutput(map, 1.5)).output.length, 0);
  // The removed range is never sampled: outputs around the cut jump 2 → 4.
  const eps = 1e-9;
  assert.ok(Math.abs(sourceTimeForOutput(map, 1.999) - 1.999) < eps);
  assert.ok(Math.abs(sourceTimeForOutput(map, 2.001) - 4.001) < eps);
});

test("captions stay on the correct source frames under a speed change", () => {
  // Source 0..10s, 2x speed over 4..8 (4s of source → 2s of output).
  const moments = [
    moment("sp", "speed-up", 4, 8, { speed: { multiplier: 2 } }),
    caption("c", 5, 6), // inside the sped section
  ];
  const map = buildTimelineMap(moments, 10);
  assert.equal(map.outputDuration, 8); // 10 − 2 saved
  // Output 4.75s → source 4 + 0.75*2 = 5.5 → caption active.
  const src = sourceTimeForOutput(map, 4.75);
  assert.equal(src, 5.5);
  assert.equal(activeOverlays(moments, src).output.length, 1);
  // Output 5.5s → source 4 + 1.5*2 = 7 → caption over.
  assert.equal(activeOverlays(moments, sourceTimeForOutput(map, 5.5)).output.length, 0);
});

test("past-the-end output times clamp to the final source segment", () => {
  const map = buildTimelineMap([], 10);
  assert.equal(sourceTimeForOutput(map, 10.5), 10);
});

/* ── 4. The render core actually draws overlays (stale-bundle regression) ── */

test("compose-frame (shared render core) includes the overlay pass", () => {
  // The 109→0 root cause was a deployed bundle whose composeFrame predated
  // overlays. Guard the source: the shared core MUST call both overlay passes.
  const src = readFileSync("src/lib/render/compose-frame.ts", "utf8");
  assert.ok(src.includes("drawOutputOverlays"), "output overlay pass (captions) missing");
  assert.ok(src.includes("drawInCameraOverlays"), "in-camera overlay pass missing");
});

test("worker + remotion + browser export all consume the shared core", () => {
  for (const file of [
    "services/export-worker/src/render.ts",
    "src/components/dashboard/real-editor/export.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.ok(src.includes("composeFrame"), `${file} must render via the shared composeFrame`);
  }
  const remotion = readFileSync("src/remotion/layers/EffectsLayer.tsx", "utf8");
  assert.ok(remotion.includes("drawOutputOverlays"), "Remotion must draw output overlays (captions)");
});

test("the worker dist bundle is no longer git-tracked (stale-deploy guard)", () => {
  // The stale committed bundle was the failure vector. .gitignore now owns it.
  const ignore = readFileSync(".gitignore", "utf8");
  assert.ok(ignore.includes("services/export-worker/dist/"));
});
