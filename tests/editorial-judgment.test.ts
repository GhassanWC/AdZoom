/**
 * The AI Editor (decision engine) — unit tests for `editorial-judgment.ts`.
 *
 * These lock down the behaviour the issue asked for directly:
 *   • an edit with no honest reason is never created
 *   • an edit with no supporting evidence is never created (unless it's a
 *     structural edit driven straight by the user's request)
 *   • an edit whose confidence is too low to trust is left out
 *   • every edit that survives carries an internal justification category
 *   • edits of the same type that crowd each other lose the weaker one
 *   • a plan of only strong edits passes through untouched — quality doesn't
 *     mean the engine nukes everything, it means it's honest about the bar
 *
 * Pure module — no Gemini, no Firebase. `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEditorialJudgment } from "../src/lib/director/editorial-judgment.ts";
import {
  DEFAULT_REVIEW_RULES,
  DIRECTOR_PLAN_VERSION,
  type DirectorEditOperation,
  type DirectorPlan,
} from "../src/lib/director/types.ts";

function edit(overrides: Partial<DirectorEditOperation> = {}): DirectorEditOperation {
  return {
    id: "op-1",
    editType: "zoom",
    startTime: 10,
    endTime: 12,
    reason: "Emphasizes the click that starts the upgrade flow.",
    confidence: 0.8,
    priority: 0.6,
    evidence: [{ kind: "click", ref: "m1", detail: "a real click", at: 10 }],
    ...overrides,
  } as DirectorEditOperation;
}

function planWith(editOperations: DirectorEditOperation[]): DirectorPlan {
  return {
    planVersion: DIRECTOR_PLAN_VERSION,
    goal: "test",
    platform: "internal",
    storyStructure: [],
    clipOperations: [],
    editOperations,
    audioOperations: [],
    captionInstructions: {
      enabled: false,
      stylePreset: "clean",
      position: "bottom",
      reason: "not tested here",
    },
    reviewRules: DEFAULT_REVIEW_RULES,
    explanation: "test plan",
    modelVersion: "test",
    createdAt: 0,
  };
}

test("a well-justified edit survives untouched and is stamped with a justification", () => {
  const { plan, failures } = applyEditorialJudgment(planWith([edit()]));
  assert.equal(failures.length, 0, "no failures for a strong edit");
  assert.equal(plan.editOperations.length, 1);
  assert.equal(plan.editOperations[0].justification, "action", "click-grounded zoom → action");
});

test("an edit with no reason is dropped — 'no edit' is the correct call", () => {
  const { plan, failures } = applyEditorialJudgment(planWith([edit({ reason: "   " })]));
  assert.equal(plan.editOperations.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "weak_justification");
  assert.match(failures[0].detail, /reason/i);
});

test("a decorative edit with no supporting evidence is dropped", () => {
  const { plan, failures } = applyEditorialJudgment(
    planWith([edit({ editType: "callout", evidence: [], confidence: 0.9 })])
  );
  assert.equal(plan.editOperations.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "weak_justification");
  assert.match(failures[0].detail, /evidence/i);
});

test("a structural edit (hook-text) survives with no evidence — it's driven by the request itself", () => {
  const { plan, failures } = applyEditorialJudgment(
    planWith([
      edit({
        editType: "hook-text",
        evidence: [],
        confidence: 0.1,
        params: { text: "Watch this" },
      }),
    ])
  );
  assert.equal(failures.length, 0);
  assert.equal(plan.editOperations.length, 1);
  assert.equal(plan.editOperations[0].justification, "engagement");
});

test("an edit below the confidence floor for its type is left out", () => {
  const { plan, failures } = applyEditorialJudgment(
    planWith([edit({ editType: "zoom", confidence: 0.1 })])
  );
  assert.equal(plan.editOperations.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "weak_justification");
  assert.match(failures[0].detail, /confidence/i);
});

test("justification categories match the categories from the spec", () => {
  const cases: Array<[Partial<DirectorEditOperation>, string]> = [
    [{ editType: "callout", params: { text: "Here" } }, "attention"],
    [{ editType: "click-highlight" }, "attention"],
    [{ editType: "cursor-focus" }, "attention"],
    [{ editType: "text-overlay", params: { text: "Step 1" } }, "clarity"],
    [{ editType: "speed-up", params: { speedMultiplier: 2 } }, "pacing"],
    [{ editType: "transition" }, "pacing"],
    [{ editType: "branding-cta", params: { ctaText: "Try it" } }, "engagement"],
    [{ editType: "smart-crop" }, "structure"],
    [{ editType: "zoom", evidence: [{ kind: "attention", detail: "CV peak" }] }, "emphasis"],
  ];

  for (const [overrides, expected] of cases) {
    const { plan, failures } = applyEditorialJudgment(planWith([edit(overrides)]));
    assert.equal(failures.length, 0, `${overrides.editType}: ${JSON.stringify(failures)}`);
    assert.equal(plan.editOperations[0]?.justification, expected, `${overrides.editType}`);
  }
});

test("two callouts crowding the same beat: only the stronger survives", () => {
  const weak = edit({
    id: "callout-weak",
    editType: "callout",
    startTime: 10,
    endTime: 11,
    confidence: 0.5,
    priority: 0.4,
    params: { text: "Here" },
  });
  const strong = edit({
    id: "callout-strong",
    editType: "callout",
    startTime: 10.3,
    endTime: 11.3,
    confidence: 0.9,
    priority: 0.6,
    params: { text: "Here" },
  });

  const { plan, failures } = applyEditorialJudgment(planWith([weak, strong]));
  assert.equal(plan.editOperations.length, 1, "only one callout survives the crowd");
  assert.equal(plan.editOperations[0].id, "callout-strong", "the stronger one wins");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].operationId, "callout-weak");
  assert.match(failures[0].detail, /close/i);
});

test("callouts spread well apart both survive — spacing isn't a blanket cap", () => {
  const first = edit({ id: "c1", editType: "callout", startTime: 10, endTime: 11, params: { text: "Here" } });
  const second = edit({ id: "c2", editType: "callout", startTime: 40, endTime: 41, params: { text: "There" } });

  const { plan, failures } = applyEditorialJudgment(planWith([first, second]));
  assert.equal(failures.length, 0);
  assert.equal(plan.editOperations.length, 2);
});

test("zoom spacing is left to the post-execution review pass, not this engine", () => {
  const a = edit({ id: "z1", editType: "zoom", startTime: 10, endTime: 10.5 });
  const b = edit({ id: "z2", editType: "zoom", startTime: 10.6, endTime: 11.1 });
  const { plan, failures } = applyEditorialJudgment(planWith([a, b]));
  assert.equal(failures.length, 0, "zoom density is review.ts's job, not the decision engine's");
  assert.equal(plan.editOperations.length, 2);
});

test("an empty edit list is a fully valid outcome — no edit beats a bad edit", () => {
  const { plan, failures } = applyEditorialJudgment(planWith([]));
  assert.equal(plan.editOperations.length, 0);
  assert.equal(failures.length, 0);
});
