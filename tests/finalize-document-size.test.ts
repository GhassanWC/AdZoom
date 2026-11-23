/**
 * Analysis finalize failed with `3 INVALID_ARGUMENT: Document … cannot be
 * written because its size (1,204,269 bytes) exceeds the maximum allowed size
 * of 1,048,576 bytes`. Cause: every Director revision persisted the reviewed
 * timeline (`review.moments`, ~120 KB each) — six re-analyses filled the doc.
 *
 * Pins: (1) Director state never persists a timeline copy, and an already-
 * bloated state compacts on its next write; (2) the size estimator and the
 * terminal-write fitter; (3) the error the user sees never names the database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runDirectorPipeline } from "../src/lib/director/pipeline.ts";
import { buildHeuristicPlan } from "../src/lib/director/planner.ts";
import { buildDirectorContext } from "../src/lib/director/context-builder.ts";
import { parseDirectorRequest } from "../src/lib/director/request.ts";
import {
  commitRun,
  compactDirectorState,
  proposeRun,
  startRun,
  undoLastRevision,
} from "../src/lib/director/state.ts";
import type { DirectorState } from "../src/lib/director/types.ts";
import {
  DELETE,
  FIRESTORE_MAX_DOCUMENT_BYTES,
  firestoreDocumentSize,
  firestoreValueSize,
  fitMergeWrite,
  mergeForSize,
} from "../src/lib/firebase/doc-size.ts";
import {
  classifyError,
  isDatabaseWriteError,
  userFacingAnalysisError,
} from "../src/lib/analysis-stages.ts";
import { demoProject } from "./director-fixtures.ts";

const NOW = 1_700_000_000_000;
const REQUEST = parseDirectorRequest("Make a fast 45-second TikTok demo with captions and a CTA.", {});
const PATH = "users/u1/projects/p1";

function directedRun(revision: number) {
  const project = demoProject();
  return runDirectorPipeline({
    plan: buildHeuristicPlan(buildDirectorContext(project), REQUEST, NOW),
    moments: project.analysis!.detectedMoments,
    duration: project.duration!,
    revision,
    transcript: project.analysis?.transcript,
    effects: project.effectsSettings,
  });
}

const commit = (s: DirectorState, rev: number) => {
  const r = directedRun(rev);
  return commitRun(s, { plan: r.plan, summary: r.summary, review: r.review, failures: r.failures, appliedOperationIds: r.appliedOperationIds, now: NOW + rev });
};

test("the pipeline's review DOES carry the timeline — which is why it must not be stored as-is", () => {
  const r = directedRun(0);
  assert.ok(Array.isArray((r.review as unknown as { moments?: unknown[] }).moments), "precondition: review.moments exists at runtime");
});

test("committed Director state holds no timeline copy, in the current review or any revision", () => {
  let s = startRun(undefined, REQUEST.prompt, REQUEST, "h", NOW);
  for (let i = 0; i < 6; i++) s = commit(s, i);
  const json = JSON.stringify(s);
  assert.equal(json.includes('"moments"'), false, "no `moments` key anywhere in the persisted state");
  assert.equal(s.revisions.length, 6);
  // Review content the panel shows is intact.
  for (const k of ["findings", "autoFixed", "warnings", "errors", "parityOk"] as const) assert.ok(k in s.review!, k);
});

test("proposals are compact too, and undo still restores the previous plan", () => {
  let s = startRun(undefined, REQUEST.prompt, REQUEST, "h", NOW);
  s = commit(s, 0);
  s = commit(s, 1);
  const r = directedRun(2);
  const proposed = proposeRun(s, { plan: r.plan, summary: r.summary, review: r.review, failures: r.failures, command: "x" });
  assert.equal(JSON.stringify(proposed).includes('"moments"'), false);
  const undo = undoLastRevision(s)!;
  assert.equal(undo.revision, 0);
  assert.deepEqual(undo.plan, s.revisions[0].plan);
});

test("a state written BEFORE the fix (bloated revisions) shrinks on its next write", () => {
  const r = directedRun(0);
  const fat = { findings: [], autoFixed: 0, warnings: 0, errors: 0, parityOk: true, moments: r.moments };
  const legacy = {
    prompt: REQUEST.prompt, request: REQUEST, status: "complete", review: fat, plan: r.plan,
    revisions: Array.from({ length: 6 }, (_, i) => ({ id: `rev-${i}`, index: i, command: "", createdAt: NOW, plan: r.plan, summary: r.summary, review: fat, appliedOperationIds: [], failures: [] })),
  } as unknown as DirectorState;
  const before = JSON.stringify(legacy).length;
  const compacted = compactDirectorState(legacy);
  assert.equal(JSON.stringify(compacted).includes('"moments"'), false);
  assert.ok(JSON.stringify(compacted).length < before / 2, "much smaller");
  // The next analysis run starts from the compacted history.
  const restarted = startRun(legacy, REQUEST.prompt, REQUEST, "h2", NOW);
  assert.equal(JSON.stringify(restarted).includes('"moments"'), false);
  assert.equal(restarted.revisions.length, 6, "history (plans) is kept — only the copies go");
});

test("firestore size accounting follows the documented rules", () => {
  assert.equal(firestoreValueSize("abc"), 4);
  assert.equal(firestoreValueSize("é"), 3, "UTF-8 bytes + 1");
  assert.equal(firestoreValueSize(1.2345), 8);
  assert.equal(firestoreValueSize(true), 1);
  assert.equal(firestoreValueSize(null), 1);
  assert.equal(firestoreValueSize([1, 2]), 16);
  assert.equal(firestoreValueSize({ a: 1 }), 2 + 8);
  assert.equal(firestoreValueSize(new Date()), 8, "timestamps / sentinels");
  // name: users(6)+u1(3)+projects(9)+p1(3)+16 = 37; fields {a:"x"} = 2+2; +32
  assert.equal(firestoreDocumentSize(PATH, { a: "x" }), 37 + 4 + 32);
});

test("merge semantics: maps deep-merge, arrays replace, DELETE removes", () => {
  const out = mergeForSize({ a: { x: 1, y: [1, 2, 3] }, b: 1 }, { a: { y: [9] }, b: DELETE });
  assert.deepEqual(out, { a: { x: 1, y: [9] } });
});

test("fitMergeWrite sheds optional fields (as deletes) until the merged doc fits", () => {
  const big = "x".repeat(400_000);
  const deleted = Symbol("FieldValue.delete()");
  const existing = { analysis: { rawMoments: big, other: "keep" } };
  const patch: Record<string, unknown> = { analysis: { detectedMoments: big, rejectedPool: big, rawMoments: big } };
  const fit = fitMergeWrite({
    path: PATH, existing, patch, deleted,
    optional: [["analysis", "rawMoments"], ["analysis", "rejectedPool"], ["analysis", "editDiagnostics"]],
  });
  assert.equal(fit.fits, true);
  assert.deepEqual(fit.dropped, ["analysis.rawMoments"], "stops as soon as it fits");
  assert.equal((patch.analysis as Record<string, unknown>).rawMoments, deleted, "shed = DELETE, not omit (old copy would linger)");
  assert.ok(fit.size <= FIRESTORE_MAX_DOCUMENT_BYTES);
});

test("fitMergeWrite reports a write it cannot make fit (no silent data loss)", () => {
  const fit = fitMergeWrite({
    path: PATH, existing: {}, patch: { analysis: { detectedMoments: "x".repeat(1_200_000) } },
    optional: [["analysis", "rawMoments"]], deleted: null,
  });
  assert.equal(fit.fits, false);
});

const RAW =
  "3 INVALID_ARGUMENT: Document 'projects/adzoomdev/databases/(default)/documents/users/8EqHizlhBgVy3I0yHhllFNRSWbS2/projects/fhdrblQnmV5QYLZNmFXh' cannot be written because its size (1,204,269 bytes) exceeds the maximum allowed size of 1,048,576 bytes.";

test("the real error is classified as a save failure, not a Gemini / video-size problem", () => {
  assert.equal(isDatabaseWriteError(RAW), true);
  assert.equal(classifyError(RAW), "save_failed");
  assert.equal(classifyError("Gemini returned INVALID_ARGUMENT"), "gemini_invalid_argument", "Gemini errors unchanged");
});

test("the message that leaves the server never contains the database path", () => {
  const shown = userFacingAnalysisError(RAW);
  assert.equal(shown.includes("databases"), false);
  assert.equal(shown.includes("8EqHizl"), false);
  assert.match(shown, /timeline was not changed/i);
  assert.equal(userFacingAnalysisError("Gemini timed out"), "Gemini timed out", "other errors pass through");
});

test("the Director keeps captions the project already has instead of drawing a second set", async () => {
  const { executePlan: executeDirectorPlan } = await import("../src/lib/director/executor.ts");
  const project = demoProject();
  const plan = buildHeuristicPlan(buildDirectorContext(project), REQUEST, NOW);
  assert.equal(plan.captionInstructions.enabled, true, "precondition: the plan asks for captions");
  const own = { id: "aic_1", startTime: 1, endTime: 3, effectType: "captions", source: "user", label: "Caption", reason: "", enabled: true } as never;
  const withOwn = executeDirectorPlan({ plan, moments: [...project.analysis!.detectedMoments, own], duration: project.duration!, revision: 0, transcript: project.analysis?.transcript });
  const dirCaptions = withOwn.moments.filter((m) => m.effectType === "captions" && m.source === "ai-director");
  assert.equal(dirCaptions.length, 0, "no Director captions on top of the user's");
  assert.ok(withOwn.moments.some((m) => m.id === "aic_1"), "the user's captions are kept");
  assert.ok(withOwn.failures.some((f) => f.subject === "captions" && f.reason === "duplicate_operation"), "and the user is told why");
  // Without captions of its own, the Director still captions the video.
  const without = executeDirectorPlan({ plan, moments: project.analysis!.detectedMoments.filter((m) => m.effectType !== "captions"), duration: project.duration!, revision: 0, transcript: project.analysis?.transcript });
  assert.ok(without.moments.some((m) => m.effectType === "captions" && m.source === "ai-director"));
});

test("review drops a Director edit that repeats one already on the timeline (hook, same-window cut)", async () => {
  const { reviewDirectorResult } = await import("../src/lib/director/review.ts");
  const plan = buildHeuristicPlan(buildDirectorContext(demoProject()), REQUEST, NOW);
  const mk = (id: string, effectType: string, s: number, e: number, source: string) => ({ id, effectType, startTime: s, endTime: e, source, label: id, reason: "", enabled: true }) as never;
  const moments = [
    mk("gen-hook", "hook-text", 0.15, 3, "ai"),
    mk("pause", "cut", 118.58, 119.63, "user"),
    mk("dir_6_hook-9", "hook-text", 0.5, 3.2, "ai-director"),
    mk("dir_6_remove-8", "cut", 118.58, 119.63, "ai-director"),
    mk("dir_6_cta", "branding-cta", 150, 155, "ai-director"),
  ];
  const r = reviewDirectorResult({ plan, moments, duration: 160, reportedOutputDuration: 157.9 }) as unknown as { moments: { id: string }[] };
  const ids = r.moments.map((m) => m.id);
  assert.ok(ids.includes("gen-hook") && ids.includes("pause"), "existing edits always kept");
  assert.equal(ids.includes("dir_6_hook-9"), false, "second (overlapping) hook dropped");
  assert.equal(ids.includes("dir_6_remove-8"), false, "repeat of the user's cut dropped");
  assert.ok(ids.includes("dir_6_cta"), "genuinely new Director edits kept");
});
