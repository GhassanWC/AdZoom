/**
 * TALKING HEAD / CLEAN PROFESSIONAL — the Phase-1 quality proof, unit tier.
 *
 * A talking-head candidate pool full of the exact mistakes the audit found
 * (CV cursor-emphasis false positives from head movement, low-confidence
 * motion-peak zooms, zoom clusters, decorative overlays) must come out the
 * other side as a professional edit: cursor emphasis GONE, zooms rare +
 * confident + spaced, decoration gone, cuts intact. The benchmark replays the
 * same contract on realistic full-length signal fixtures.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { DetectedMoment, EffectType } from "@/lib/firebase/schema";
import {
  decideTimeline,
  type EditorialContext,
} from "@/lib/analysis/editorial-decision";
import { generateOverlayEdits } from "@/lib/analysis/overlay-generators";
import { resolveEditRecipe, type RecipeSignals } from "@/lib/analysis/edit-recipe";
import { contextFromSelectedVideoType } from "@/lib/editorial/context";
import {
  overlayAllowFromPolicy,
  resolveEditorialPolicy,
} from "@/lib/editorial/resolve";
import { TALKING_CLEAN_PRO, defaultTemplateFor } from "@/lib/editorial/templates";
import {
  applyCompositionActions,
  reviewComposition,
} from "@/lib/editorial/composition";

/** Talking head: real speech, no interactions, no screen. */
const SIGNALS: RecipeSignals = {
  hasTranscript: true,
  hasAudioAnalysis: true,
  hasUsableSpeech: true,
  silenceSegmentCount: 5,
  hasSceneData: true,
  hasVisualMoments: true,
  hasInteractionData: false,
  isScreenRecording: false,
  durationSeconds: 120,
};

const resolved = () =>
  resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: SIGNALS,
  });

const classicResolved = () =>
  resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: defaultTemplateFor("talking-head"),
    signals: SIGNALS,
  });

function moment(
  id: string,
  startTime: number,
  effectType: EffectType,
  conf: number,
  extra: Partial<DetectedMoment> = {}
): DetectedMoment {
  return {
    id,
    startTime,
    endTime: startTime + 1.6,
    label: `Emphasis on the ${id} moment of the delivery`,
    reason: `A motion peak suggests emphasis around the ${id} beat`,
    focusRegion: { x: 0.4, y: 0.25, width: 0.2, height: 0.3 },
    effectType,
    confidenceScore: conf,
    source: "ai",
    provenance: "cv",
    ...extra,
  } as DetectedMoment;
}

/**
 * 120s talking head. The pool is what today's pipeline realistically emits.
 * On camera footage the ATTENTION PEAKS ARE THE HEAD MOVEMENT — which is why
 * the CV cursor-emphasis false positives below sit right on attention bumps
 * and are "grounded" by Classic's rules (audit finding B.4).
 */
function talkingHeadPool(): DetectedMoment[] {
  return [
    // CV cursor-emphasis FALSE POSITIVES — head/hand motion produced an
    // inferred click + a located target, exactly as cv/visual-interactions
    // stamps them. Classic finds these grounded; Clean Professional forbids
    // the category outright.
    moment("head1", 25, "click-highlight", 0.72, {
      targetRegionSource: "cv-inferred-click",
    }),
    moment("head3", 83, "cursor-focus", 0.61, {
      targetRegionSource: "cv-inferred-click",
    }),
    // Motion-peak zooms — middling confidence.
    moment("z-weak1", 22, "zoom", 0.45),
    moment("z-weak2", 43, "zoom", 0.52),
    moment("z-strong", 60, "zoom", 0.82),
    moment("z-near", 66, "zoom", 0.7), // 6s after z-strong — under the 12s spacing
    moment("z-late", 96, "zoom", 0.75),
    // Speed-up over a quiet stretch (allowed under Classic, forbidden here).
    moment("spd", 88, "speed-up", 0.7, {
      endTime: 94,
      reason: "Compresses a slow, quiet stretch of the delivery",
    }),
    // Cuts over REAL silence — the edits Clean Professional wants.
    moment("cut1", 40, "cut", 0.8, {
      endTime: 43,
      reason: "Removes a silent pause between sentences",
    }),
    moment("cut2", 115, "cut", 0.75, {
      endTime: 118,
      reason: "Removes dead air before the closing line",
    }),
  ];
}

function talkingHeadCtx(policy: EditorialContext["policy"]): EditorialContext {
  return {
    duration: 120,
    pacing: "slow",
    policy,
    videoType: "talking-tutorial",
    clickTimes: [], // camera footage — no real clicks
    sceneChanges: [59.5, 95.6],
    silenceSegments: [
      { startTime: 39, endTime: 44 },
      { startTime: 86, endTime: 95 },
      { startTime: 113, endTime: 119 },
    ],
    attentionCurve: Array.from({ length: 120 }, (_, i) => {
      // Head-movement bumps at 25 and 83 (the false positives), plus the two
      // genuinely emphatic beats at 60 and 96.
      const peak =
        Math.exp(-((i - 25) ** 2) / 30) +
        Math.exp(-((i - 60) ** 2) / 40) +
        Math.exp(-((i - 83) ** 2) / 30) +
        Math.exp(-((i - 96) ** 2) / 40);
      return Math.round(Math.min(1, 0.15 + 0.7 * peak) * 255);
    }),
    attentionSampleRate: 1,
  };
}

/* ── The core claim ──────────────────────────────────────────────────────── */

test("Clean Professional: zero cursor emphasis, rare spaced zooms, cuts intact", () => {
  const policy = resolved();
  const r = decideTimeline(talkingHeadPool(), talkingHeadCtx(policy.decision));

  const keptTypes = r.kept.map((m) => m.effectType);
  // 1. ZERO cursor-emphasis edits (the acceptance criterion).
  assert.ok(!keptTypes.includes("click-highlight"), "no click-highlight survives");
  assert.ok(!keptTypes.includes("cursor-focus"), "no cursor-focus survives");
  for (const id of ["head1", "head3"]) {
    const rej = r.rejected.find((m) => m.id === id);
    assert.equal(rej?.rejectedReason, "policy-forbidden", `${id} must be policy-rejected`);
  }
  // 2. Speed is not part of this style.
  assert.ok(!keptTypes.includes("speed-up"));
  const spd = r.rejected.find((m) => m.id === "spd");
  assert.equal(spd?.rejectedReason, "policy-forbidden");
  // 3. Weak zooms die at the raised confidence bar.
  for (const id of ["z-weak1", "z-weak2"]) {
    const rej = r.rejected.find((m) => m.id === id);
    assert.equal(rej?.rejectedReason, "low-confidence", `${id} must miss the 0.65 bar`);
  }
  // 4. Zooms that survive respect the 12s spacing + the per-minute budget.
  const zooms = r.kept.filter((m) => m.effectType === "zoom");
  assert.ok(zooms.length >= 1, "a justified zoom does survive");
  assert.ok(zooms.length <= 3, "≤ 1.5/min on 2 minutes");
  const starts = zooms.map((z) => z.startTime).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= 12, "zoom spacing ≥ 12s");
  }
  assert.ok(!zooms.some((z) => z.id === "z-near"), "the 6s-later zoom is dropped");
  // 5. The cuts this style is FOR survive.
  assert.ok(r.kept.some((m) => m.id === "cut1"), "cut over silence survives");
  assert.ok(r.kept.some((m) => m.id === "cut2"), "closing cut survives");
});

test("Classic keeps what Clean Professional rejects — the improvement is the delta", () => {
  const classicRun = decideTimeline(
    talkingHeadPool(),
    talkingHeadCtx(classicResolved().decision)
  );
  const proRun = decideTimeline(talkingHeadPool(), talkingHeadCtx(resolved().decision));
  const inappropriate = (run: typeof classicRun) =>
    run.kept.filter(
      (m) =>
        m.effectType === "click-highlight" ||
        m.effectType === "cursor-focus" ||
        m.effectType === "speed-up"
    ).length;
  const silenceCuts = (run: typeof classicRun) =>
    run.kept.filter((m) => m.effectType === "cut").length;

  // Today's engine keeps grounded-looking cursor emphasis on a talking head
  // (audit finding B.4); the template ends it.
  assert.ok(inappropriate(classicRun) > 0, "fixture must reproduce the audited failure under Classic");
  assert.equal(inappropriate(proRun), 0, "strictly fewer inappropriate edits — zero");

  // The false positive doesn't just add noise — it CROWDS OUT a real edit:
  // under Classic the kept cursor moment spends the spacing budget next to a
  // genuine silence cut. Clean Professional keeps every justified cut.
  assert.ok(
    silenceCuts(proRun) >= silenceCuts(classicRun),
    "no missed-edit regression on the cuts this style exists for"
  );
  assert.ok(
    proRun.kept.length <= classicRun.kept.length,
    "never busier than Classic on the same footage"
  );
});

/* ── Decorative overlays ─────────────────────────────────────────────────── */

test("transitions/text labels/callouts are policy-stopped; hook + CTA still land", () => {
  const policy = resolved();
  const allowFromPolicy = overlayAllowFromPolicy(policy);
  // Route semantics: dialog toggles all on, ANDed with the template's forbids.
  const and = (toggle: boolean | undefined, key: keyof typeof allowFromPolicy) =>
    allowFromPolicy[key] === false ? false : toggle;
  const allow = {
    hook_text: and(true, "hook_text"),
    text_overlay: and(true, "text_overlay"),
    smart_crop: and(true, "smart_crop"),
    callout: and(true, "callout"),
    transition: and(true, "transition"),
    branding: and(true, "branding"),
  };

  const timeline: DetectedMoment[] = [
    moment("g1", 20, "zoom", 0.9, {
      label: "Open the billing settings panel",
      targetRegionSource: "click-event",
      attentionScore: 0.9,
    }),
    moment("g2", 50, "zoom", 0.85, {
      label: "Confirm the subscription change",
      targetRegionSource: "ui-region",
      attentionScore: 0.8,
    }),
    moment("cutA", 70, "cut", 0.8, { endTime: 74 }),
  ];
  const gen = (planType: "ad-promo" | "product-demo", withPolicy: boolean) =>
    generateOverlayEdits({
      plan: resolveEditRecipe({
        selectedVideoType: planType,
        signals: { ...SIGNALS, hasInteractionData: true, isScreenRecording: true },
      }),
      moments: timeline,
      duration: 120,
      projectTitle: "Quarterly update",
      hasOutputCanvas: false,
      transcript: null,
      ...(withPolicy ? { allow, policy: policy.overlays } : {}),
    });

  // ad-promo's recipe generates hook + transitions + text labels + CTA…
  const controlPromo = gen("ad-promo", false).moments.map((m) => m.effectType);
  assert.ok(controlPromo.includes("transition"), "control generates transitions");
  assert.ok(controlPromo.includes("text-overlay"), "control generates text labels");
  // …under Clean Professional's allow-map only hook + CTA survive.
  const proPromo = gen("ad-promo", true).moments.map((m) => m.effectType);
  assert.ok(!proPromo.includes("transition"), "no transitions under Clean Professional");
  assert.ok(!proPromo.includes("text-overlay"), "no text labels under Clean Professional");
  assert.ok(proPromo.includes("hook-text"), "the opening hook is allowed");
  assert.ok(proPromo.includes("branding-cta"), "the closing CTA is allowed");

  // product-demo's recipe generates callouts; the policy stops those too.
  const controlDemo = gen("product-demo", false).moments.map((m) => m.effectType);
  assert.ok(controlDemo.includes("callout"), "control generates callouts");
  const proDemo = gen("product-demo", true).moments.map((m) => m.effectType);
  assert.ok(!proDemo.includes("callout"), "no callouts under Clean Professional");
});

/* ── "No edit" is reachable ──────────────────────────────────────────────── */

test("a video that justifies nothing ships nothing — no hidden floor", () => {
  const policy = resolved();
  const junk: DetectedMoment[] = [
    moment("j1", 10, "zoom", 0.4),
    moment("j2", 30, "click-highlight", 0.9, {
      targetRegionSource: "cv-inferred-click",
    }),
    moment("j3", 55, "speed-up", 0.8),
  ];
  const r = decideTimeline(junk, talkingHeadCtx(policy.decision));
  assert.deepEqual(r.kept, [], "zero edits is a valid, reachable outcome");
});

/* ── Gate D backstops the whole assembled timeline ───────────────────────── */

test("Gate D disables a zoom pileup that slipped past selection", () => {
  const policy = resolved();
  // Simulate preserved AI zooms appearing post-selection (e.g. carry-over).
  const assembled: DetectedMoment[] = [
    moment("p1", 10, "zoom", 0.9),
    moment("p2", 15, "zoom", 0.7), // 3.4s gap end→start — under 12s
    moment("p3", 21, "zoom", 0.66),
    moment("cutX", 60, "cut", 0.8, { endTime: 64 }),
  ];
  const report = reviewComposition(assembled, policy, { durationSeconds: 120 });
  const out = applyCompositionActions(assembled, report);
  const liveZooms = out.filter((m) => m.effectType === "zoom" && m.enabled !== false);
  assert.ok(liveZooms.length < 3, "the pileup is thinned");
  assert.equal(out.length, assembled.length, "disabled, never deleted");
  const cutX = out.find((m) => m.id === "cutX")!;
  assert.notEqual(cutX.enabled, false, "cuts untouched");
});
