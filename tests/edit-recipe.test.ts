/**
 * Unit tests for the AI Edit Recipe Engine — locks the acceptance criteria:
 * every video type has a default recipe, the engine returns a structured plan
 * (never mutating anything), signals gate feasibility, and Auto resolves to the
 * detected type's recipe.
 *
 * Run with:  npm test   (node --test, native TS strip; no test deps)
 *
 * `edit-recipe.ts` + `video-type.ts` only use type-only `@/` imports (erased by
 * Node's type stripping), so they load cleanly via relative paths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RECIPES,
  IMPLEMENTED_CATEGORIES,
  editGenerationControls,
  disablesAllImplementedEdits,
  resolveEditRecipe,
  type EditGenerationControls,
  type EditOperationCategory,
  type EditRecipePlan,
} from "../src/lib/analysis/edit-recipe.ts";
import { SELECTED_VIDEO_TYPES } from "../src/lib/analysis/video-type.ts";

/** Resolve a type to its generation controls with all signals available. */
function controlsFor(
  selectedVideoType: Parameters<typeof resolveEditRecipe>[0]["selectedVideoType"]
): EditGenerationControls {
  return editGenerationControls(
    resolveEditRecipe({ selectedVideoType, signals: FULL_SIGNALS })
  );
}

const FULL_SIGNALS = {
  hasTranscript: true,
  hasAudioAnalysis: true,
  hasSceneData: true,
  hasVisualMoments: true,
  hasInteractionData: true,
  isScreenRecording: true,
  durationSeconds: 120,
};
const NO_SIGNALS = {
  hasTranscript: false,
  hasAudioAnalysis: false,
  hasSceneData: false,
  hasVisualMoments: false,
  hasInteractionData: false,
  isScreenRecording: false,
};

test("every video type has a default recipe with operations", () => {
  for (const t of SELECTED_VIDEO_TYPES) {
    const recipe = DEFAULT_RECIPES[t];
    assert.ok(recipe, `missing recipe for ${t}`);
    assert.equal(recipe.videoType, t);
    assert.ok(recipe.operations.length > 0, `${t} has no operations`);
    assert.ok(recipe.name && recipe.summary, `${t} missing name/summary`);
    // Every op's `planned` flag must match the implemented set.
    for (const op of recipe.operations) {
      assert.equal(
        op.planned,
        !IMPLEMENTED_CATEGORIES.has(op.category),
        `${t}/${op.category} planned flag mismatch`
      );
      assert.ok(op.priority >= 0 && op.priority <= 1, `${t}/${op.category} bad priority`);
    }
  }
});

test("resolveEditRecipe returns a structured plan for every type (no throw)", () => {
  for (const t of SELECTED_VIDEO_TYPES) {
    const plan = resolveEditRecipe({ selectedVideoType: t, signals: FULL_SIGNALS });
    assert.equal(plan.requestedVideoType, t);
    assert.ok(plan.operations.length > 0);
    assert.equal(
      plan.enabledCategories.length + plan.disabledCategories.length,
      plan.operations.length
    );
    // Every category has a reason.
    for (const op of plan.operations) {
      assert.ok(plan.reasons[op.category], `no reason for ${op.category}`);
    }
  }
});

test("Phase-3 promoted the Core AI Edit Pack to implemented; audio/captions stay planned", () => {
  // Original implemented engines.
  assert.ok(IMPLEMENTED_CATEGORIES.has("cut"));
  assert.ok(IMPLEMENTED_CATEGORIES.has("zoom"));
  assert.ok(IMPLEMENTED_CATEGORIES.has("speed"));
  // Phase 3 — now implemented (render + export + generate).
  const nowImplemented: EditOperationCategory[] = [
    "hook_text", "text_overlay", "callout", "branding", "smart_crop", "transition",
  ];
  for (const c of nowImplemented) assert.ok(IMPLEMENTED_CATEGORIES.has(c), `${c} should be implemented`);
  // Still planned: captions (no transcript), blur (no auto-detector), audio/broll.
  const planned: EditOperationCategory[] = [
    "captions", "blur_redaction", "music", "silence_removal", "audio_cleanup", "freeze_frame", "broll_overlay",
  ];
  for (const c of planned) assert.ok(!IMPLEMENTED_CATEGORIES.has(c), `${c} should be planned`);
});

test("signals gate feasibility — captions need a transcript", () => {
  const withT = resolveEditRecipe({ selectedVideoType: "talking-head", signals: FULL_SIGNALS });
  assert.ok(withT.enabledCategories.includes("captions"), "captions should be enabled with a transcript");

  const withoutT = resolveEditRecipe({
    selectedVideoType: "talking-head",
    signals: { ...FULL_SIGNALS, hasTranscript: false },
  });
  assert.ok(
    withoutT.disabledCategories.includes("captions"),
    "captions should be disabled without a transcript"
  );
  assert.match(withoutT.reasons.captions, /transcript/i);
});

test("blur redaction only for screen recordings", () => {
  const screen = resolveEditRecipe({ selectedVideoType: "screen-recording", signals: FULL_SIGNALS });
  assert.ok(screen.enabledCategories.includes("blur_redaction"));

  const notScreen = resolveEditRecipe({
    selectedVideoType: "screen-recording",
    signals: { ...FULL_SIGNALS, isScreenRecording: false, hasInteractionData: false },
  });
  assert.ok(notScreen.disabledCategories.includes("blur_redaction"));
});

test("Auto resolves to the AI-detected type's recipe", () => {
  const plan = resolveEditRecipe({
    selectedVideoType: "auto",
    detectedVideoType: "vertical-short",
    signals: FULL_SIGNALS,
  });
  assert.equal(plan.effectiveVideoType, "reels-shorts");
  assert.equal(plan.recipeName, DEFAULT_RECIPES["reels-shorts"].name);

  // Ambiguous detection ("mixed") → general Auto recipe.
  const auto = resolveEditRecipe({
    selectedVideoType: "auto",
    detectedVideoType: "mixed",
    signals: FULL_SIGNALS,
  });
  assert.equal(auto.effectiveVideoType, "auto");
});

test("with zero signals, the plan still lists the recipe's ops (some disabled)", () => {
  const plan = resolveEditRecipe({ selectedVideoType: "reels-shorts", signals: NO_SIGNALS });
  assert.ok(plan.operations.length > 0);
  // cut/zoom/speed have no signal prerequisite → still enabled.
  assert.ok(plan.enabledCategories.includes("cut"));
  // captions require a transcript → disabled here.
  assert.ok(plan.disabledCategories.includes("captions"));
});

// ── Generation controls: recipe → real cut/zoom/speed knobs ─────────────────

const BASELINE = 0.5;

test("Reels drives aggressive cuts + punchy zooms (above baseline)", () => {
  const c = controlsFor("reels-shorts");
  assert.ok(c.fromRecipe);
  assert.ok(c.cut.enabled && c.zoom.enabled && c.speed.enabled);
  assert.ok(c.cut.intensity > BASELINE, "cuts should be more aggressive than baseline");
  assert.ok(c.zoom.intensity > BASELINE, "zooms should punch in harder than baseline");
});

test("Talking Head keeps zoom + speed subtle (below baseline)", () => {
  const c = controlsFor("talking-head");
  assert.ok(c.zoom.enabled, "subtle zoom is still enabled");
  assert.ok(c.zoom.intensity < BASELINE, "zooms should be subtler than baseline");
  assert.ok(c.speed.intensity < BASELINE, "speed should be minimal");
  // Distinctly gentler than Reels — different types produce different edits.
  assert.ok(controlsFor("reels-shorts").cut.intensity > c.cut.intensity);
});

test("Screen Recording keeps strong zoom (regression: never lose zoom)", () => {
  const c = controlsFor("screen-recording");
  assert.ok(c.zoom.enabled, "screen recordings must keep zoom");
  assert.ok(c.zoom.intensity >= BASELINE, "zoom should be strong for screen recordings");
  assert.ok(c.cut.enabled && c.speed.enabled);
});

test("missing plan → baseline controls (old behavior preserved)", () => {
  const c = editGenerationControls(null);
  assert.equal(c.fromRecipe, false);
  for (const cat of ["cut", "zoom", "speed"] as const) {
    assert.ok(c[cat].enabled, `${cat} enabled at baseline`);
    assert.equal(c[cat].intensity, BASELINE, `${cat} intensity is exactly baseline`);
  }
  assert.equal(disablesAllImplementedEdits(c), false);
});

test("planned categories never become generation controls", () => {
  const plan = resolveEditRecipe({ selectedVideoType: "reels-shorts", signals: FULL_SIGNALS });
  // Reels plans captions (no transcript executor) — still flagged planned…
  const planned = plan.operations.filter((o) => o.planned).map((o) => o.category);
  assert.ok(planned.includes("captions"), "captions is a planned category");
  // …and the controls object only exposes the implemented engines, so a planned
  // category has no channel to affect preview/export.
  const c = editGenerationControls(plan);
  assert.deepEqual(Object.keys(c).sort(), [
    "cut",
    "effectiveVideoType",
    "fromRecipe",
    "recipeName",
    "requestedVideoType",
    "speed",
    "zoom",
  ]);
});

test("a recipe that omits a category disables it (Podcast → no zoom)", () => {
  const c = controlsFor("podcast-clip");
  assert.equal(c.zoom.enabled, false, "podcast has no zoom op → zoom off");
  assert.ok(c.cut.enabled && c.speed.enabled, "podcast still cuts + trims");
  // Vlog also intentionally omits zoom.
  assert.equal(controlsFor("vlog").zoom.enabled, false);
});

test("all-disabled implemented plan triggers the empty-timeline fallback", () => {
  const disabledPlan: EditRecipePlan = {
    requestedVideoType: "podcast-clip",
    effectiveVideoType: "podcast-clip",
    recipeName: "Test",
    summary: "",
    operations: [
      { category: "cut", enabled: false, priority: 0.5, planned: false },
      { category: "zoom", enabled: false, priority: 0.5, planned: false },
      { category: "speed", enabled: false, priority: 0.5, planned: false },
    ],
    enabledCategories: [],
    disabledCategories: ["cut", "zoom", "speed"],
    reasons: {},
  };
  const c = editGenerationControls(disabledPlan);
  assert.ok(
    disablesAllImplementedEdits(c),
    "orchestrator must detect this and keep safe cuts (no empty timeline)"
  );
});
