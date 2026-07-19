/**
 * AI Director — editorial judgment (the AI Editor / decision engine).
 *
 * `validate.ts` asks whether an edit COULD exist. `editorial-judgment.ts` asks
 * whether it SHOULD. These tests exercise that gate directly, without needing a
 * full project fixture: build minimal edit operations and check what survives.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEditorialJudgment } from "../src/lib/director/editorial-judgment.ts";
import {
  DEFAULT_REVIEW_RULES,
  DIRECTOR_PLAN_VERSION,
} from "../src/lib/director/types.ts";
import type {
  DirectorEditOperation,
  DirectorEvidence,
  DirectorPlan,
} from "../src/lib/director/types.ts";

const EVIDENCE: DirectorEvidence[] = [
  { kind: "click", detail: "a real click event", ref: "mom-1", at: 10 },
];

function op(overrides: Partial<DirectorEditOperation> = {}): DirectorEditOperation {
  return {
    id: overrides.id ?? "op-1",
    editType: "zoom",
    startTime: 10,
    endTime: 12,
    reason: "Emphasizes the click where the user opens the settings panel.",
    confidence: 0.8,
    priority: 0.6,
    evidence: EVIDENCE,
    ...overrides,
  };
}

function planWith(editOperations: DirectorEditOperation[]): DirectorPlan {
  return {
    planVersion: DIRECTOR_PLAN_VERSION,
    goal: "test",
    platform: "tiktok",
    aspectRatio: "9:16",
    tone: "energetic",
    storyStructure: [],
    clipOperations: [],
    editOperations,
    audioOperations: [],
    captionInstructions: {
      enabled: false,
      stylePreset: "clean",
      position: "bottom",
      reason: "not requested",
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

test("editorial judgment: a well-justified, well-grounded edit survives", () => {
  const { plan, failures } = applyEditorialJudgment(planWith([op()]));
  assert.equal(plan.editOperations.length, 1);
  assert.equal(failures.length, 0);
});

test("editorial judgment: an edit with no reason is dropped", () => {
  const { plan, failures } = applyEditorialJudgment(planWith([op({ reason: "" })]));
  assert.equal(plan.editOperations.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "not_justified");
});

test("editorial judgment: a placeholder reason (just the edit type restated) is dropped", () => {
  const { plan, failures } = applyEditorialJudgment(planWith([op({ reason: "Zoom." })]));
  assert.equal(plan.editOperations.length, 0);
  assert.equal(failures[0].reason, "not_justified");
});

test("editorial judgment: low confidence is dropped even with a good reason", () => {
  const { plan } = applyEditorialJudgment(
    planWith([op({ confidence: 0.1, reason: "A very well-written justification for this edit." })])
  );
  assert.equal(plan.editOperations.length, 0);
});

test("editorial judgment: no evidence is dropped for a non-structural edit type", () => {
  const { plan, failures } = applyEditorialJudgment(
    planWith([
      op({
        editType: "callout",
        evidence: [],
        reason: "Points at something the viewer should notice here.",
      }),
    ])
  );
  assert.equal(plan.editOperations.length, 0);
  assert.match(failures[0].detail, /evidence/i);
});

test("editorial judgment: structural edits (hook-text, branding-cta, smart-crop) survive without evidence", () => {
  const ops: DirectorEditOperation[] = [
    op({
      id: "hook-1",
      editType: "hook-text",
      evidence: [],
      reason: "Opens the video with the strongest claim from the transcript.",
      params: { text: "Watch this" },
    }),
    op({
      id: "cta-1",
      editType: "branding-cta",
      startTime: 100,
      endTime: 104,
      evidence: [],
      reason: "Closes with the CTA the user explicitly asked for.",
      params: { ctaText: "Try it now" },
    }),
    op({
      id: "crop-1",
      editType: "smart-crop",
      startTime: 0,
      endTime: 200,
      evidence: [],
      reason: "Reframes to the vertical aspect the user requested for TikTok.",
      params: { aspectRatio: "9:16" },
    }),
  ];
  const { plan, failures } = applyEditorialJudgment(planWith(ops));
  assert.equal(plan.editOperations.length, 3);
  assert.equal(failures.length, 0);
});

test("editorial judgment: an all-rejected plan cleanly reduces to zero edits — 'no edit' is valid", () => {
  const { plan, failures } = applyEditorialJudgment(
    planWith([
      op({ id: "a", reason: "" }),
      op({ id: "b", confidence: 0.05 }),
      op({ id: "c", editType: "callout", evidence: [] }),
    ])
  );
  assert.equal(plan.editOperations.length, 0);
  assert.equal(failures.length, 3);
});

// ════════════════════════════════════════════════════════════════════════════
// Justification stamping
// ════════════════════════════════════════════════════════════════════════════

test("editorial judgment: every edit type maps to a real internal justification", () => {
  const types: Array<[DirectorEditOperation["editType"], string]> = [
    ["zoom", "emphasis"],
    ["click-highlight", "action"],
    ["cursor-focus", "attention"],
    ["speed-up", "pacing"],
    ["cut", "pacing"],
    ["hook-text", "structure"],
    ["text-overlay", "clarity"],
    ["callout", "attention"],
    ["transition", "engagement"],
    ["branding-cta", "structure"],
    ["smart-crop", "structure"],
  ];

  for (const [editType, expected] of types) {
    const needsParams =
      editType === "hook-text" || editType === "text-overlay" || editType === "callout"
        ? { text: "Some real copy" }
        : editType === "branding-cta"
          ? { ctaText: "Go" }
          : editType === "speed-up"
            ? { speedMultiplier: 2 }
            : undefined;

    const { plan } = applyEditorialJudgment(
      planWith([
        op({
          id: `t-${editType}`,
          editType,
          reason: `A specific, real reason this ${editType} earns its place in the video.`,
          ...(needsParams ? { params: needsParams } : {}),
        }),
      ])
    );
    assert.equal(plan.editOperations.length, 1, `${editType} should survive`);
    assert.equal(
      plan.editOperations[0].justification,
      expected,
      `${editType} → ${expected}`
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Whole-video judgment: thinning crowded edits
// ════════════════════════════════════════════════════════════════════════════

test("editorial judgment: two callouts within 2s of each other are thinned to the stronger one", () => {
  const ops = [
    op({
      id: "callout-weak",
      editType: "callout",
      startTime: 10,
      endTime: 11,
      confidence: 0.5,
      reason: "Points at the settings icon the user clicked here.",
      params: { text: "Here" },
    }),
    op({
      id: "callout-strong",
      editType: "callout",
      startTime: 11.5,
      endTime: 12.5,
      confidence: 0.9,
      reason: "Points at the confirm button the user actually pressed.",
      params: { text: "Confirm" },
    }),
  ];
  const { plan, failures } = applyEditorialJudgment(planWith(ops));
  assert.equal(plan.editOperations.length, 1);
  assert.equal(plan.editOperations[0].id, "callout-strong");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].operationId, "callout-weak");
});

test("editorial judgment: a run of three crowded text overlays keeps only the strongest", () => {
  const ops = [
    op({
      id: "t1",
      editType: "text-overlay",
      startTime: 20,
      endTime: 21,
      confidence: 0.4,
      reason: "Labels the pricing tier shown on screen at this moment.",
      params: { text: "Starter" },
    }),
    op({
      id: "t2",
      editType: "text-overlay",
      startTime: 21.5,
      endTime: 22.5,
      confidence: 0.95,
      reason: "Labels the pricing tier the user actually selected here.",
      params: { text: "Pro" },
    }),
    op({
      id: "t3",
      editType: "text-overlay",
      startTime: 23,
      endTime: 24,
      confidence: 0.3,
      reason: "Labels the enterprise tier visible in the background.",
      params: { text: "Enterprise" },
    }),
  ];
  const { plan } = applyEditorialJudgment(planWith(ops));
  assert.equal(plan.editOperations.length, 1);
  assert.equal(plan.editOperations[0].id, "t2");
});

test("editorial judgment: same-type edits well spaced apart both survive", () => {
  const ops = [
    op({
      id: "c1",
      editType: "callout",
      startTime: 10,
      endTime: 11,
      reason: "Points at the field the user filled in during this shot.",
      params: { text: "Card number" },
    }),
    op({
      id: "c2",
      editType: "callout",
      startTime: 40,
      endTime: 41,
      reason: "Points at the confirm button the user pressed much later.",
      params: { text: "Confirm" },
    }),
  ];
  const { plan, failures } = applyEditorialJudgment(planWith(ops));
  assert.equal(plan.editOperations.length, 2, "30s apart is nowhere near the crowd window");
  assert.equal(failures.length, 0);
});

test("editorial judgment: zoom density is left to the post-execution review, not judged here", () => {
  const ops = [
    op({ id: "z1", editType: "zoom", startTime: 10, endTime: 10.5 }),
    op({ id: "z2", editType: "zoom", startTime: 10.6, endTime: 11.1 }),
  ];
  const { plan, failures } = applyEditorialJudgment(planWith(ops));
  assert.equal(
    plan.editOperations.length,
    2,
    "zoom crowding is judged later against the real rendered timeline by review.ts"
  );
  assert.equal(failures.length, 0);
});

test("editorial judgment: crowded edits of DIFFERENT types never compete with each other", () => {
  const ops = [
    op({
      id: "callout-1",
      editType: "callout",
      startTime: 10,
      endTime: 11,
      reason: "Points at the button the user clicked in this shot.",
      params: { text: "Click here" },
    }),
    op({
      id: "text-1",
      editType: "text-overlay",
      startTime: 10.2,
      endTime: 11.2,
      reason: "Labels the plan tier visible in this same shot.",
      params: { text: "Pro plan" },
    }),
  ];
  const { plan, failures } = applyEditorialJudgment(planWith(ops));
  assert.equal(plan.editOperations.length, 2, "different edit types don't crowd each other");
  assert.equal(failures.length, 0);
});
