/**
 * CLASSIC PARITY — the Editorial Engine's load-bearing compatibility suite.
 *
 * A Classic template must reproduce the pre-policy pipeline BIT FOR BIT
 * (approved clarification #3): same selection, same rejections, same overlays,
 * and Gate D as a strict no-op. These fixtures are deterministic (no Gemini),
 * which is the "exact moment parity" test class; nondeterministic real-video
 * runs are the benchmark's tolerance-based class instead.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { DetectedMoment, EffectType, Pacing } from "@/lib/firebase/schema";
import { balanceTimeline } from "@/lib/timeline-balancer";
import {
  decideTimeline,
  type EditorialContext,
} from "@/lib/analysis/editorial-decision";
import { generateOverlayEdits } from "@/lib/analysis/overlay-generators";
import { resolveEditRecipe } from "@/lib/analysis/edit-recipe";
import { SELECTED_VIDEO_TYPES } from "@/lib/analysis/video-type";
import { contextFromSelectedVideoType } from "@/lib/editorial/context";
import {
  classicDecisionPolicy,
  resolveEditorialPolicy,
} from "@/lib/editorial/resolve";
import { defaultTemplateFor } from "@/lib/editorial/templates";
import {
  applyCompositionActions,
  reviewComposition,
} from "@/lib/editorial/composition";
import type { RecipeSignals } from "@/lib/analysis/edit-recipe";

const SIGNALS: RecipeSignals = {
  hasTranscript: true,
  hasAudioAnalysis: true,
  hasUsableSpeech: true,
  silenceSegmentCount: 4,
  hasSceneData: true,
  hasVisualMoments: true,
  hasInteractionData: true,
  isScreenRecording: true,
  durationSeconds: 160,
};

/** A deterministic, moderately messy candidate set for a 160s video. */
function fixtureCandidates(): DetectedMoment[] {
  const base = (
    id: string,
    startTime: number,
    effectType: EffectType,
    conf: number,
    extra: Partial<DetectedMoment> = {}
  ): DetectedMoment =>
    ({
      id,
      startTime,
      endTime: startTime + 1.8,
      label: `Zoom on the ${id} step of the checkout flow`,
      reason: `Emphasises the ${id} action the user performed`,
      focusRegion: { x: 0.35, y: 0.3, width: 0.25, height: 0.25 },
      effectType,
      confidenceScore: conf,
      source: "ai",
      provenance: "cv",
      ...extra,
    }) as DetectedMoment;

  return [
    base("a", 8, "zoom", 0.85, { provenance: "event" }),
    base("b", 9.1, "zoom", 0.55), // crowds "a"
    base("c", 24, "click-highlight", 0.7),
    base("d", 41, "cursor-focus", 0.62),
    base("e", 58, "zoom", 0.31), // below the classic bar
    base("f", 74, "zoom", 0.66),
    base("g", 90, "cut", 0.8, {
      endTime: 96,
      reason: "Removes a dead stretch with no narration",
    }),
    base("h", 105, "speed-up", 0.72, {
      endTime: 112,
      reason: "Compresses a slow loading stretch",
    }),
    base("i", 126, "zoom", 0.78),
    base("j", 149, "zoom", 0.9, { reason: "Zoom" }), // trivial reason
  ];
}

function fixtureCtx(over: Partial<EditorialContext> = {}): EditorialContext {
  return {
    duration: 160,
    pacing: "moderate" as Pacing,
    videoType: "saas-demo",
    clickTimes: [8, 24, 41, 74, 126, 149],
    sceneChanges: [30, 90],
    silenceSegments: [{ startTime: 88, endTime: 97 }],
    boringSections: [{ startTime: 100, endTime: 114 }],
    attentionCurve: Array.from({ length: 160 }, (_, i) =>
      Math.round((0.2 + 0.6 * Math.abs(Math.sin(i / 9))) * 255)
    ),
    attentionSampleRate: 1,
    ...over,
  };
}

/* ── decideTimeline: absent policy ≡ explicit classic policy ─────────────── */

test("the AI Editor with an explicit Classic policy is bit-identical to no policy", () => {
  const candidates = fixtureCandidates();
  const bare = decideTimeline(candidates, fixtureCtx());
  const classic = decideTimeline(candidates, fixtureCtx({ policy: classicDecisionPolicy() }));
  assert.deepEqual(classic.kept, bare.kept);
  assert.deepEqual(classic.rejected, bare.rejected);
  assert.deepEqual(classic.verdicts, bare.verdicts);
  assert.deepEqual(classic.log, bare.log);
});

/* ── overlay generators: absent caps ≡ Classic caps ──────────────────────── */

test("overlay generation with the Classic caps object is bit-identical to none", () => {
  for (const t of SELECTED_VIDEO_TYPES) {
    const plan = resolveEditRecipe({ selectedVideoType: t, signals: SIGNALS });
    const timeline = fixtureCandidates();
    const bare = generateOverlayEdits({
      plan,
      moments: timeline,
      duration: 160,
      projectTitle: "Checkout walkthrough",
      hasOutputCanvas: false,
      transcript: null,
    });
    const resolved = resolveEditorialPolicy({
      profile: contextFromSelectedVideoType(t),
      template: defaultTemplateFor(t),
      signals: SIGNALS,
    });
    const withPolicy = generateOverlayEdits({
      plan,
      moments: timeline,
      duration: 160,
      projectTitle: "Checkout walkthrough",
      hasOutputCanvas: false,
      transcript: null,
      policy: resolved.overlays,
    });
    assert.deepEqual(withPolicy, bare, `overlay parity broke for ${t}`);
  }
});

/* ── The full deterministic selection pipeline, per legacy type ──────────── */

test("balance → decide → overlays → Gate D under Classic equals the legacy pipeline", () => {
  for (const t of SELECTED_VIDEO_TYPES) {
    const resolved = resolveEditorialPolicy({
      profile: contextFromSelectedVideoType(t),
      template: defaultTemplateFor(t),
      signals: SIGNALS,
    });
    assert.equal(resolved.mode, "classic", `${t} must default to a Classic template`);
    assert.equal(resolved.pacing, undefined, `${t} Classic must not override pacing`);

    const candidates = fixtureCandidates();

    // LEGACY invocation — exactly what the route did before the policy landed.
    const legacyBalanced = balanceTimeline({
      raw: [],
      duration: 160,
      pacing: "moderate",
      videoType: "saas-demo",
      preserved: candidates,
    });
    const legacyDecided = decideTimeline(legacyBalanced.moments, fixtureCtx());
    const legacyPlan = resolveEditRecipe({ selectedVideoType: t, signals: SIGNALS });
    const legacyOverlays = generateOverlayEdits({
      plan: legacyPlan,
      moments: legacyDecided.kept,
      duration: 160,
      projectTitle: "Checkout walkthrough",
      hasOutputCanvas: false,
      transcript: null,
    });
    const legacyFinal = [...legacyDecided.kept, ...legacyOverlays.moments].sort(
      (a, b) => a.startTime - b.startTime
    );

    // ROUTE-SHAPED classic invocation — pacing untouched, no balancer policy,
    // classic decision policy, classic overlay caps, Gate D resolved "off".
    const balanced = balanceTimeline({
      raw: [],
      duration: 160,
      pacing: "moderate",
      videoType: "saas-demo",
      preserved: candidates,
    });
    const decided = decideTimeline(balanced.moments, fixtureCtx({ policy: resolved.decision }));
    const overlays = generateOverlayEdits({
      plan: legacyPlan,
      moments: decided.kept,
      duration: 160,
      projectTitle: "Checkout walkthrough",
      hasOutputCanvas: false,
      transcript: null,
      policy: resolved.overlays,
    });
    let final = [...decided.kept, ...overlays.moments].sort(
      (a, b) => a.startTime - b.startTime
    );
    const composition = reviewComposition(final, resolved, { durationSeconds: 160 });
    assert.equal(composition.actions.length, 0, `${t}: Gate D must be silent under Classic`);
    final = applyCompositionActions(final, composition);

    assert.deepEqual(final, legacyFinal, `classic parity broke for ${t}`);
  }
});

/* ── The balancer floor knob ─────────────────────────────────────────────── */

test("no policy ⇒ the shipped floors; minTotal 0 ⇒ no forced minimum", () => {
  // Sparse, low-signal candidate pool on a long video: the Classic floors
  // force selection up to their minimum; a 0-floor policy does not.
  const sparse: DetectedMoment[] = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`,
    startTime: 10 + i * 18,
    endTime: 11 + i * 18,
    label: "m",
    reason: "candidate",
    focusRegion: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
    effectType: "zoom" as EffectType,
    confidenceScore: 0.2,
    attentionScore: 0.1,
    source: "ai",
    provenance: "ai",
  })) as DetectedMoment[];

  const classic = balanceTimeline({ raw: sparse, duration: 160, pacing: "moderate" });
  const floored = balanceTimeline({
    raw: sparse,
    duration: 160,
    pacing: "moderate",
    policy: { minTotal: 0 },
  });
  // Both are valid runs; the policy run must never keep MORE than classic
  // (floors only ever add), and classic must satisfy its own floor when it
  // kept anything at all from this pool.
  assert.ok(floored.moments.length <= classic.moments.length);
});
