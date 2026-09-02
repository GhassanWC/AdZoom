/**
 * Gate D — timeline composition review.
 *
 * Pins: ONE implementation serves the analyze route and the Director review
 * (the extracted zoomDensityPass is semantically identical to review.ts's
 * historical inline rule); Classic mode is a strict no-op (clarification #3);
 * enforce mode disables-not-deletes and never touches user or structural edits.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { DetectedMoment, EffectType } from "@/lib/firebase/schema";
import {
  applyCompositionActions,
  reviewComposition,
  zoomDensityPass,
} from "@/lib/editorial/composition";
import {
  contextFromSelectedVideoType,
} from "@/lib/editorial/context";
import { resolveEditorialPolicy } from "@/lib/editorial/resolve";
import { TALKING_CLEAN_PRO, defaultTemplateFor } from "@/lib/editorial/templates";
import type { RecipeSignals } from "@/lib/analysis/edit-recipe";

const SIGNALS: RecipeSignals = {
  hasTranscript: false,
  hasAudioAnalysis: false,
  hasUsableSpeech: false,
  silenceSegmentCount: 0,
  hasSceneData: true,
  hasVisualMoments: true,
  hasInteractionData: false,
  isScreenRecording: false,
};

function m(
  over: Partial<DetectedMoment> & { id: string; startTime: number; endTime: number }
): DetectedMoment {
  return {
    label: "x",
    reason: "grounded in a real signal for the test",
    focusRegion: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
    effectType: "zoom" as EffectType,
    confidenceScore: 0.8,
    source: "ai",
    provenance: "cv",
    ...over,
  } as DetectedMoment;
}

const cleanPro = () =>
  resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: SIGNALS,
  });

const classic = () =>
  resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: defaultTemplateFor("talking-head"),
    signals: SIGNALS,
  });

/* ── zoomDensityPass ≡ the Director review's historical rule ─────────────── */

/** Verbatim re-implementation of review.ts's pre-extraction algorithm. */
function referenceZoomDensity(
  zooms: DetectedMoment[],
  minGap: number,
  maxPerMin: number,
  reportedOutputDuration: number
): string[] {
  const sorted = [...zooms].sort((a, b) => a.startTime - b.startTime);
  const tooClose: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startTime - sorted[i - 1].endTime < minGap) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const weaker = (a.confidenceScore ?? 0) <= (b.confidenceScore ?? 0) ? a : b;
      if (!tooClose.includes(weaker.id)) tooClose.push(weaker.id);
    }
  }
  const outMinutes = Math.max(reportedOutputDuration, 1) / 60;
  const budget = Math.max(1, Math.floor(outMinutes * maxPerMin));
  const overBudget = sorted.length - budget;
  if (overBudget > 0) {
    const weakest = sorted
      .slice()
      .sort((a, b) => (a.confidenceScore ?? 0) - (b.confidenceScore ?? 0))
      .slice(0, overBudget)
      .map((x) => x.id);
    for (const id of weakest) if (!tooClose.includes(id)) tooClose.push(id);
  }
  return tooClose;
}

test("zoomDensityPass matches the historical review algorithm on every shape", () => {
  const shapes: DetectedMoment[][] = [
    [],
    [m({ id: "a", startTime: 1, endTime: 3 })],
    // A too-close pair (gap 0.5s) with a clear weaker member.
    [
      m({ id: "a", startTime: 1, endTime: 3, confidenceScore: 0.9 }),
      m({ id: "b", startTime: 3.5, endTime: 5, confidenceScore: 0.4 }),
    ],
    // A chain of three, mixed confidences.
    [
      m({ id: "a", startTime: 1, endTime: 3, confidenceScore: 0.5 }),
      m({ id: "b", startTime: 3.2, endTime: 5, confidenceScore: 0.8 }),
      m({ id: "c", startTime: 5.4, endTime: 7, confidenceScore: 0.3 }),
    ],
    // Over budget on a short output (12 zooms in 30s at 10/min → budget 5).
    Array.from({ length: 12 }, (_, i) =>
      m({ id: `z${i}`, startTime: i * 2.5, endTime: i * 2.5 + 1, confidenceScore: 0.3 + i * 0.05 })
    ),
  ];
  for (const zooms of shapes) {
    for (const outDur of [30, 60, 240]) {
      assert.deepEqual(
        zoomDensityPass(zooms, {
          minGapSeconds: 1.5,
          maxPerOutputMinute: 10,
          outputDurationSeconds: outDur,
        }),
        referenceZoomDensity(zooms, 1.5, 10, outDur),
        `mismatch for ${zooms.length} zooms @ ${outDur}s`
      );
    }
  }
});

/* ── Classic mode is a strict no-op (clarification #3) ───────────────────── */

test("Gate D under a Classic template changes NOTHING — same array reference", () => {
  const moments = [
    m({ id: "a", startTime: 1, endTime: 2 }),
    m({ id: "b", startTime: 1.2, endTime: 2.2, effectType: "callout" as EffectType }),
    m({ id: "c", startTime: 1.4, endTime: 2.4, effectType: "text-overlay" as EffectType }),
  ];
  const report = reviewComposition(moments, classic(), { durationSeconds: 60 });
  assert.equal(report.mode, "off");
  assert.deepEqual(report.actions, []);
  assert.equal(applyCompositionActions(moments, report), moments);
});

/* ── Enforce mode ────────────────────────────────────────────────────────── */

test("stacked emphasis keeps one edit; the weaker is DISABLED, never deleted", () => {
  const moments = [
    m({ id: "strong", startTime: 10, endTime: 13, confidenceScore: 0.9 }),
    m({
      id: "weak",
      startTime: 11,
      endTime: 13.5,
      confidenceScore: 0.5,
      effectType: "text-overlay" as EffectType,
    }),
  ];
  const report = reviewComposition(moments, cleanPro(), { durationSeconds: 120 });
  const out = applyCompositionActions(moments, report);
  assert.equal(out.length, 2, "disable, never delete");
  const weak = out.find((x) => x.id === "weak")!;
  assert.equal(weak.enabled, false);
  assert.equal(out.find((x) => x.id === "strong")!.enabled, undefined);
  assert.ok(report.counts["overlap-emphasis"]! >= 1);
});

test("clusters are thinned to the strongest N inside the window", () => {
  const moments = Array.from({ length: 4 }, (_, i) =>
    m({
      id: `e${i}`,
      startTime: 20 + i * 30,
      endTime: 21 + i * 30,
      confidenceScore: 0.9,
    })
  ).concat(
    // A pileup: 4 edits within 6 seconds (cluster window is 8s, max 2).
    Array.from({ length: 4 }, (_, i) =>
      m({
        id: `c${i}`,
        startTime: 200 + i * 1.6,
        endTime: 200.8 + i * 1.6,
        confidenceScore: 0.3 + i * 0.1,
        effectType: "text-overlay" as EffectType,
      })
    )
  );
  const report = reviewComposition(moments, cleanPro(), { durationSeconds: 400 });
  const disabledIds = new Set(report.actions.map((a) => a.id));
  const clusterDisabled = [...disabledIds].filter((id) => id.startsWith("c"));
  assert.ok(clusterDisabled.length >= 2, `cluster thinned (${clusterDisabled.length})`);
});

test("per-type totals hold: Clean Professional carries at most one hook", () => {
  const moments = [
    m({
      id: "hook1",
      startTime: 0.2,
      endTime: 2,
      confidenceScore: 0.9,
      effectType: "hook-text" as EffectType,
    }),
    m({
      id: "hook2",
      startTime: 40,
      endTime: 42,
      confidenceScore: 0.4,
      effectType: "hook-text" as EffectType,
    }),
  ];
  const report = reviewComposition(moments, cleanPro(), { durationSeconds: 120 });
  const disabled = report.actions.map((a) => a.id);
  assert.deepEqual(disabled, ["hook2"], "the weaker extra hook is disabled");
});

test("user edits and structural edits are untouchable", () => {
  const moments = [
    m({ id: "u1", startTime: 10, endTime: 12, source: "user", provenance: "user" }),
    m({ id: "u2", startTime: 10.5, endTime: 12.5, source: "user", provenance: "user" }),
    m({ id: "cut1", startTime: 30, endTime: 34, effectType: "cut" as EffectType }),
    m({ id: "cut2", startTime: 31, endTime: 35, effectType: "cut" as EffectType }),
  ];
  const report = reviewComposition(moments, cleanPro(), { durationSeconds: 120 });
  assert.deepEqual(report.actions, [], "user + structural edits are out of scope");
});

test("output-minute budgets derive from the timeline map when cuts shrink the video", () => {
  // 240s source, but 180s is cut away → 60s output. Clean Pro allows
  // max(1, floor(1min × 1.5)) = 1 zoom; the second (weaker) is disabled.
  const moments = [
    m({ id: "bigcut", startTime: 60, endTime: 240, effectType: "cut" as EffectType }),
    m({ id: "z1", startTime: 10, endTime: 13, confidenceScore: 0.9 }),
    m({ id: "z2", startTime: 40, endTime: 43, confidenceScore: 0.5 }),
  ];
  const report = reviewComposition(moments, cleanPro(), { durationSeconds: 240 });
  const disabled = report.actions.filter((a) => a.rule === "zoom-density").map((a) => a.id);
  assert.deepEqual(disabled, ["z2"]);
});
