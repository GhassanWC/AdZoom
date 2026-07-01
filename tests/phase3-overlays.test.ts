/**
 * Phase 3 — Core AI Edit Pack. Locks the acceptance criteria for the new visible
 * edit types: the deterministic overlay generators honor the recipe, captions
 * are NEVER faked (no transcript), callouts come from real targets, social types
 * get a vertical smart-crop + CTA, planned/unsupported categories never leak into
 * the export, and existing cut/zoom/speed timelines keep working + still load.
 *
 * Run with:  npm test   (node --test, native TS strip).
 * `overlay-generators.ts` + `edit-recipe.ts` use type-only `@/` imports, so they
 * load cleanly via relative paths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveEditRecipe } from "../src/lib/analysis/edit-recipe.ts";
import { generateOverlayEdits } from "../src/lib/analysis/overlay-generators.ts";
import {
  activeOverlays,
  hasOverlayMoments,
} from "../src/lib/render/overlay-draw.ts";

const SIGNALS = {
  hasTranscript: false, // NO transcript pipeline exists — captions must never fake words
  hasAudioAnalysis: false,
  hasSceneData: true,
  hasVisualMoments: true,
  hasInteractionData: true,
  isScreenRecording: false,
  durationSeconds: 30,
};

function planFor(t, over = {}) {
  return resolveEditRecipe({ selectedVideoType: t, signals: { ...SIGNALS, ...over } });
}

/** A grounded click moment the callout generator should pick up. */
function clickMoment(id, start) {
  return {
    id,
    startTime: start,
    endTime: start + 2,
    label: "Open the settings menu",
    reason: "",
    focusRegion: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
    effectType: "click-highlight",
    targetRegionSource: "click-event",
    confidenceScore: 0.8,
    attentionScore: 0.7,
  };
}

test("Reels generates hook text + a 9:16 smart crop when the recipe enables them", () => {
  const res = generateOverlayEdits({
    plan: planFor("reels-shorts"),
    moments: [],
    duration: 30,
    projectTitle: "My Big Reel",
    hasOutputCanvas: false,
  });
  assert.ok(res.moments.some((m) => m.effectType === "hook-text"), "hook text generated");
  const hook = res.moments.find((m) => m.effectType === "hook-text");
  assert.equal(hook?.hookText?.text, "My Big Reel", "hook uses the real project title");
  assert.ok(res.outputCanvas, "smart crop applies an output canvas");
  assert.equal(res.outputCanvas?.aspectRatio, "9:16", "reels reframes to 9:16");
  assert.ok(res.moments.some((m) => m.effectType === "smart-crop"), "smart-crop record on timeline");
});

test("captions are NEVER auto-generated (no transcript = no fake words)", () => {
  for (const t of ["reels-shorts", "talking-head", "podcast-clip", "tutorial"]) {
    const res = generateOverlayEdits({
      plan: planFor(t),
      moments: [],
      duration: 40,
      projectTitle: "Title",
      hasOutputCanvas: false,
    });
    assert.ok(
      res.moments.every((m) => m.effectType !== "captions"),
      `${t} must not fabricate captions`
    );
  }
});

test("Ad/Promo generates a CTA end-card", () => {
  const res = generateOverlayEdits({
    plan: planFor("ad-promo"),
    moments: [],
    duration: 25,
    projectTitle: "Promo",
    hasOutputCanvas: false,
  });
  const cta = res.moments.find((m) => m.effectType === "branding-cta");
  assert.ok(cta, "CTA generated");
  assert.ok((cta?.brandingCta?.ctaText ?? "").length > 0, "CTA has text");
  assert.ok(cta && cta.startTime > 15, "CTA sits near the end");
});

test("Product Demo generates callouts from important click moments", () => {
  const res = generateOverlayEdits({
    plan: planFor("product-demo"),
    moments: [clickMoment("a", 5), clickMoment("b", 12)],
    duration: 30,
    projectTitle: "Demo",
    hasOutputCanvas: false,
  });
  const callouts = res.moments.filter((m) => m.effectType === "callout");
  assert.ok(callouts.length >= 1, "callouts generated from grounded targets");
  assert.equal(callouts[0].callout?.text, "Open the settings menu", "callout reuses the real label");
});

test("Screen Recording generates callouts from interaction moments", () => {
  const res = generateOverlayEdits({
    plan: planFor("screen-recording", { isScreenRecording: true, hasInteractionData: true }),
    moments: [clickMoment("a", 3)],
    duration: 30,
    projectTitle: "Recording",
    hasOutputCanvas: false,
  });
  assert.ok(res.moments.some((m) => m.effectType === "callout"), "screen-rec callouts generated");
});

test("smart crop reframes social types but not tutorials", () => {
  const reels = generateOverlayEdits({ plan: planFor("reels-shorts"), moments: [], duration: 20, projectTitle: "R", hasOutputCanvas: false });
  const promo = generateOverlayEdits({ plan: planFor("ad-promo"), moments: [], duration: 20, projectTitle: "P", hasOutputCanvas: false });
  const tut = generateOverlayEdits({ plan: planFor("tutorial"), moments: [], duration: 20, projectTitle: "T", hasOutputCanvas: false });
  assert.equal(reels.outputCanvas?.aspectRatio, "9:16");
  assert.equal(promo.outputCanvas?.aspectRatio, "9:16");
  assert.equal(tut.outputCanvas, undefined, "tutorial keeps the source aspect");
});

test("smart crop never overrides a user's own output canvas", () => {
  const res = generateOverlayEdits({
    plan: planFor("reels-shorts"),
    moments: [],
    duration: 20,
    projectTitle: "R",
    hasOutputCanvas: true, // user already chose a canvas
  });
  assert.equal(res.outputCanvas, undefined, "respects the user's canvas");
  assert.ok(res.moments.every((m) => m.effectType !== "smart-crop"));
});

test("planned/unsupported categories never appear as generated edits", () => {
  const res = generateOverlayEdits({
    plan: planFor("reels-shorts"),
    moments: [],
    duration: 30,
    projectTitle: "R",
    hasOutputCanvas: false,
  });
  const allowed = new Set([
    "hook-text", "text-overlay", "callout", "branding-cta", "transition", "smart-crop",
  ]);
  for (const m of res.moments) {
    assert.ok(allowed.has(m.effectType), `unexpected generated type ${m.effectType}`);
  }
  // music / silence_removal / blur are never emitted.
  assert.ok(res.moments.every((m) => m.effectType !== "blur-redaction"));
});

test("generation is idempotent — a pre-existing overlay of a type is not duplicated", () => {
  const existingHook = {
    id: "h1", startTime: 0.1, endTime: 2, label: "Hook", reason: "",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 }, effectType: "hook-text",
    source: "user", edited: true,
    hookText: { text: "Mine", stylePreset: "bold", position: "center", animation: "pop" },
  };
  const res = generateOverlayEdits({
    plan: planFor("reels-shorts"),
    moments: [existingHook],
    duration: 30,
    projectTitle: "R",
    hasOutputCanvas: false,
  });
  assert.ok(res.moments.every((m) => m.effectType !== "hook-text"), "existing hook not duplicated");
});

test("a null plan / zero duration produces no overlays (old behavior preserved)", () => {
  assert.equal(generateOverlayEdits({ plan: null, moments: [], duration: 30, hasOutputCanvas: false }).moments.length, 0);
  assert.equal(generateOverlayEdits({ plan: planFor("reels-shorts"), moments: [], duration: 0, hasOutputCanvas: false }).moments.length, 0);
});

test("generator returns ONLY additive overlays — never mutates the cut/zoom/speed pool", () => {
  const cut = { id: "c", startTime: 4, endTime: 6, label: "Cut", reason: "", focusRegion: { x: 0, y: 0, width: 1, height: 1 }, effectType: "cut", cut: { active: true } };
  const zoom = { id: "z", startTime: 8, endTime: 10, label: "Zoom", reason: "", focusRegion: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 }, effectType: "zoom" };
  const input = [cut, zoom];
  const res = generateOverlayEdits({ plan: planFor("reels-shorts"), moments: input, duration: 30, projectTitle: "R", hasOutputCanvas: false });
  // Input untouched; results are all overlay/framing types (never cut/zoom/speed).
  assert.equal(input.length, 2);
  assert.ok(res.moments.every((m) => m.effectType !== "cut" && m.effectType !== "zoom" && m.effectType !== "speed-up"));
});

test("overlay generators run around a real transition when cuts exist", () => {
  const cuts = [
    { id: "c1", startTime: 5, endTime: 7, label: "Cut", reason: "", focusRegion: { x: 0, y: 0, width: 1, height: 1 }, effectType: "cut", cut: { active: true } },
    { id: "c2", startTime: 12, endTime: 14, label: "Cut", reason: "", focusRegion: { x: 0, y: 0, width: 1, height: 1 }, effectType: "cut", cut: { active: true } },
  ];
  const res = generateOverlayEdits({ plan: planFor("reels-shorts"), moments: cuts, duration: 30, projectTitle: "R", hasOutputCanvas: false });
  assert.ok(res.moments.some((m) => m.effectType === "transition"), "reels adds transitions around cuts");
});

// ── overlay-draw selection (pure, no canvas) ────────────────────────────────

test("activeOverlays splits output-anchored vs in-camera by type + time", () => {
  const moments = [
    { id: "cap", startTime: 0, endTime: 5, effectType: "captions", label: "", reason: "", focusRegion: { x: 0, y: 0, width: 1, height: 1 }, captions: { text: "hi", stylePreset: "clean", position: "bottom" } },
    { id: "call", startTime: 0, endTime: 5, effectType: "callout", label: "", reason: "", focusRegion: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, callout: { text: "x", style: "box" } },
    { id: "zoom", startTime: 0, endTime: 5, effectType: "zoom", label: "", reason: "", focusRegion: { x: 0, y: 0, width: 1, height: 1 } },
  ];
  const at2 = activeOverlays(moments, 2);
  assert.equal(at2.output.length, 1, "caption is output-anchored");
  assert.equal(at2.inCamera.length, 1, "callout is in-camera");
  // Nothing active outside the window.
  const at9 = activeOverlays(moments, 9);
  assert.equal(at9.output.length + at9.inCamera.length, 0);
});

test("hasOverlayMoments ignores plain camera/timing timelines (old projects)", () => {
  const old = [
    { id: "z", startTime: 0, endTime: 2, effectType: "zoom", label: "", reason: "", focusRegion: { x: 0, y: 0, width: 1, height: 1 } },
    { id: "c", startTime: 3, endTime: 5, effectType: "cut", label: "", reason: "", focusRegion: { x: 0, y: 0, width: 1, height: 1 }, cut: { active: true } },
  ];
  assert.equal(hasOverlayMoments(old), false, "no overlays on a legacy timeline");
});
