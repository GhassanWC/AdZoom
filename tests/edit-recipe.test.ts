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
  recipeGenerationDefaults,
  resolveInitialGenerationToggles,
  GENERATION_TOGGLE_KEYS,
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
  hasUsableSpeech: true,
  silenceSegmentCount: 5,
  hasSceneData: true,
  hasVisualMoments: true,
  hasInteractionData: true,
  isScreenRecording: true,
  durationSeconds: 120,
};
const NO_SIGNALS = {
  hasTranscript: false,
  hasAudioAnalysis: false,
  hasUsableSpeech: false,
  silenceSegmentCount: 0,
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
  // Phase 3 + 4 — now implemented (render + export + generate). Phase 4 added
  // captions (transcript-driven).
  const nowImplemented: EditOperationCategory[] = [
    "hook_text", "text_overlay", "callout", "branding", "smart_crop", "transition", "captions",
  ];
  for (const c of nowImplemented) assert.ok(IMPLEMENTED_CATEGORIES.has(c), `${c} should be implemented`);
  // Still planned: blur (no auto-detector), silence removal + audio/broll (no executor).
  const planned: EditOperationCategory[] = [
    "blur_redaction", "music", "silence_removal", "audio_cleanup", "freeze_frame", "broll_overlay",
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
  // Reels plans silence_removal (no executor yet) — still flagged planned…
  const planned = plan.operations.filter((o) => o.planned).map((o) => o.category);
  assert.ok(planned.includes("silence_removal"), "silence_removal is a planned category");
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

// ── Phase 4 — transcript / audio recipe gating ──────────────────────────────

test("recipe enables captions ONLY when a transcript exists", () => {
  const withT = resolveEditRecipe({ selectedVideoType: "talking-head", signals: FULL_SIGNALS });
  assert.ok(withT.enabledCategories.includes("captions"), "captions enabled with a transcript");

  const noT = resolveEditRecipe({
    selectedVideoType: "talking-head",
    signals: { ...FULL_SIGNALS, hasTranscript: false },
  });
  assert.ok(noT.disabledCategories.includes("captions"), "captions disabled without a transcript");
  assert.match(noT.reasons.captions, /transcript/i);
});

test("recipe enables silence_removal ONLY with usable speech + detected silence", () => {
  const withAudio = resolveEditRecipe({ selectedVideoType: "reels-shorts", signals: FULL_SIGNALS });
  assert.ok(withAudio.enabledCategories.includes("silence_removal"), "enabled with audio + silence");

  const noSpeech = resolveEditRecipe({
    selectedVideoType: "reels-shorts",
    signals: { ...FULL_SIGNALS, hasUsableSpeech: false },
  });
  assert.ok(noSpeech.disabledCategories.includes("silence_removal"), "disabled without usable speech");

  const noSilence = resolveEditRecipe({
    selectedVideoType: "reels-shorts",
    signals: { ...FULL_SIGNALS, silenceSegmentCount: 0 },
  });
  assert.ok(noSilence.disabledCategories.includes("silence_removal"), "disabled without silence");
});

test("audio_cleanup stays PLANNED even when audio analysis is available", () => {
  const plan = resolveEditRecipe({ selectedVideoType: "talking-head", signals: FULL_SIGNALS });
  const op = plan.operations.find((o) => o.category === "audio_cleanup");
  if (op) assert.equal(op.planned, true, "audio_cleanup has no executor yet → planned");
});

// ── Analyze modal — generation toggles + per-type defaults ──────────────────

test("generation toggles cover ONLY implemented auto types — no blur / audio", () => {
  assert.equal(GENERATION_TOGGLE_KEYS.length, 10);
  const expected = [
    "generateCameraEdits", "generateCut", "generateSpeed",
    "generateCaptions", "generateHookText", "generateTextOverlays",
    "generateSmartCrop", "generateCallouts", "generateTransitions", "generateCta",
  ];
  assert.deepEqual([...GENERATION_TOGGLE_KEYS].sort(), [...expected].sort());
  // Blur is manual-only; audio/silence/music have no executor → never a toggle.
  assert.ok(!GENERATION_TOGGLE_KEYS.some((k) => /blur|audio|silence|music|broll/i.test(k)));
});

test("recipeGenerationDefaults differ by video type (recipe-driven smart defaults)", () => {
  const reels = recipeGenerationDefaults("reels-shorts");
  assert.ok(
    reels.generateCaptions && reels.generateHookText && reels.generateSmartCrop &&
      reels.generateCta && reels.generateCut && reels.generateSpeed && reels.generateCameraEdits,
    "reels turns on captions/hook/smart-crop/cta/cuts/speed/camera"
  );

  const talking = recipeGenerationDefaults("talking-head");
  assert.ok(talking.generateCaptions && talking.generateHookText && talking.generateSmartCrop);
  assert.equal(talking.generateTransitions, false, "talking-head has no transitions default");

  const demo = recipeGenerationDefaults("product-demo");
  assert.ok(demo.generateCallouts && demo.generateTextOverlays && demo.generateCta && demo.generateCameraEdits);

  const screen = recipeGenerationDefaults("screen-recording");
  assert.ok(
    screen.generateCameraEdits && screen.generateCallouts && screen.generateTextOverlays &&
      screen.generateCut && screen.generateSpeed
  );

  const promo = recipeGenerationDefaults("ad-promo");
  assert.equal(promo.generateTransitions, true, "ad-promo turns transitions on");
  assert.equal(promo.generateHookText, true);

  // Different types → different toggle sets.
  assert.notDeepEqual(reels, talking);
  assert.notDeepEqual(demo, reels);
});

test("Auto Detect defaults are all-on (regression: Auto must not pre-suppress overlays)", () => {
  // Bug: Auto Detect used to seed only a few overlay categories, so the modal's
  // `allow` map suppressed hook/cta/text/callout/transition even when analysis
  // detected e.g. Reels — leaving only cuts/zooms/speeds. Auto must be permissive
  // and let the DETECTED recipe gate categories at generation time.
  const auto = recipeGenerationDefaults("auto");
  for (const k of GENERATION_TOGGLE_KEYS) {
    assert.equal(auto[k], true, `Auto Detect must default ${k} on`);
  }
});

test("resolveInitialGenerationToggles: fresh run = recipe defaults; re-analyze respects saved-off", () => {
  const recipeDefaults = recipeGenerationDefaults("reels-shorts");
  // Fresh run → the recipe defaults verbatim.
  assert.deepEqual(
    resolveInitialGenerationToggles({ recipeDefaults, lastRun: null, corePrefs: null }),
    recipeDefaults
  );
  // Re-analyze: what the user turned off last run stays off.
  const re = resolveInitialGenerationToggles({
    recipeDefaults,
    lastRun: { generateCaptions: false, generateCta: false },
  });
  assert.equal(re.generateCaptions, false, "saved captions-off respected");
  assert.equal(re.generateCta, false, "saved cta-off respected");
  assert.equal(re.generateHookText, recipeDefaults.generateHookText, "untouched key keeps recipe default");
  // Remembered core prefs override the recipe default when there's no last run.
  const core = resolveInitialGenerationToggles({ recipeDefaults, corePrefs: { generateCut: false } });
  assert.equal(core.generateCut, false);
});
