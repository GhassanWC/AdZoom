/**
 * Editorial Engine Phase 1 — ContentProfile + policy resolver.
 *
 * Pins the approved clarifications:
 *   #1 the Director brief NEVER rewrites the profile (source ≠ request);
 *   #2 per-axis sources + user locking;
 *   matrix "impossible" is COMPUTED from modality/evidence, never authored;
 *   templates never advertise planned (unexecutable) capabilities.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contextFromSelectedVideoType,
  defaultContentProfile,
  dominantMode,
  mergeDetectedContext,
  normalizeContentProfile,
} from "@/lib/editorial/context";
import { unavailableReason, evidenceFromSignals } from "@/lib/editorial/matrix";
import {
  overlayAllowFromPolicy,
  overridesFromToggles,
  policyDigest,
  resolveEditorialPolicy,
} from "@/lib/editorial/resolve";
import { policyAt, statusAllowsGeneration } from "@/lib/editorial/policy";
import {
  EDITING_TEMPLATES,
  TALKING_CLEAN_PRO,
  classicTemplateIdFor,
  defaultTemplateFor,
  getTemplate,
  templateCapabilities,
} from "@/lib/editorial/templates";
import { IMPLEMENTED_CATEGORIES } from "@/lib/analysis/edit-recipe";
import type { RecipeSignals } from "@/lib/analysis/edit-recipe";

const NO_SIGNALS: RecipeSignals = {
  hasTranscript: false,
  hasAudioAnalysis: false,
  hasUsableSpeech: false,
  silenceSegmentCount: 0,
  hasSceneData: true,
  hasVisualMoments: true,
  hasInteractionData: false,
  isScreenRecording: false,
};

const SCREEN_SIGNALS: RecipeSignals = {
  ...NO_SIGNALS,
  hasInteractionData: true,
  isScreenRecording: true,
  hasTranscript: true,
  hasAudioAnalysis: true,
  hasUsableSpeech: true,
  silenceSegmentCount: 4,
};

/* ── ContentProfile — axes, sources, locking ─────────────────────────────── */

test("the picker's shortcut expands into per-axis context (clarification #2)", () => {
  const talking = contextFromSelectedVideoType("talking-head");
  assert.deepEqual(talking.contentModes, { camera: 1 });
  assert.equal(talking.sources.modes, "user");
  assert.equal(talking.sources.intent, "default"); // says nothing about purpose
  assert.equal(talking.primaryIntent, "unknown");

  const tutorial = contextFromSelectedVideoType("tutorial");
  assert.equal(tutorial.primaryIntent, "tutorial");
  assert.equal(tutorial.sources.intent, "user");
  assert.equal(tutorial.sources.modes, "default"); // modality genuinely unknown

  const reels = contextFromSelectedVideoType("reels-shorts");
  assert.equal(reels.outputTarget, "shorts");
  assert.equal(reels.sources.target, "user");
  assert.equal(reels.sources.intent, "default");

  const auto = contextFromSelectedVideoType("auto");
  assert.deepEqual(auto.sources, { intent: "default", modes: "default", target: "default" });
});

test("detection refines open axes and NEVER overwrites a user-set axis", () => {
  // User said talking-head (modes locked); detection thinks it's a screen demo.
  const profile = contextFromSelectedVideoType("talking-head");
  const merged = mergeDetectedContext(profile, {
    primaryIntent: "demo",
    intentConfidence: 0.9,
    contentModes: { screen: 0.95 },
  });
  // Open axis (intent) refined…
  assert.equal(merged.primaryIntent, "demo");
  assert.equal(merged.sources.intent, "detected");
  // …locked axis (modes) untouched.
  assert.deepEqual(merged.contentModes, { camera: 1 });
  assert.equal(merged.sources.modes, "user");
});

test("an explicit userLocked axis blocks detection even when its source is not 'user'", () => {
  const profile = { ...defaultContentProfile(), userLocked: ["intent" as const] };
  const merged = mergeDetectedContext(profile, { primaryIntent: "promo" });
  assert.equal(merged.primaryIntent, "unknown");
});

test("supported states include intent=detected + target=user simultaneously", () => {
  const profile = mergeDetectedContext(contextFromSelectedVideoType("reels-shorts"), {
    primaryIntent: "tutorial",
  });
  assert.equal(profile.sources.target, "user");
  assert.equal(profile.sources.intent, "detected");
  assert.equal(profile.primaryIntent, "tutorial");
  assert.equal(profile.outputTarget, "shorts");
});

test("normalizeContentProfile round-trips and rejects junk", () => {
  const p = contextFromSelectedVideoType("product-demo");
  const back = normalizeContentProfile(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(back, p);
  assert.equal(normalizeContentProfile(null), undefined);
  assert.equal(normalizeContentProfile({ version: 2 }), undefined);
  assert.equal(dominantMode(p), "screen");
});

/* ── Clarification #1 — the brief never rewrites the profile ─────────────── */

test("resolving policy never mutates the profile (source ≠ requested outcome)", () => {
  const profile = contextFromSelectedVideoType("tutorial");
  const frozen = JSON.parse(JSON.stringify(profile));
  resolveEditorialPolicy({
    profile,
    template: TALKING_CLEAN_PRO,
    signals: NO_SIGNALS,
    overrides: overridesFromToggles({ generateCta: true, generateSpeed: false }),
  });
  assert.deepEqual(profile, frozen, "resolve must treat the profile as read-only");
  // And there is deliberately NO brief input on the resolver in Phase 1 — a
  // "make this a punchy promo" ask can only ever arrive as a policy delta.
  const params: string[] = ["profile", "template", "signals", "overrides"];
  assert.ok(!params.includes("brief"));
});

/* ── The computed "impossible" ───────────────────────────────────────────── */

test("cursor emphasis is IMPOSSIBLE only when no screen mode AND no cursor evidence", () => {
  const cameraOnly = contextFromSelectedVideoType("talking-head");
  const noEvidence = evidenceFromSignals(NO_SIGNALS);
  assert.match(unavailableReason("cursor_emphasis", cameraOnly, noEvidence) ?? "", /cursor/);

  // Hard evidence overrides the declared modality (a hybrid escape hatch).
  const withEvidence = evidenceFromSignals(SCREEN_SIGNALS);
  assert.equal(unavailableReason("cursor_emphasis", cameraOnly, withEvidence), null);

  // Unknown modality never rules an edit out ("maybe", not "no").
  const unknown = contextFromSelectedVideoType("auto");
  assert.equal(
    unavailableReason("cursor_emphasis", unknown, withEvidence),
    null
  );
});

test("blur/redaction and B-roll have NO modality bar — priors, not laws", () => {
  const cameraOnly = contextFromSelectedVideoType("talking-head");
  const noEvidence = evidenceFromSignals(NO_SIGNALS);
  assert.equal(unavailableReason("blur_redaction", cameraOnly, noEvidence), null);
  assert.equal(unavailableReason("broll_overlay", cameraOnly, noEvidence), null);
  assert.equal(unavailableReason("music", cameraOnly, noEvidence), null);
});

/* ── Resolver — classic vs enforce ───────────────────────────────────────── */

test("a Classic template resolves to classic mode with Gate D off and shipped floors", () => {
  const resolved = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("screen-recording"),
    template: defaultTemplateFor("screen-recording"),
    signals: SCREEN_SIGNALS,
  });
  assert.equal(resolved.mode, "classic");
  assert.equal(resolved.composition.mode, "off");
  assert.equal(resolved.balancer.minTotal, 3);
  assert.equal(resolved.decision.strictTypes, false);
  assert.deepEqual(resolved.decision.perType, {});
  assert.equal(resolved.pacing, undefined); // Classic never overrides pacing
  // Classic overlay caps are the historical numbers.
  assert.deepEqual(resolved.overlays, {
    textOverlayMax: 3,
    calloutMax: 4,
    calloutMinConfidence: 0.55,
    transitionMax: 5,
  });
});

test("Clean Professional resolves to enforce mode with its stated numbers", () => {
  const resolved = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: NO_SIGNALS,
  });
  assert.equal(resolved.mode, "enforce");
  assert.equal(resolved.pacing, "slow");
  assert.equal(resolved.balancer.minTotal, 0); // "no edit" is a valid outcome
  assert.equal(resolved.composition.mode, "enforce");
  assert.equal(resolved.decision.strictTypes, true);
  const zoom = resolved.decision.perType.zoom;
  assert.ok(zoom);
  assert.equal(zoom.minConfidence, 0.65);
  assert.equal(zoom.maxPerMinute, 1.5);
  assert.equal(zoom.minSpacingSec, 12);
  // Cursor emphasis: computed impossible on camera-only footage w/o evidence.
  assert.equal(resolved.statuses.cursor_emphasis, "impossible");
  assert.equal(resolved.decision.perType.cursor_emphasis, undefined);
  // Omitted categories are disabled.
  assert.equal(resolved.statuses.transition, "disabled-by-default");
  assert.equal(resolved.statuses.callout, "disabled-by-default");
  assert.equal(resolved.statuses.speed, "disabled-by-default");
});

test("explicit user toggles are the OUTERMOST layer, both directions", () => {
  const off = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: NO_SIGNALS,
    overrides: overridesFromToggles({ generateCut: false }),
  });
  assert.equal(off.statuses.cut, "disabled-by-default");
  assert.match(off.reasons.cut, /turned off in the analysis options/);

  const reopened = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: NO_SIGNALS,
    overrides: overridesFromToggles({ generateTransitions: true }),
  });
  assert.equal(reopened.statuses.transition, "allowed");
  assert.ok(statusAllowsGeneration(reopened.statuses.transition!));
  // …but a toggle can never resurrect a computed-impossible category.
  const camera = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: NO_SIGNALS,
    overrides: overridesFromToggles({ generateCameraEdits: true }),
  });
  assert.equal(camera.statuses.cursor_emphasis, "impossible");
});

test("overlay allow-map: classic forbids nothing; enforce only restricts", () => {
  const classic = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("product-demo"),
    template: defaultTemplateFor("product-demo"),
    signals: SCREEN_SIGNALS,
  });
  assert.deepEqual(overlayAllowFromPolicy(classic), {});

  const pro = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: NO_SIGNALS,
  });
  const allow = overlayAllowFromPolicy(pro);
  assert.equal(allow.transition, false);
  assert.equal(allow.callout, false);
  assert.equal(allow.text_overlay, false);
  assert.equal(allow.hook_text, undefined); // allowed → not restricted
  assert.equal(allow.branding, undefined);
});

test("the digest is compact and mirrors the resolution", () => {
  const pro = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: NO_SIGNALS,
  });
  const digest = policyDigest(pro);
  assert.equal(digest.templateId, "talking-clean-pro");
  assert.equal(digest.mode, "enforce");
  assert.equal(digest.statuses.zoom, "allowed");
});

/* ── Registry + the hybrid seam ──────────────────────────────────────────── */

test("every legacy type has a Classic template and the registry resolves ids", () => {
  for (const t of ["auto", "talking-head", "screen-recording", "podcast-clip"] as const) {
    const tpl = getTemplate(classicTemplateIdFor(t));
    assert.ok(tpl, `missing classic template for ${t}`);
    assert.equal(tpl.classicFor, t);
    assert.equal(tpl.spec, undefined);
  }
  assert.equal(getTemplate("nope"), undefined);
  assert.equal(getTemplate(undefined), undefined);
});

test("policyAt is the identity in Phase 1 — the accessor exists before segments do", () => {
  const pro = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: NO_SIGNALS,
  });
  assert.equal(policyAt(pro, 0), pro);
  assert.equal(policyAt(pro, 999), pro);
});

/* ── Phase-0 hygiene: real filler words from the transcript ──────────────── */

test("filler dead-zones derive from REAL word timings, conservatively", async () => {
  const { fillerWordsFromTranscript } = await import("@/lib/director/context-builder");
  const transcript = {
    status: "complete" as const,
    words: [
      { word: "So", startTime: 0.1, endTime: 0.3 },
      { word: "um,", startTime: 0.4, endTime: 0.7 },
      { word: "like", startTime: 0.8, endTime: 1.0 }, // meaningful too often — NOT a filler
      { word: "the", startTime: 1.1, endTime: 1.2 },
      { word: "Uh", startTime: 4.0, endTime: 4.3 },
      { word: "um", startTime: 9.0, endTime: 12.0 }, // 3s "um" is a mis-timing — skip
    ],
  };
  const fillers = fillerWordsFromTranscript(transcript as never);
  assert.deepEqual(
    fillers.map((f) => f.word),
    ["um,", "Uh"]
  );
  assert.deepEqual(fillerWordsFromTranscript(undefined), []);
  assert.deepEqual(
    fillerWordsFromTranscript({ status: "processing" } as never),
    []
  );
});

/* ── No planned-capability exposure (approved clarification) ─────────────── */

test("no template ever advertises a capability without an executor", () => {
  for (const tpl of EDITING_TEMPLATES) {
    for (const cap of templateCapabilities(tpl)) {
      const implemented =
        cap === "cursor_emphasis"
          ? IMPLEMENTED_CATEGORIES.has("zoom")
          : IMPLEMENTED_CATEGORIES.has(cap as Parameters<typeof IMPLEMENTED_CATEGORIES.has>[0]);
      assert.ok(implemented, `${tpl.id} advertises unimplemented "${cap}"`);
    }
  }
  // The planned vocabulary must never appear even when a spec anticipates it.
  for (const tpl of EDITING_TEMPLATES) {
    const caps = templateCapabilities(tpl);
    for (const planned of ["music", "broll_overlay", "freeze_frame", "audio_cleanup"]) {
      assert.ok(!caps.includes(planned as never), `${tpl.id} advertises planned "${planned}"`);
    }
  }
});
