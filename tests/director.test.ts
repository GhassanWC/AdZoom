/**
 * AI Director — the contract.
 *
 * These lock down the invariants the whole feature rests on:
 *   • the Director can NEVER emit an edit type Framevo can't render
 *   • the plan is the single source of truth; preview + export read one array
 *   • re-running the same request replaces its edits instead of duplicating them
 *   • a partial failure applies the rest and REPORTS what broke
 *   • user edits are never destroyed
 *   • undo restores exactly, from a replayed plan rather than a stored snapshot
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDirectorContext } from "../src/lib/director/context-builder.ts";
import { buildHeuristicPlan, sanitizeDirectorPlan } from "../src/lib/director/planner.ts";
import { validateDirectorPlan } from "../src/lib/director/validate.ts";
import {
  executePlan,
  isDirectorMoment,
  withoutDirectorMoments,
} from "../src/lib/director/executor.ts";
import { runDirectorPipeline } from "../src/lib/director/pipeline.ts";
import { reviewDirectorResult } from "../src/lib/director/review.ts";
import { applyRevision, parseRevisionCommand } from "../src/lib/director/revision.ts";
import {
  commitRun,
  failRun,
  isSameRequest,
  startRun,
  stripUndefinedDeep,
  undoLastRevision,
} from "../src/lib/director/state.ts";
import { hashDirectorRequest, parseDirectorRequest } from "../src/lib/director/request.ts";
import { DEFAULT_REVIEW_RULES, DIRECTOR_EDIT_TYPES } from "../src/lib/director/types.ts";
import type { DirectorPlan, DirectorRequest } from "../src/lib/director/types.ts";

import { buildTimelineMap } from "../src/lib/timeline/crop-speed.ts";
import { buildRenderRecipe } from "../src/lib/render/recipe.ts";
import { materializeProject } from "../src/lib/firebase/materialize-project.ts";
import { DEFAULT_EFFECTS_SETTINGS } from "../src/lib/firebase/schema.ts";
import type { DetectedMoment, EffectsSettings } from "../src/lib/firebase/schema.ts";

import {
  demoProject,
  noTranscriptProject,
  SOURCE_DURATION,
  userMoment,
} from "./director-fixtures.ts";

const NOW = 1_700_000_000_000;

/** The spec's own example request. */
const TIKTOK_REQUEST: DirectorRequest = parseDirectorRequest(
  "Turn this recording into a fast 45-second product demo for TikTok. Remove boring parts, keep the payment demonstration, use energetic captions and finish with a CTA.",
  {}
);

function ctxFor(project = demoProject()) {
  return buildDirectorContext(project);
}

function planFor(project = demoProject(), request = TIKTOK_REQUEST): DirectorPlan {
  return buildHeuristicPlan(buildDirectorContext(project), request, NOW);
}

function runFull(
  project = demoProject(),
  request = TIKTOK_REQUEST,
  moments?: DetectedMoment[]
) {
  const plan = planFor(project, request);
  return runDirectorPipeline({
    plan,
    moments: moments ?? project.analysis!.detectedMoments,
    duration: project.duration!,
    revision: 0,
    transcript: project.analysis?.transcript,
    videoType: project.selectedVideoType,
    sourceWidth: project.width,
    sourceHeight: project.height,
    effects: project.effectsSettings,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 0. The request parser understands the spec's example
// ════════════════════════════════════════════════════════════════════════════

test("request parser: the spec's example prompt is understood end to end", () => {
  const r = TIKTOK_REQUEST;
  assert.equal(r.targetDurationSeconds, 45, "'45-second' → 45s target");
  assert.equal(r.platform, "tiktok", "'for TikTok' → tiktok");
  assert.equal(r.aspectRatio, "9:16", "TikTok implies vertical");
  assert.equal(r.style, "energetic", "'fast' + 'energetic' → energetic");
  assert.equal(r.captionStyle, "bold_social", "'energetic captions' → bold social");
  assert.equal(r.cta, "always", "'finish with a CTA' → always");
  assert.equal(r.goal, "product-demo");
});

test("request parser: an explicit prompt beats the form control", () => {
  const r = parseDirectorRequest("make it vertical, 30 seconds", {
    aspectRatio: "16:9",
    targetDurationSeconds: 120,
  });
  assert.equal(r.aspectRatio, "9:16");
  assert.equal(r.targetDurationSeconds, 30);
});

test("request parser: the form is used for whatever the prompt leaves unsaid", () => {
  const r = parseDirectorRequest("clean this up", {
    platform: "linkedin",
    targetDurationSeconds: 90,
  });
  assert.equal(r.platform, "linkedin");
  assert.equal(r.aspectRatio, "1:1", "LinkedIn's default aspect");
  assert.equal(r.targetDurationSeconds, 90);
});

// ════════════════════════════════════════════════════════════════════════════
// 1. Plan schema validation
// ════════════════════════════════════════════════════════════════════════════

test("1. plan schema: a heuristic plan validates cleanly against the source", () => {
  const plan = planFor();
  const { plan: validated, failures, usable } = validateDirectorPlan(plan, SOURCE_DURATION);

  assert.equal(usable, true);
  assert.equal(failures.length, 0, `unexpected failures: ${JSON.stringify(failures)}`);
  assert.ok(validated.storyStructure.length > 0, "has a story");
  assert.ok(validated.editOperations.length > 0, "has edits");

  // Every operation carries the full contract: id, window, reason, confidence,
  // priority, evidence.
  for (const op of validated.editOperations) {
    assert.ok(op.id, "operation has a stable id");
    assert.ok(op.endTime > op.startTime, `${op.id}: end > start`);
    assert.ok(op.reason.length > 0, `${op.id}: has a reason`);
    assert.ok(op.confidence >= 0 && op.confidence <= 1, `${op.id}: confidence in 0..1`);
    assert.ok(op.priority >= 0 && op.priority <= 1, `${op.id}: priority in 0..1`);
    assert.ok(op.evidence.length > 0, `${op.id}: cites evidence`);
    assert.ok(
      (DIRECTOR_EDIT_TYPES as readonly string[]).includes(op.editType),
      `${op.id}: names an existing Framevo edit type`
    );
  }
});

test("1b. plan schema: a malformed model response sanitizes into a valid shape", () => {
  const raw = {
    goal: "do the thing",
    storyStructure: [
      { id: "s1", kind: "hook", title: "H", startTime: "0", endTime: "5", confidence: 7 },
    ],
    editOperations: [
      {
        id: "e1",
        editType: "zoom",
        startTime: 10,
        endTime: 12,
        confidence: -3,
        priority: "0.8",
        focusRegion: { x: 5, y: -1, width: 0.3, height: 0.3 },
      },
    ],
    // clipOperations / audioOperations / captionInstructions all missing.
  };

  const plan = sanitizeDirectorPlan(raw, TIKTOK_REQUEST, "test-model", NOW);

  assert.equal(plan.storyStructure[0].endTime, 5, "string numbers coerced");
  assert.equal(plan.storyStructure[0].confidence, 1, "confidence clamped to 0..1");
  assert.equal(plan.editOperations[0].confidence, 0, "negative confidence clamped");
  assert.equal(plan.editOperations[0].priority, 0.8, "string priority coerced");
  assert.equal(plan.editOperations[0].focusRegion!.x, 1, "focus region clamped to 0..1");
  assert.equal(plan.editOperations[0].focusRegion!.y, 0);
  assert.deepEqual(plan.clipOperations, [], "missing arrays default to empty");
  assert.deepEqual(plan.audioOperations, []);
  assert.equal(plan.captionInstructions.enabled, false);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Invalid timestamps
// ════════════════════════════════════════════════════════════════════════════

test("2. invalid timestamps: rejected with a reason, never silently applied", () => {
  const plan: DirectorPlan = {
    ...planFor(),
    editOperations: [
      op("neg", "zoom", -50, -10),
      op("inverted", "zoom", 100, 50),
      op("past-end", "zoom", 900, 950),
      op("zero-length", "zoom", 100, 100),
      op("overrun", "zoom", SOURCE_DURATION - 0.3, SOURCE_DURATION + 5), // clampable
      op("ok", "zoom", 130, 133),
    ],
  };

  const { plan: validated, failures } = validateDirectorPlan(plan, SOURCE_DURATION);
  const ids = validated.editOperations.map((o) => o.id);

  assert.deepEqual(ids.sort(), ["ok", "overrun"], "only the valid + clampable ops survive");

  const overrun = validated.editOperations.find((o) => o.id === "overrun")!;
  assert.equal(overrun.endTime, SOURCE_DURATION, "a slight overrun is clamped, not dropped");

  for (const bad of ["neg", "inverted", "past-end", "zero-length"]) {
    const f = failures.find((x) => x.operationId === bad);
    assert.ok(f, `${bad} produced a failure`);
    assert.ok(
      f!.reason === "invalid_window" || f!.reason === "out_of_bounds",
      `${bad} failed for the right reason (got ${f!.reason})`
    );
    assert.ok(f!.detail.length > 10, `${bad} failure explains itself`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Unsupported edit types
// ════════════════════════════════════════════════════════════════════════════

test("3. unsupported edit types: rejected, reported, and never coerced to something else", () => {
  // Isolate the edit operations — the other op kinds legitimately produce cuts,
  // and this test is specifically about what the ALLOWLIST lets through.
  const plan: DirectorPlan = {
    ...planFor(),
    clipOperations: [],
    audioOperations: [],
    captionInstructions: {
      enabled: false,
      stylePreset: "clean",
      position: "bottom",
      reason: "off for this test",
    },
    editOperations: [
      op("hallucinated", "green-screen" as never, 10, 14),
      op("also-fake", "auto-b-roll" as never, 20, 24),
      // Real EffectTypes that are deliberately OFF the Director allowlist.
      op("blur", "blur-redaction" as never, 30, 34),
      op("legacy-crop", "crop" as never, 40, 44),
      op("real", "zoom", 130, 133),
    ],
  };

  const { plan: validated, failures } = validateDirectorPlan(plan, SOURCE_DURATION);

  assert.deepEqual(
    validated.editOperations.map((o) => o.id),
    ["real"],
    "only allowlisted types survive"
  );

  for (const id of ["hallucinated", "also-fake", "blur", "legacy-crop"]) {
    const f = failures.find((x) => x.operationId === id);
    assert.ok(f, `${id} was reported`);
    assert.equal(f!.reason, "unsupported_edit_type");
  }

  // The crucial property: NOTHING was quietly turned into a zoom.
  const execution = executePlan({
    plan: validated,
    moments: [],
    duration: SOURCE_DURATION,
    revision: 0,
  });
  const created = execution.moments.filter(isDirectorMoment);
  assert.equal(created.length, 1, "exactly one edit was created");
  assert.equal(created[0].effectType, "zoom");
});

test("3b. clip reordering is refused honestly (the render pipeline can't do it)", () => {
  const plan: DirectorPlan = {
    ...planFor(),
    clipOperations: [
      {
        id: "reorder-1",
        kind: "reorder",
        startTime: 100,
        endTime: 120,
        order: 0,
        reason: "move the payment part first",
        confidence: 0.9,
        priority: 0.9,
        evidence: [],
      },
    ],
  };

  const { plan: validated, failures } = validateDirectorPlan(plan, SOURCE_DURATION);

  assert.equal(validated.clipOperations.length, 0, "the reorder op does not survive");
  const f = failures.find((x) => x.operationId === "reorder-1")!;
  assert.equal(f.reason, "unsupported_operation");
  assert.match(
    f.detail,
    /order/i,
    "the failure explains that source time plays in order — no silent mis-render"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Duplicate operations
// ════════════════════════════════════════════════════════════════════════════

test("4. duplicate operations: same id AND same (type, window) are both caught", () => {
  const plan: DirectorPlan = {
    ...planFor(),
    editOperations: [
      op("a", "zoom", 130, 133),
      op("a", "zoom", 140, 143), // duplicate id
      op("b", "zoom", 130, 133), // duplicate window+type
      op("c", "callout", 130, 133, { text: "Here" }), // different type — fine
    ],
  };

  const { plan: validated, failures } = validateDirectorPlan(plan, SOURCE_DURATION);

  assert.deepEqual(validated.editOperations.map((o) => o.id).sort(), ["a", "c"]);
  assert.equal(
    failures.filter((f) => f.reason === "duplicate_operation").length,
    2,
    "both duplicates reported"
  );
});

test("4b. re-running the SAME request replaces the Director's edits, never duplicates them", () => {
  const project = demoProject();
  const first = runFull(project);
  assert.ok(first.applied);

  // Second run against the timeline the first one produced.
  const second = runFull(project, TIKTOK_REQUEST, first.moments);

  const countDirector = (ms: DetectedMoment[]) => ms.filter(isDirectorMoment).length;
  assert.equal(
    countDirector(second.moments),
    countDirector(first.moments),
    "the edit count is identical — the run replaced its own work"
  );

  // And the moment IDS are identical, so nothing stacked up.
  const ids = (ms: DetectedMoment[]) =>
    ms.filter(isDirectorMoment).map((m) => m.id).sort();
  assert.deepEqual(ids(second.moments), ids(first.moments));

  // The request hash is what the route uses to detect this before doing any work.
  const h1 = hashDirectorRequest(TIKTOK_REQUEST, "fp");
  const h2 = hashDirectorRequest(parseDirectorRequest(TIKTOK_REQUEST.prompt, {}), "fp");
  assert.equal(h1, h2, "the same request hashes identically");
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Target-duration enforcement
// ════════════════════════════════════════════════════════════════════════════

test("5. target duration: a 45s ask really shortens a 380s source", () => {
  const result = runFull();
  const out = result.summary.outputDurationSeconds;

  assert.ok(out < SOURCE_DURATION * 0.35, `380s → ${out.toFixed(0)}s is a real reduction`);
  assert.ok(out > 0, "something survives");

  // The output duration is the EXPORT's own number, not a claim.
  const map = buildTimelineMap(result.moments, SOURCE_DURATION);
  assert.ok(
    Math.abs(map.outputDuration - out) < 0.05,
    "the reported duration is the timeline map's duration"
  );
});

test("5b. target duration: the hook and the CTA survive the squeeze; context is sacrificed first", () => {
  const project = demoProject();
  const tight = parseDirectorRequest(
    "make a 30 second product demo for tiktok with a CTA",
    {}
  );
  const result = runFull(project, tight);

  const kinds = result.plan.storyStructure.map((s) => s.kind);
  assert.ok(kinds.includes("hook"), "the hook is never sacrificed");
  assert.ok(
    result.moments.some((m) => m.effectType === "branding-cta"),
    "the CTA is never sacrificed"
  );

  // A shorter target must produce a shorter (or equal) video than a longer one.
  const loose = runFull(project, parseDirectorRequest("make a 120 second demo", {}));
  assert.ok(
    result.summary.outputDurationSeconds <= loose.summary.outputDurationSeconds + 0.01,
    "a tighter target yields a shorter result"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Story section ordering
// ════════════════════════════════════════════════════════════════════════════

test("6. story order: sections are always hook → context → demo → result → cta", () => {
  const plan = planFor();
  const ORDER = ["hook", "context", "demo", "result", "cta"];
  const idx = plan.storyStructure.map((s) => ORDER.indexOf(s.kind));

  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] >= idx[i - 1], `section ${i} is not out of order`);
  }
  assert.equal(plan.storyStructure[0].kind, "hook", "always opens on a hook");

  // Sections cover real source windows, in increasing time.
  for (const s of plan.storyStructure) {
    assert.ok(s.endTime > s.startTime);
    assert.ok(s.startTime >= 0 && s.endTime <= SOURCE_DURATION);
  }
});

test("6b. story order: a scrambled plan is re-ordered, not accepted as-is", () => {
  const base = planFor();
  const scrambled: DirectorPlan = {
    ...base,
    storyStructure: [
      { id: "a", kind: "cta", title: "CTA", startTime: 300, endTime: 310, reason: "r", confidence: 0.8, evidence: [] },
      { id: "b", kind: "hook", title: "Hook", startTime: 0, endTime: 6, reason: "r", confidence: 0.8, evidence: [] },
      { id: "c", kind: "demo", title: "Demo", startTime: 100, endTime: 200, reason: "r", confidence: 0.8, evidence: [] },
    ],
  };

  const { plan } = validateDirectorPlan(scrambled, SOURCE_DURATION);
  assert.deepEqual(
    plan.storyStructure.map((s) => s.kind),
    ["hook", "demo", "cta"],
    "a CTA-before-demo plan is corrected — that would end the video mid-story"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Timeline operation execution
// ════════════════════════════════════════════════════════════════════════════

test("7. execution: every operation becomes a REAL DetectedMoment on the real timeline", () => {
  const result = runFull();
  const created = result.moments.filter(isDirectorMoment);

  assert.ok(created.length > 0);

  for (const m of created) {
    assert.equal(m.source, "ai-director", "stamped with its source");
    assert.ok(m.director, "carries a back-link to the plan operation");
    assert.equal(m.director!.revision, 0);
    assert.ok(m.reason.length > 0, "carries the reason the user can read");
    assert.ok(m.endTime > m.startTime);
  }

  // The edits use the EXISTING settings bags — not a parallel Director format.
  const zoom = created.find((m) => m.effectType === "zoom");
  assert.ok(zoom, "produced a zoom");
  assert.ok(typeof zoom!.intensity === "number", "a zoom carries `intensity`");

  const cut = created.find((m) => m.effectType === "cut");
  assert.ok(cut?.cut?.active === true, "a cut carries `cut.active` — the real cut model");

  const cta = created.find((m) => m.effectType === "branding-cta");
  assert.ok(cta?.brandingCta?.ctaText, "a CTA carries `brandingCta.ctaText`");

  const caption = created.find((m) => m.effectType === "captions");
  assert.ok(caption?.captions?.text, "a caption carries `captions.text`");

  // The timeline lane router must be able to place every one of them.
  // (An effect type with no lane is a compile error in laneModel, but a moment
  // with a bogus type would still slip through at runtime.)
  const VALID = new Set(DIRECTOR_EDIT_TYPES as readonly string[]);
  for (const m of created) {
    assert.ok(VALID.has(m.effectType), `${m.effectType} is a routable lane type`);
  }
});

test("7b. execution: the user's manual edits are never touched", () => {
  const project = demoProject();
  const withUser = [...project.analysis!.detectedMoments, userMoment()];

  const result = runFull(project, TIKTOK_REQUEST, withUser);

  const mine = result.moments.find((m) => m.id === "u-manual-1");
  assert.ok(mine, "the user's edit survived the Director run");
  assert.equal(mine!.source, "user");
  assert.equal(mine!.intensity, 0.9, "and was not modified");
});

test("7c. execution: every Director edit is individually editable and deletable", () => {
  const result = runFull();
  const created = result.moments.filter(isDirectorMoment);

  // The whole point of compiling to DetectedMoment: the ordinary editor
  // mutators work on these with no special-casing. Simulate what the context's
  // updateMoment / deleteMoment / setLaneEnabled actually do.
  const target = created.find((m) => m.effectType === "zoom")!;

  const edited = result.moments.map((m) =>
    m.id === target.id ? { ...m, startTime: 5, endTime: 9, edited: true } : m
  );
  assert.equal(edited.find((m) => m.id === target.id)!.startTime, 5, "movable");

  const deleted = result.moments.filter((m) => m.id !== target.id);
  assert.equal(deleted.length, result.moments.length - 1, "deletable");

  const disabled = result.moments.map((m) =>
    m.id === target.id ? { ...m, enabled: false } : m
  );
  assert.equal(
    disabled.find((m) => m.id === target.id)!.enabled,
    false,
    "non-destructively disable-able"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Revision commands
// ════════════════════════════════════════════════════════════════════════════

test("8. revision parser: every command from the spec is understood", () => {
  const cases: Array<[string, string]> = [
    ["Make the beginning faster", "pace-section"],
    ["Reduce the number of zooms", "adjust-edit-count"],
    ["Remove the third clip", "remove-clip"],
    ["Keep more of the pricing section", "keep-more"],
    ["Make the captions more professional", "set-caption-style"],
    ["Change it to vertical", "set-aspect"],
    ["Add a stronger CTA", "strengthen-cta"],
    ["Make it 30 seconds", "set-target-duration"],
  ];

  for (const [command, expected] of cases) {
    const parsed = parseRevisionCommand(command);
    assert.equal(parsed.unrecognized, false, `understood: "${command}"`);
    assert.ok(
      parsed.intents.some((i) => i.kind === expected),
      `"${command}" → ${expected} (got ${parsed.intents.map((i) => i.kind).join(",")})`
    );
  }
});

test("8b. revision parser: gibberish is reported as unrecognized, not guessed at", () => {
  const parsed = parseRevisionCommand("make it more banana flavoured");
  assert.equal(parsed.unrecognized, true);
  assert.equal(parsed.intents.length, 0, "a wrong guess would silently rewrite the video");
});

test("8c. revision: 'make it 30 seconds' really shortens the existing plan", () => {
  const project = demoProject();
  const ctx = ctxFor(project);
  const first = runFull(project);

  const { intents } = parseRevisionCommand("make it 30 seconds");
  const revised = applyRevision(first.plan, intents, ctx, 1);

  const second = runDirectorPipeline({
    plan: revised.plan,
    moments: first.moments,
    duration: SOURCE_DURATION,
    revision: 1,
    transcript: project.analysis!.transcript,
    videoType: project.selectedVideoType,
    sourceWidth: project.width,
    sourceHeight: project.height,
    effects: project.effectsSettings,
  });

  assert.ok(second.applied);
  assert.ok(
    second.summary.outputDurationSeconds < first.summary.outputDurationSeconds,
    `revision shortened ${first.summary.outputDurationSeconds.toFixed(0)}s → ${second.summary.outputDurationSeconds.toFixed(0)}s`
  );
  assert.ok(revised.changes.length > 0, "the revision explains what it did");
});

test("8d. revision: 'reduce the number of zooms' removes zooms and keeps the strongest", () => {
  const project = demoProject();
  const ctx = ctxFor(project);
  const first = runFull(project);

  const zoomsBefore = first.moments.filter(
    (m) => isDirectorMoment(m) && m.effectType === "zoom" && m.enabled !== false
  ).length;
  assert.ok(zoomsBefore >= 2, "there are zooms to reduce");

  const { intents } = parseRevisionCommand("reduce the number of zooms");
  const revised = applyRevision(first.plan, intents, ctx, 1);
  const second = runDirectorPipeline({
    plan: revised.plan,
    moments: first.moments,
    duration: SOURCE_DURATION,
    revision: 1,
    transcript: project.analysis!.transcript,
    effects: project.effectsSettings,
  });

  const zoomsAfter = second.moments.filter(
    (m) => isDirectorMoment(m) && m.effectType === "zoom" && m.enabled !== false
  ).length;
  assert.ok(zoomsAfter < zoomsBefore, `${zoomsBefore} → ${zoomsAfter} zooms`);
});

test("8e. revision: 'change it to vertical' reframes the real output canvas", () => {
  const project = demoProject();
  const ctx = ctxFor(project);
  // Start from a 16:9 request so the change is real.
  const first = runFull(project, parseDirectorRequest("clean up this demo for youtube", {}));

  const { intents } = parseRevisionCommand("change it to vertical");
  const revised = applyRevision(first.plan, intents, ctx, 1);
  const second = runDirectorPipeline({
    plan: revised.plan,
    moments: first.moments,
    duration: SOURCE_DURATION,
    revision: 1,
    transcript: project.analysis!.transcript,
    effects: project.effectsSettings,
  });

  assert.ok(second.outputCanvas, "an output canvas was produced");
  assert.equal(second.outputCanvas!.aspectRatio, "9:16");
  assert.ok(
    second.outputCanvas!.height > second.outputCanvas!.width,
    "the canvas is genuinely portrait"
  );
});

test("8f. revision: 'keep more of the pricing section' finds pricing in the TRANSCRIPT", () => {
  const project = demoProject();
  const ctx = ctxFor(project);
  // A tight target so the pricing talk gets squeezed out first.
  const first = runFull(project, parseDirectorRequest("30 second demo for tiktok", {}));

  const { intents } = parseRevisionCommand("keep more of the pricing section");
  assert.deepEqual(intents, [{ kind: "keep-more", query: "pricing" }]);

  const revised = applyRevision(first.plan, intents, ctx, 1);
  const second = runDirectorPipeline({
    plan: revised.plan,
    moments: first.moments,
    duration: SOURCE_DURATION,
    revision: 1,
    transcript: project.analysis!.transcript,
    effects: project.effectsSettings,
  });

  // "pricing options come up right here" is spoken at 150–162s. After the
  // revision that window must SURVIVE (not be inside an active cut).
  const map = buildTimelineMap(second.moments, SOURCE_DURATION);
  const covered = map.segments.some((s) => s.sourceStart <= 156 && s.sourceEnd >= 156);
  assert.ok(covered, "the pricing talk at ~156s survives to the output");
  assert.ok(revised.changes.some((c) => /pricing/i.test(c)));
});

test("8g. revision: an impossible ask is refused honestly, not faked", () => {
  const project = noTranscriptProject();
  const ctx = ctxFor(project);
  const plan = planFor(project, parseDirectorRequest("clean this up", {}));

  const { intents } = parseRevisionCommand("add captions");
  const revised = applyRevision(plan, intents, ctx, 1);

  assert.equal(
    revised.plan.captionInstructions.enabled,
    false,
    "captions stay off — there is no transcript to caption from"
  );
  assert.ok(
    revised.noops.some((n) => /transcript/i.test(n)),
    "and the user is told exactly why"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Undoing a revision
// ════════════════════════════════════════════════════════════════════════════

test("9. undo: restores the previous timeline EXACTLY, by replaying the previous plan", () => {
  const project = demoProject();
  const ctx = ctxFor(project);

  // Run 1.
  const first = runFull(project);
  let state = startRun(undefined, TIKTOK_REQUEST.prompt, TIKTOK_REQUEST, "h1", NOW);
  state = commitRun(state, {
    plan: first.plan,
    summary: first.summary,
    review: first.review,
    failures: first.failures,
    appliedOperationIds: first.appliedOperationIds,
    command: "",
    now: NOW,
  });

  // Revision: 30 seconds.
  const { intents } = parseRevisionCommand("make it 30 seconds");
  const revised = applyRevision(first.plan, intents, ctx, 1);
  const second = runDirectorPipeline({
    plan: revised.plan,
    moments: first.moments,
    duration: SOURCE_DURATION,
    revision: 1,
    transcript: project.analysis!.transcript,
    effects: project.effectsSettings,
  });
  state = commitRun(state, {
    plan: second.plan,
    summary: second.summary,
    review: second.review,
    failures: second.failures,
    appliedOperationIds: second.appliedOperationIds,
    command: "make it 30 seconds",
    now: NOW + 1,
  });
  assert.equal(state.revisions.length, 2);

  // UNDO.
  const target = undoLastRevision(state)!;
  assert.ok(target);
  assert.ok(target.plan, "there is a previous plan to replay");
  assert.equal(target.revision, 0, "replayed at the original revision index");
  assert.equal(target.state.revisions.length, 1);

  const restored = runDirectorPipeline({
    plan: target.plan!,
    moments: second.moments,
    duration: SOURCE_DURATION,
    revision: target.revision,
    transcript: project.analysis!.transcript,
    videoType: project.selectedVideoType,
    sourceWidth: project.width,
    sourceHeight: project.height,
    effects: project.effectsSettings,
  });

  // The restore is EXACT — same ids, same windows, same durations. This is what
  // proves storing plans (not timeline snapshots) is a lossless history.
  const sig = (ms: DetectedMoment[]) =>
    ms
      .filter(isDirectorMoment)
      .map((m) => `${m.id}|${m.effectType}|${m.startTime}|${m.endTime}`)
      .sort();

  assert.deepEqual(sig(restored.moments), sig(first.moments), "byte-identical restore");
  assert.equal(
    restored.summary.outputDurationSeconds,
    first.summary.outputDurationSeconds
  );
});

test("9b. undo: undoing the ONLY run removes every Director edit and restores the user's timeline", () => {
  const project = demoProject();
  const original = [...project.analysis!.detectedMoments, userMoment()];

  const first = runFull(project, TIKTOK_REQUEST, original);
  assert.ok(first.moments.filter(isDirectorMoment).length > 0);

  let state = startRun(undefined, "p", TIKTOK_REQUEST, "h", NOW);
  state = commitRun(state, {
    plan: first.plan,
    summary: first.summary,
    review: first.review,
    failures: first.failures,
    appliedOperationIds: first.appliedOperationIds,
    now: NOW,
  });

  const target = undoLastRevision(state)!;
  assert.equal(target.plan, null, "nothing to replay — remove everything");
  assert.equal(target.state.status, "idle");
  assert.deepEqual(target.state.revisions, []);

  const restored = withoutDirectorMoments(first.moments);
  assert.equal(restored.filter(isDirectorMoment).length, 0, "no Director edits remain");
  assert.deepEqual(
    restored.map((m) => m.id).sort(),
    original.map((m) => m.id).sort(),
    "the timeline is exactly what it was before the Director ran"
  );
});

test("9c. undo: nothing to undo returns null rather than corrupting state", () => {
  const state = startRun(undefined, "p", TIKTOK_REQUEST, "h", NOW);
  assert.equal(undoLastRevision(state), null);
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Partial edit failure
// ════════════════════════════════════════════════════════════════════════════

test("10. partial failure: the good edits apply, the bad ones are REPORTED, run still succeeds", () => {
  const good = planFor();
  const plan: DirectorPlan = {
    ...good,
    editOperations: [
      ...good.editOperations,
      op("bad-type", "teleport" as never, 130, 134),
      op("bad-window", "zoom", 5000, 5100),
      op("no-text", "hook-text", 2, 4), // missing params.text
      op("no-mult", "speed-up", 70, 75), // missing params.speedMultiplier
    ],
  };

  const result = runDirectorPipeline({
    plan,
    moments: demoProject().analysis!.detectedMoments,
    duration: SOURCE_DURATION,
    revision: 0,
    transcript: demoProject().analysis!.transcript,
    effects: DEFAULT_EFFECTS_SETTINGS,
  });

  assert.equal(result.applied, true, "the run still succeeded");
  assert.ok(result.appliedOperationIds.length > 0, "the good edits landed");

  const reasons = new Map(result.failures.map((f) => [f.operationId, f.reason]));
  assert.equal(reasons.get("bad-type"), "unsupported_edit_type");
  assert.equal(reasons.get("bad-window"), "out_of_bounds");
  assert.equal(reasons.get("no-text"), "missing_params");
  assert.equal(reasons.get("no-mult"), "missing_params");

  // Every failure is a real sentence the user can act on.
  for (const f of result.failures) {
    assert.ok(f.detail.length > 15, `failure "${f.operationId}" explains itself`);
  }

  // And none of the broken ops silently became something else.
  const created = result.moments.filter(isDirectorMoment);
  assert.equal(
    created.filter((m) => m.id.includes("bad-") || m.id.includes("no-")).length,
    0
  );
});

test("10b. a run that applies NOTHING is never reported as complete", () => {
  const empty: DirectorPlan = {
    ...planFor(),
    storyStructure: [],
    clipOperations: [],
    editOperations: [op("bogus", "not-a-thing" as never, 10, 20)],
    audioOperations: [],
    captionInstructions: {
      enabled: false,
      stylePreset: "clean",
      position: "bottom",
      reason: "off",
    },
  };

  const result = runDirectorPipeline({
    plan: empty,
    moments: [],
    duration: SOURCE_DURATION,
    revision: 0,
  });

  assert.equal(result.applied, false, "`applied` is the gate the route checks");
  assert.equal(result.appliedOperationIds.length, 0);

  // The state layer must record this as FAILED, never complete.
  let state = startRun(undefined, "p", TIKTOK_REQUEST, "h", NOW);
  state = failRun(state, "nothing applied", result.failures, NOW);
  assert.equal(state.status, "failed");
  assert.notEqual(state.status as string, "complete");
});

test("10c. captions requested with no transcript: reported honestly, never invented", () => {
  const project = noTranscriptProject();
  const result = runFull(project, TIKTOK_REQUEST);

  const captions = result.moments.filter((m) => m.effectType === "captions");
  assert.equal(captions.length, 0, "NO caption text was fabricated");

  // The plan itself refuses up front...
  assert.equal(result.plan.captionInstructions.enabled, false);
  assert.match(result.plan.captionInstructions.reason, /transcript/i);
  // ...and the run still succeeds with everything else applied.
  assert.equal(result.applied, true);
});

// ════════════════════════════════════════════════════════════════════════════
// 11. Project reload persistence
// ════════════════════════════════════════════════════════════════════════════

test("11. persistence: the Director state survives a Firestore round-trip", () => {
  const project = demoProject();
  const result = runFull(project);

  let state = startRun(undefined, TIKTOK_REQUEST.prompt, TIKTOK_REQUEST, "hash-1", NOW);
  state = commitRun(state, {
    plan: result.plan,
    summary: result.summary,
    review: result.review,
    failures: result.failures,
    appliedOperationIds: result.appliedOperationIds,
    command: "",
    now: NOW,
  });

  // What the route actually writes.
  const written = stripUndefinedDeep(state);

  // Firestore rejects `undefined` — a single one would make the write fail and
  // the "completed" run would vanish on refresh.
  assert.equal(
    JSON.stringify(written).includes("undefined"),
    false,
    "no undefined survived the strip"
  );
  assertNoUndefined(written);

  // Round-trip through Firestore's own serialization, then the materializer.
  const raw = JSON.parse(JSON.stringify(written)) as Record<string, unknown>;
  const reloaded = materializeProject("proj-demo", {
    ...(project as unknown as Record<string, unknown>),
    director: raw,
    analysis: JSON.parse(JSON.stringify(project.analysis)),
  });

  // THE materialize-whitelist bug (the one that broke Smart Clips) would show
  // up right here as `undefined`.
  assert.ok(reloaded.director, "director survived materializeProject");
  assert.equal(reloaded.director!.status, "complete");
  assert.equal(reloaded.director!.prompt, TIKTOK_REQUEST.prompt);
  assert.equal(reloaded.director!.revisions.length, 1);
  assert.ok(reloaded.director!.plan, "the plan — the source of truth — survived");
  assert.deepEqual(
    reloaded.director!.summary!.lines,
    result.summary.lines,
    "the summary the user saw is the summary they'll see after a refresh"
  );
  assert.ok(reloaded.director!.modelVersion, "model version recorded");
  assert.equal(reloaded.director!.planVersion, 1, "plan version recorded");
});

test("11b. persistence: a stored plan can be replayed after reload to the same timeline", () => {
  const project = demoProject();
  const first = runFull(project);

  // Simulate: user closes the tab. Project reopens. Only the PLAN is in the doc.
  const storedPlan: DirectorPlan = JSON.parse(JSON.stringify(first.plan));

  const replayed = runDirectorPipeline({
    plan: storedPlan,
    moments: project.analysis!.detectedMoments,
    duration: SOURCE_DURATION,
    revision: 0,
    transcript: project.analysis!.transcript,
    videoType: project.selectedVideoType,
    sourceWidth: project.width,
    sourceHeight: project.height,
    effects: project.effectsSettings,
  });

  const sig = (ms: DetectedMoment[]) =>
    ms.filter(isDirectorMoment).map((m) => `${m.id}|${m.startTime}|${m.endTime}`).sort();
  assert.deepEqual(sig(replayed.moments), sig(first.moments), "replay is deterministic");
});

// ════════════════════════════════════════════════════════════════════════════
// 12. Preview / export parity
// ════════════════════════════════════════════════════════════════════════════

test("12. parity: preview and export consume the SAME moments and agree exactly", () => {
  const project = demoProject();
  const result = runFull(project);

  const effects: EffectsSettings = result.outputCanvas
    ? { ...project.effectsSettings, outputCanvas: result.outputCanvas }
    : project.effectsSettings;

  // PREVIEW: RealVideoPlayer reads `previewMoments` (= detectedMoments when no
  // clip is focused) and resolves the camera + overlays from it.
  const previewMoments = result.moments;
  const previewMap = buildTimelineMap(previewMoments, SOURCE_DURATION);

  // EXPORT: RealExportPanel passes the same array into buildRenderRecipe.
  const recipe = buildRenderRecipe({
    sourceWidth: project.width!,
    sourceHeight: project.height!,
    fps: 30,
    resolution: "1080p",
    format: "Source",
    sourceDuration: SOURCE_DURATION,
    moments: result.moments,
    effects,
    sourceCrop: null,
    applyWatermark: false,
  });

  assert.deepEqual(
    recipe.moments,
    previewMoments,
    "the export recipe carries the exact array the preview renders"
  );
  assert.equal(
    recipe.outputDuration,
    previewMap.outputDuration,
    "and both derive the same output duration"
  );
  assert.equal(
    recipe.outputDuration,
    result.summary.outputDurationSeconds,
    "which is the number the Director reported to the user"
  );

  // The canvas the Director set is the canvas the export renders at.
  if (result.outputCanvas) {
    assert.ok(
      recipe.canvasH > recipe.canvasW,
      "a 9:16 Director run exports a portrait canvas"
    );
  }

  // And the review agrees.
  assert.equal(result.review.parityOk, true);
});

test("12b. parity: an unserializable moment is caught as a parity ERROR", () => {
  const project = demoProject();
  const result = runFull(project);

  // Inject the exact failure mode that breaks parity in the real world: a field
  // Firestore will reject, so the moment saves as missing and preview (memory)
  // and export (reloaded doc) disagree.
  const poisoned = result.moments.map((m, i) =>
    i === 0 ? ({ ...m, intensity: undefined } as DetectedMoment) : m
  );

  const review = reviewDirectorResult({
    plan: result.plan,
    moments: poisoned,
    duration: SOURCE_DURATION,
    effects: project.effectsSettings,
    reportedOutputDuration: result.summary.outputDurationSeconds,
  });

  assert.equal(review.parityOk, false);
  assert.ok(review.findings.some((f) => f.rule === "preview-export-parity"));
  assert.ok(review.errors > 0);
});

// ════════════════════════════════════════════════════════════════════════════
// 13. Caption safe-area validation
// ════════════════════════════════════════════════════════════════════════════

test("13. review: captions outside the safe area are detected and auto-fixed", () => {
  const project = demoProject();
  const result = runFull(project);

  const caption = result.moments.find((m) => m.effectType === "captions");
  assert.ok(caption, "the fixture produces captions");

  // Shove a caption below the safe area.
  const bad = result.moments.map((m) =>
    m.id === caption!.id
      ? ({ ...m, textStyle: { ...(m.textStyle ?? {}), position: "custom" as const, customY: 0.98 } } as DetectedMoment)
      : m
  );

  const review = reviewDirectorResult({
    plan: result.plan,
    moments: bad,
    duration: SOURCE_DURATION,
    effects: project.effectsSettings,
    reportedOutputDuration: result.summary.outputDurationSeconds,
  });

  const finding = review.findings.find((f) => f.rule === "caption-safe-area");
  assert.ok(finding, "the violation was detected");
  assert.equal(finding!.fixed, true, "and safely auto-fixed");

  const fixed = review.moments.find((m) => m.id === caption!.id)!;
  assert.ok(fixed.textStyle!.customY! <= 0.88, "pulled back inside the safe area");
  assert.ok(review.autoFixed > 0);
});

test("13b. review: on a 9:16 feed, bottom captions are lifted clear of the platform UI", () => {
  const project = demoProject();
  const result = runFull(project); // TikTok request → 9:16

  const effects: EffectsSettings = {
    ...project.effectsSettings,
    outputCanvas: result.outputCanvas,
  };

  // Force them back to "bottom" — where TikTok's own UI sits.
  const bottom = result.moments.map((m) =>
    m.effectType === "captions" && m.captions
      ? ({ ...m, captions: { ...m.captions, position: "bottom" as const } } as DetectedMoment)
      : m
  );

  const review = reviewDirectorResult({
    plan: result.plan,
    moments: bottom,
    duration: SOURCE_DURATION,
    effects,
    reportedOutputDuration: result.summary.outputDurationSeconds,
  });

  const finding = review.findings.find((f) => f.rule === "caption-safe-area");
  assert.ok(finding, "detected on a vertical canvas");
  assert.equal(finding!.fixed, true);

  const fixedCaption = review.moments.find((m) => m.effectType === "captions")!;
  assert.equal(fixedCaption.captions!.position, "center", "moved out of the UI chrome");
});

// ════════════════════════════════════════════════════════════════════════════
// 14. Excessive zoom detection
// ════════════════════════════════════════════════════════════════════════════

test("14. review: zooms packed too close together are detected and disabled (not deleted)", () => {
  const project = demoProject();
  const result = runFull(project);

  // Six zooms inside four seconds — a twitch, not emphasis.
  const spammy: DetectedMoment[] = [
    ...result.moments.filter((m) => m.effectType !== "zoom"),
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `dir_0_spam${i}`,
      startTime: 130 + i * 0.7,
      endTime: 130 + i * 0.7 + 0.5,
      label: "Zoom",
      reason: "spam",
      focusRegion: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
      effectType: "zoom" as const,
      source: "ai-director" as const,
      confidenceScore: 0.4 + i * 0.05,
    })),
  ];

  const review = reviewDirectorResult({
    plan: result.plan,
    moments: spammy,
    duration: SOURCE_DURATION,
    effects: project.effectsSettings,
    reportedOutputDuration: result.summary.outputDurationSeconds,
  });

  const finding = review.findings.find((f) => f.rule === "zoom-density");
  assert.ok(finding, "the zoom cluster was detected");
  assert.equal(finding!.fixed, true);

  const disabled = review.moments.filter(
    (m) => m.effectType === "zoom" && m.enabled === false
  );
  assert.ok(disabled.length > 0, "the weakest were turned off");

  // DISABLED, not deleted — the user can flip them back on.
  const stillThere = review.moments.filter((m) => m.effectType === "zoom").length;
  assert.equal(
    stillThere,
    spammy.filter((m) => m.effectType === "zoom").length,
    "every zoom is still on the timeline; none were destroyed"
  );

  // The summary must not claim the disabled ones.
  assert.ok(finding!.fixDetail && /back/i.test(finding!.fixDetail));
});

test("14b. review: a normally-paced run raises no zoom-density finding", () => {
  const result = runFull(demoProject(), parseDirectorRequest("clean this up calmly", {}));
  const review = result.review;
  const finding = review.findings.find(
    (f) => f.rule === "zoom-density" && !f.fixed && f.severity === "warning"
  );
  assert.equal(finding, undefined, "no false positive on a well-paced edit");
});

// ════════════════════════════════════════════════════════════════════════════
// 15. THE INTEGRATION TEST — raw video → finished video
// ════════════════════════════════════════════════════════════════════════════

test("15. INTEGRATION: a 6:20 raw recording becomes a finished 45s vertical TikTok demo", () => {
  const project = demoProject();

  // ── The user types the spec's exact request. ────────────────────────────
  const request = parseDirectorRequest(
    "Turn this recording into a fast 45-second product demo for TikTok. Remove boring parts, keep the payment demonstration, use energetic captions and finish with a CTA.",
    {}
  );

  // ── 1. UNDERSTAND ──────────────────────────────────────────────────────
  const ctx = buildDirectorContext(project);
  assert.equal(ctx.hasTranscript, true, "read the transcript");
  assert.equal(ctx.hasInteractionData, true, "read the clicks");
  assert.ok(ctx.interactionTimes.length >= 10, "found the real interactions");
  assert.ok(ctx.candidates.length > 10, "built candidates from every signal");
  assert.ok(ctx.deadZones.length >= 3, "found the pauses, the loading, the ramble");
  assert.ok(ctx.deadSeconds > 60, `found ${ctx.deadSeconds.toFixed(0)}s of dead air`);

  // ── 2-6. PLAN → VALIDATE → APPLY ───────────────────────────────────────
  const result = runFull(project, request);
  assert.equal(result.applied, true, "real edits were applied");
  assert.equal(result.failures.length, 0, `clean run: ${JSON.stringify(result.failures)}`);

  // ── The story is a STORY, not a highlight reel. ─────────────────────────
  const kinds = result.plan.storyStructure.map((s) => s.kind);
  assert.ok(kinds.includes("hook"), "it has a hook");
  assert.ok(kinds.includes("cta"), "it has an ending");
  assert.deepEqual(kinds, [...kinds].sort(sectionSort), "in narrative order");

  // ── It kept the PAYMENT DEMONSTRATION, as asked. ────────────────────────
  const map = buildTimelineMap(result.moments, SOURCE_DURATION);
  const survives = (t: number) =>
    map.segments.some((s) => s.sourceStart <= t && s.sourceEnd >= t);

  assert.ok(
    survives(140) || survives(152) || survives(176),
    "the payment flow (128–210s) survives — the user asked to keep it"
  );

  // ── It removed the boring parts, as asked. ──────────────────────────────
  assert.ok(!survives(50), "the 40–62s dead air is gone");
  assert.ok(!survives(275), "the 250–300s loading spinner is gone");
  assert.ok(!survives(350), "the 300–380s off-topic ramble is gone");

  // ── It hit the duration target. ─────────────────────────────────────────
  const out = result.summary.outputDurationSeconds;
  assert.ok(out <= 45 * 1.25, `${out.toFixed(0)}s is at or near the 45s target`);
  assert.ok(out >= 10, `${out.toFixed(0)}s is a real video, not an empty timeline`);

  // ── It used the EXISTING edit systems, together. ────────────────────────
  const created = result.moments.filter(isDirectorMoment);
  const types = new Set(created.map((m) => m.effectType));
  assert.ok(types.has("cut"), "cuts");
  assert.ok(types.has("zoom"), "zooms");
  assert.ok(types.has("captions"), "captions");
  assert.ok(types.has("hook-text"), "a hook");
  assert.ok(types.has("branding-cta"), "a CTA");
  assert.ok(types.has("smart-crop"), "a vertical reframe");
  assert.ok(types.size >= 5, `used ${types.size} different edit systems together`);

  // ── The captions are REAL transcript words, not invented copy. ──────────
  const captions = created.filter((m) => m.effectType === "captions");
  assert.ok(captions.length > 5, `${captions.length} captions`);
  const transcriptText = project.analysis!.transcript!.text!.toLowerCase();
  for (const c of captions.slice(0, 10)) {
    const words = c.captions!.text.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    assert.ok(
      words.every((w) => transcriptText.includes(w.replace(/[^a-z]/g, ""))),
      `caption "${c.captions!.text}" comes from the real transcript`
    );
  }
  // "Energetic" is a real style, not a label.
  assert.equal(captions[0].textStyle?.uppercase, true, "energetic captions are uppercase");
  assert.ok((captions[0].textStyle?.fontWeight ?? 0) >= 700, "and heavy");

  // ── The canvas is genuinely vertical. ───────────────────────────────────
  assert.ok(result.outputCanvas, "produced an output canvas");
  assert.equal(result.outputCanvas!.aspectRatio, "9:16");
  assert.ok(result.outputCanvas!.height > result.outputCanvas!.width);

  // ── 7. THE REVIEW PASS RAN. ─────────────────────────────────────────────
  assert.equal(result.review.parityOk, true, "preview and export agree");
  assert.equal(result.review.errors, 0, "no errors survived the review");

  // ── The summary is honest: every claim is checkable on the timeline. ────
  const counts = result.summary.counts;
  const enabledOf = (t: string) =>
    created.filter((m) => m.effectType === t && m.enabled !== false).length;
  for (const [type, n] of Object.entries(counts)) {
    assert.equal(enabledOf(type), n, `the summary's "${n} ${type}" is really on the timeline`);
  }
  assert.ok(result.summary.lines.length >= 4, "the user gets a real summary");
  assert.ok(
    result.summary.lines.some((l) => /Reduced video from/.test(l)),
    "including the headline reduction"
  );

  // ── 8. IT EXPORTS. Same data, same result. ──────────────────────────────
  const recipe = buildRenderRecipe({
    sourceWidth: project.width!,
    sourceHeight: project.height!,
    fps: 30,
    resolution: "1080p",
    format: "Source",
    sourceDuration: SOURCE_DURATION,
    moments: result.moments,
    effects: { ...project.effectsSettings, outputCanvas: result.outputCanvas },
    sourceCrop: null,
    applyWatermark: false,
  });
  assert.equal(recipe.outputDuration, out, "the export renders exactly what was previewed");
  assert.ok(recipe.canvasH > recipe.canvasW, "as a portrait video");

  // ── 9. AND THE USER CAN STILL EDIT EVERY PIECE OF IT. ───────────────────
  for (const m of created) {
    assert.equal(m.source, "ai-director");
    assert.ok(m.director?.operationId, "traceable back to the plan operation");
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

const SECTION_ORDER = ["hook", "context", "demo", "result", "cta"];
function sectionSort(a: string, b: string): number {
  return SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(b);
}

/** A minimal edit operation for the validator tests. */
function op(
  id: string,
  editType: string,
  startTime: number,
  endTime: number,
  params?: Record<string, unknown>
) {
  return {
    id,
    editType,
    startTime,
    endTime,
    reason: "test",
    confidence: 0.8,
    priority: 0.5,
    evidence: [{ kind: "heuristic" as const, detail: "test" }],
    ...(params ? { params } : {}),
  } as never;
}

function assertNoUndefined(value: unknown, path = "$"): void {
  if (value === undefined) assert.fail(`undefined at ${path}`);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertNoUndefined(v, `${path}.${k}`);
  }
}
