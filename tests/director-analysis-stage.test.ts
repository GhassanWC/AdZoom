/**
 * THE INTEGRATION SEAM: the Director as the final stage of analysis.
 *
 * This is the actual thing the analyze route calls. It exercises the whole chain
 * the user goes through — brief → plan → validated preset selection → real,
 * editable timeline moments → the activity lines and summary they read.
 *
 * No API key needed: `planDirector` falls back to the deterministic heuristic
 * planner on any model failure, which is exactly the path a key-less environment
 * takes. That fallback is a supported production path, not a test-only shim, so
 * testing through it tests something real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runDirectorStage } from "../src/lib/director/analysis-stage.ts";
import { shouldRunDirectorStage } from "../src/lib/director/types.ts";
import type { DirectorBrief } from "../src/lib/director/types.ts";
import { getPreset } from "../src/lib/presets/registry.ts";
import { buildRenderRecipe } from "../src/lib/render/recipe.ts";
import type { DetectedMoment, EffectsSettings } from "../src/lib/firebase/schema.ts";

import { demoProject, noTranscriptProject, userMoment } from "./director-fixtures.ts";

const NOW = 1_700_000_000_000;

const TIKTOK_BRIEF: DirectorBrief = {
  prompt:
    "Turn this into a punchy 45-second product demo for TikTok. Cut the boring parts, keep the payment demo, energetic captions, finish with a CTA.",
  form: {
    goal: "product-demo",
    platform: "tiktok",
    aspectRatio: "9:16",
    style: "energetic",
    captionStyle: "bold_social",
    cta: "always",
    targetDurationSeconds: 45,
  },
  updatedAt: NOW,
};

function logText(log: { text: string }[]) {
  return log.map((l) => l.text).join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// The happy path — one flow, brief to timeline
// ════════════════════════════════════════════════════════════════════════════

test("stage: a brief applied during analysis produces real, designed timeline edits", async () => {
  const project = demoProject();
  const analysisMoments = project.analysis!.detectedMoments;

  const result = await runDirectorStage({
    project,
    brief: TIKTOK_BRIEF,
    moments: analysisMoments,
    effects: project.effectsSettings,
  });

  assert.equal(result.applied, true, "the brief should have produced edits");
  assert.equal(result.state.status, "complete");

  const directed = result.moments.filter((m) => m.source === "ai-director");
  assert.ok(directed.length > 0, "the timeline should carry Director edits");

  // Every design is a REAL registry entry — the invariant, at the seam the route uses.
  const styled = directed.filter((m) => m.preset?.id);
  assert.ok(styled.length > 0, "the Director should have dressed its edits");
  for (const m of styled) {
    assert.ok(getPreset(m.preset!.id), `"${m.preset!.id}" is not in the preset library`);
  }

  // The brief's aspect ratio became a real output canvas — "make it vertical" is
  // an instruction, and it must reach the thing that renders.
  assert.equal(result.outputCanvas?.aspectRatio, "9:16");
});

test("stage: the activity log tells the user what was understood and what was chosen", async () => {
  const project = demoProject();
  const result = await runDirectorStage({
    project,
    brief: TIKTOK_BRIEF,
    moments: project.analysis!.detectedMoments,
    effects: project.effectsSettings,
  });

  const text = logText(result.log);

  // It restates the brief in the user's own terms — a misread brief is the failure
  // mode a user cannot debug on their own.
  assert.match(text, /Director brief/i);
  assert.match(text, /tiktok/i);
  assert.match(text, /9:16/);
  assert.match(text, /energetic/i);

  // It names the DESIGNS it chose, by name and by id.
  const choices = result.state.summary?.presets ?? [];
  assert.ok(choices.length > 0);
  for (const c of choices) {
    assert.ok(
      text.includes(c.presetName) && text.includes(c.presetId),
      `the activity log never mentions the ${c.slot} design (${c.presetId})`
    );
  }

  // And it says what it actually did.
  assert.match(text, /Director applied \d+ decision/i);
});

test("stage: the summary the panel renders names every design that landed", async () => {
  const project = demoProject();
  const result = await runDirectorStage({
    project,
    brief: TIKTOK_BRIEF,
    moments: project.analysis!.detectedMoments,
    effects: project.effectsSettings,
  });

  const presets = result.state.summary?.presets ?? [];
  assert.ok(presets.length > 0, "the persisted summary must carry the design choices");

  const live = result.moments.filter(
    (m) => m.source === "ai-director" && m.preset?.id && m.enabled !== false
  );
  for (const p of presets) {
    assert.ok(getPreset(p.presetId));
    assert.equal(
      p.momentCount,
      live.filter((m) => m.preset!.id === p.presetId).length,
      `the summary overstates how many edits wear ${p.presetId}`
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// It composes with the rest of the timeline instead of replacing it
// ════════════════════════════════════════════════════════════════════════════

test("stage: the user's own edits survive the Director stage untouched", async () => {
  const project = demoProject();
  const mine = userMoment();
  const withMine = [...project.analysis!.detectedMoments, mine];

  const result = await runDirectorStage({
    project,
    brief: TIKTOK_BRIEF,
    moments: withMine,
    effects: project.effectsSettings,
  });

  const survivor = result.moments.find((m) => m.id === mine.id);
  assert.ok(survivor, "a user edit was destroyed by the Director stage");
  assert.equal(survivor.source, "user");
  assert.deepEqual(
    { s: survivor.startTime, e: survivor.endTime },
    { s: mine.startTime, e: mine.endTime },
    "the Director moved a user's edit"
  );
});

test("stage: re-running the same brief REPLACES its edits rather than stacking them", async () => {
  const project = demoProject();
  const base = project.analysis!.detectedMoments;

  const first = await runDirectorStage({
    project,
    brief: TIKTOK_BRIEF,
    moments: base,
    effects: project.effectsSettings,
  });
  // Feed the already-directed timeline back in, exactly as a re-analysis would.
  const second = await runDirectorStage({
    project,
    brief: TIKTOK_BRIEF,
    moments: first.moments,
    effects: project.effectsSettings,
  });

  const count = (ms: DetectedMoment[]) =>
    ms.filter((m) => m.source === "ai-director").length;
  assert.equal(
    count(second.moments),
    count(first.moments),
    "re-running the brief stacked a second set of Director edits"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Captions: never invented, never billed without asking
// ════════════════════════════════════════════════════════════════════════════

test("stage: captions requested with no transcript are REPORTED, not invented", async () => {
  const project = noTranscriptProject();

  const result = await runDirectorStage({
    project,
    brief: TIKTOK_BRIEF, // asks for bold_social captions
    moments: project.analysis?.detectedMoments ?? [],
    effects: project.effectsSettings,
  });

  const text = logText(result.log);
  // It says so, in words, and points at the (separately metered) captions action.
  assert.match(text, /transcript/i);
  assert.match(text, /Generate AI Captions/i);

  // And it invented NO caption text.
  const captions = result.moments.filter(
    (m) => m.source === "ai-director" && m.effectType === "captions"
  );
  assert.equal(captions.length, 0, "captions were fabricated without a transcript");

  // Everything ELSE the brief asked for still applied — one missing input must not
  // throw away the rest of the user's instructions.
  if (result.applied) {
    const directed = result.moments.filter((m) => m.source === "ai-director");
    assert.ok(directed.length > 0, "the rest of the brief should still have applied");
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Plain analysis is untouched
// ════════════════════════════════════════════════════════════════════════════

test("stage: with no brief, the Director never runs and the timeline is analysis's alone", () => {
  const project = demoProject();
  // This is the exact predicate the analyze route gates on.
  assert.equal(shouldRunDirectorStage(project.directorBrief, undefined), false);
  assert.equal(
    shouldRunDirectorStage(undefined, true),
    false,
    "no brief must mean no Director stage, however the options are set"
  );
});

test("stage: an explicit opt-out suppresses a saved brief without deleting it", () => {
  assert.equal(shouldRunDirectorStage(TIKTOK_BRIEF, false), false);
  // …and the brief itself is still a valid brief, ready for the next run.
  assert.equal(shouldRunDirectorStage(TIKTOK_BRIEF, undefined), true);
});

// ════════════════════════════════════════════════════════════════════════════
// PREVIEW → EXPORT: the directed timeline renders
// ════════════════════════════════════════════════════════════════════════════

test("stage: the directed timeline serializes into the render recipe, designs and all", async () => {
  const project = demoProject();
  const result = await runDirectorStage({
    project,
    brief: TIKTOK_BRIEF,
    moments: project.analysis!.detectedMoments,
    effects: project.effectsSettings,
  });
  assert.equal(result.applied, true);

  const effects = {
    ...project.effectsSettings,
    ...(result.outputCanvas ? { outputCanvas: result.outputCanvas } : {}),
  } as EffectsSettings;

  const recipe = buildRenderRecipe({
    sourceWidth: project.width!,
    sourceHeight: project.height!,
    fps: 30,
    resolution: "1080p",
    format: "Source",
    sourceDuration: project.duration!,
    moments: result.moments as DetectedMoment[],
    effects,
    sourceCrop: null,
    applyWatermark: false,
  });

  const serialized = JSON.stringify(recipe);
  const styled = result.moments.filter(
    (m) => m.source === "ai-director" && m.preset?.id && m.enabled !== false
  );
  assert.ok(styled.length > 0);
  for (const m of styled) {
    assert.ok(
      serialized.includes(m.preset!.id),
      `"${m.preset!.id}" was chosen by the Director but never reaches the renderer`
    );
  }

  // The brief said 9:16 — the exported FRAME must actually be vertical, or the
  // preview the user approved is not the file they get.
  assert.ok(
    recipe.canvasW < recipe.canvasH,
    `brief asked for 9:16 but the recipe renders ${recipe.canvasW}×${recipe.canvasH}`
  );

  // The cuts really shorten the file, rather than only dimming the timeline.
  assert.ok(
    recipe.outputDuration < recipe.sourceDuration,
    "the Director's cuts did not shorten the exported output"
  );
});
