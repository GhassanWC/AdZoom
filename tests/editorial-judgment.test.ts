/**
 * AI Director — editorial judgment (the decision engine).
 *
 * The property under test: validation only asks whether an edit COULD exist;
 * this stage asks whether it SHOULD. An edit with no real reason, no
 * grounding evidence, or confidence too low to trust must be dropped rather
 * than executed — "no edit" has to be a normal, reachable outcome, not
 * something the code merely claims to support.
 *
 * Pure module only. `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEditorialJudgment } from "../src/lib/director/editorial-judgment.ts";
import {
  DEFAULT_REVIEW_RULES,
  DIRECTOR_PLAN_VERSION,
  type DirectorEditOperation,
  type DirectorEditType,
  type DirectorPlan,
} from "../src/lib/director/types.ts";

function op(overrides: Partial<DirectorEditOperation> & { id: string }): DirectorEditOperation {
  return {
    editType: "zoom",
    startTime: 10,
    endTime: 12,
    reason: "Emphasizes a real interaction — a genuine reason.",
    confidence: 0.8,
    priority: 0.5,
    evidence: [{ kind: "click", detail: "grounded target" }],
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
      reason: "off for this test",
    },
    reviewRules: DEFAULT_REVIEW_RULES,
    explanation: "test plan",
    modelVersion: "test",
    createdAt: 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Per-edit judgment
// ════════════════════════════════════════════════════════════════════════════

test("a well-justified edit survives, unchanged apart from its stamp", () => {
  const plan = planWith([op({ id: "e1" })]);
  const { plan: judged, failures } = applyEditorialJudgment(plan);

  assert.equal(failures.length, 0);
  assert.equal(judged.editOperations.length, 1);
  assert.equal(judged.editOperations[0].id, "e1");
  assert.equal(judged.editOperations[0].justification, "emphasis");
});

test("low confidence: an edit the Director itself doesn't trust is dropped", () => {
  const plan = planWith([op({ id: "shaky", confidence: 0.1 })]);
  const { plan: judged, failures } = applyEditorialJudgment(plan);

  assert.equal(judged.editOperations.length, 0, "no edit is the safer choice");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].operationId, "shaky");
  assert.equal(failures[0].reason, "not_editorially_justified");
});

test("no reason: an edit with a placeholder or empty reason is dropped", () => {
  const plan = planWith([
    op({ id: "no-reason", reason: "" }),
    op({ id: "placeholder", reason: "edit" }),
  ]);
  const { plan: judged, failures } = applyEditorialJudgment(plan);

  assert.equal(judged.editOperations.length, 0);
  assert.equal(failures.length, 2);
  assert.ok(failures.every((f) => f.reason === "not_editorially_justified"));
});

test("no evidence: an edit grounded in nothing real is dropped", () => {
  const plan = planWith([op({ id: "ungrounded", evidence: [] })]);
  const { plan: judged, failures } = applyEditorialJudgment(plan);

  assert.equal(judged.editOperations.length, 0);
  assert.equal(failures[0].operationId, "ungrounded");
  assert.match(failures[0].detail, /nothing grounds/i);
});

test("a structural edit driven by the user's own request still needs its own evidence entry", () => {
  // Structural edit types aren't exempt from grounding — they just cite the
  // request itself (`user-request`) rather than a transcript line or click.
  const plan = planWith([
    op({
      id: "cta",
      editType: "branding-cta",
      reason: "Closes with a clear next step, as requested.",
      confidence: 0.9,
      evidence: [{ kind: "user-request", detail: "CTA requested" }],
    }),
  ]);
  const { plan: judged, failures } = applyEditorialJudgment(plan);

  assert.equal(failures.length, 0);
  assert.equal(judged.editOperations.length, 1);
  assert.equal(judged.editOperations[0].justification, "structure");
});

// ════════════════════════════════════════════════════════════════════════════
// Justification categories
// ════════════════════════════════════════════════════════════════════════════

test("every surviving edit is stamped with the category matching its purpose", () => {
  const cases: Array<[DirectorEditType, string]> = [
    ["zoom", "emphasis"],
    ["click-highlight", "action"],
    ["cursor-focus", "attention"],
    ["speed-up", "pacing"],
    ["captions", "clarity"],
    ["hook-text", "engagement"],
    ["text-overlay", "clarity"],
    ["callout", "action"],
    ["transition", "pacing"],
    ["branding-cta", "structure"],
    ["smart-crop", "structure"],
  ];

  // Space them far enough apart that crowding never interferes with this check.
  const ops = cases.map(([editType], i) =>
    op({ id: `op-${i}`, editType, startTime: i * 100, endTime: i * 100 + 2 })
  );
  const { plan: judged } = applyEditorialJudgment(planWith(ops));

  const byId = new Map(judged.editOperations.map((o) => [o.id, o.justification]));
  for (const [i, [, expected]] of cases.entries()) {
    assert.equal(byId.get(`op-${i}`), expected, `${cases[i][0]} → ${expected}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Whole-video judgment: crowding
// ════════════════════════════════════════════════════════════════════════════

test("crowding: two callouts a second apart — only the stronger survives", () => {
  const plan = planWith([
    op({
      id: "weak",
      editType: "callout",
      startTime: 10,
      endTime: 11,
      confidence: 0.6,
    }),
    op({
      id: "strong",
      editType: "callout",
      startTime: 10.5,
      endTime: 11.5,
      confidence: 0.9,
    }),
  ]);
  const { plan: judged, failures } = applyEditorialJudgment(plan);

  assert.deepEqual(
    judged.editOperations.map((o) => o.id),
    ["strong"]
  );
  const f = failures.find((x) => x.operationId === "weak");
  assert.ok(f);
  assert.equal(f!.reason, "editorially_redundant");
});

test("crowding: well-spaced edits of the same type both survive", () => {
  const plan = planWith([
    op({ id: "first", editType: "text-overlay", startTime: 10, endTime: 11 }),
    op({ id: "second", editType: "text-overlay", startTime: 30, endTime: 31 }),
  ]);
  const { plan: judged, failures } = applyEditorialJudgment(plan);

  assert.deepEqual(
    judged.editOperations.map((o) => o.id).sort(),
    ["first", "second"]
  );
  assert.equal(failures.length, 0);
});

test("crowding only thins WITHIN a type — different edit types never compete", () => {
  const plan = planWith([
    op({ id: "z", editType: "zoom", startTime: 10, endTime: 11 }),
    op({ id: "c", editType: "callout", startTime: 10.2, endTime: 11.2 }),
  ]);
  const { plan: judged, failures } = applyEditorialJudgment(plan);

  assert.equal(judged.editOperations.length, 2);
  assert.equal(failures.length, 0);
});

test("crowding: a run of three collapses to the single strongest, not just neighbor pairs", () => {
  const plan = planWith([
    op({ id: "a", editType: "callout", startTime: 10, endTime: 10.5, confidence: 0.5 }),
    op({ id: "b", editType: "callout", startTime: 10.5, endTime: 11, confidence: 0.95 }),
    op({ id: "c", editType: "callout", startTime: 11, endTime: 11.5, confidence: 0.6 }),
  ]);
  const { plan: judged } = applyEditorialJudgment(plan);

  assert.deepEqual(judged.editOperations.map((o) => o.id), ["b"]);
});

// ════════════════════════════════════════════════════════════════════════════
// "No edit" is a valid, common outcome
// ════════════════════════════════════════════════════════════════════════════

test("a plan where nothing can be justified judges down to zero edits, cleanly", () => {
  const plan = planWith([
    op({ id: "a", confidence: 0.05 }),
    op({ id: "b", evidence: [] }),
    op({ id: "c", reason: "no" }),
  ]);
  const { plan: judged, failures } = applyEditorialJudgment(plan);

  assert.equal(judged.editOperations.length, 0);
  assert.equal(failures.length, 3);
  // Every other part of the plan is untouched.
  assert.deepEqual(judged.storyStructure, plan.storyStructure);
  assert.deepEqual(judged.clipOperations, plan.clipOperations);
  assert.deepEqual(judged.audioOperations, plan.audioOperations);
});

test("an empty plan judges to an empty plan with no failures", () => {
  const { plan: judged, failures } = applyEditorialJudgment(planWith([]));
  assert.equal(judged.editOperations.length, 0);
  assert.equal(failures.length, 0);
});
