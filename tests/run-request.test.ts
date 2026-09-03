/**
 * THE canonical run-request builder (Framevo AI unification, 2A).
 *
 * Pins the two fixes this module exists for:
 *   1. ENTRY-POINT CONVERGENCE — same project + same setup + same instruction
 *      ⇒ same run request, whether the (transitional) dialog or the Framevo AI
 *      composer asked. The old chat path ran DEFAULT_ANALYSIS_OPTIONS.
 *   2. NATURAL LANGUAGE IS A DELTA — an instruction preserves structured setup
 *      and touches a field only when confidently explicit. The old chat path
 *      saved `saveDirectorBrief(command, {})`, wiping the form.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAnalysisRunRequest,
  mergeInstructionIntoBrief,
  type RunRequestProjectSlice,
} from "@/lib/analysis/run-request";
import { DEFAULT_ANALYSIS_OPTIONS } from "@/lib/analysis/engine-layers";
import type { DirectorBrief } from "@/lib/director/types";

const NOW = 1_770_000_000_000;

/** A project whose user has real, non-default preferences everywhere. */
function opinionatedProject(): RunRequestProjectSlice {
  return {
    selectedVideoType: "talking-head",
    editingTemplateId: "talking-clean-pro",
    directorBrief: {
      prompt: "Clean this up for the team",
      form: {
        platform: "youtube",
        aspectRatio: "16:9",
        captionStyle: "clean",
        cta: "auto",
      },
      updatedAt: NOW - 1000,
    },
    analysis: {
      lastRunOptions: {
        generateCameraEdits: true,
        generateCut: true,
        generateSpeed: false, // the user turned speed off last run
        generateTransitions: false, // and transitions
        existingEditMode: "replace-selected",
        chunkMode: "detailed",
        chunkSizeSeconds: 15,
      },
    },
  };
}

const WORKSPACE = {
  analysisEngines: { generateCameraEdits: true, generateCut: false, generateSpeed: true },
  analysisDetail: { chunkMode: "detailed" as const, chunkSizeSeconds: 15 },
};

/* ── 1. Entry-point convergence ──────────────────────────────────────────── */

test("chat and dialog entry points build the SAME request for the same setup", () => {
  const project = opinionatedProject();

  // The Framevo AI composer path: no explicit overrides, just an instruction.
  const chat = buildAnalysisRunRequest({
    project,
    workspace: WORKSPACE,
    instruction: "Focus more on the authentication section.",
    planOnly: false,
    now: NOW,
  });

  // The (transitional) dialog path: its seeded state rides in as overrides —
  // which for an untouched dialog is exactly the same resolution.
  const dialog = buildAnalysisRunRequest({
    project,
    workspace: WORKSPACE,
    overrides: {
      generateCameraEdits: true,
      generateCut: true,
      generateSpeed: false,
      generateTransitions: false,
      chunkMode: "detailed",
      chunkSizeSeconds: 15,
      existingEditMode: "replace-selected",
      selectedVideoType: "talking-head",
    },
    instruction: "Focus more on the authentication section.",
    planOnly: false,
    now: NOW,
  });

  assert.deepEqual(chat.options, dialog.options, "the two entry points must converge");
  assert.deepEqual(chat.brief, dialog.brief);
});

test("the chat path respects persisted preferences — NOT the shipped defaults", () => {
  const req = buildAnalysisRunRequest({
    project: opinionatedProject(),
    workspace: WORKSPACE,
    instruction: "Tighten the whole thing up",
    now: NOW,
  });
  // Last run wins for engines the user touched…
  assert.equal(req.options.generateSpeed, false, "last-run speed=off survives");
  assert.equal(req.options.generateTransitions, false, "last-run transitions=off survives");
  // …and chunk detail survives too.
  assert.equal(req.options.chunkMode, "detailed");
  assert.equal(req.options.chunkSizeSeconds, 15);
  // The template governing the project rides along.
  assert.equal(req.options.templateId, "talking-clean-pro");
  // And this is demonstrably NOT the old DEFAULT_ANALYSIS_OPTIONS behaviour.
  assert.notEqual(req.options.generateSpeed, DEFAULT_ANALYSIS_OPTIONS.generateSpeed);
});

test("no last run: core prefs fill in, then recipe defaults; overrides win over all", () => {
  const project: RunRequestProjectSlice = { selectedVideoType: "talking-head" };
  const fromPrefs = buildAnalysisRunRequest({ project, workspace: WORKSPACE, now: NOW });
  assert.equal(fromPrefs.options.generateCut, false, "per-user pref generateCut=false");

  const overridden = buildAnalysisRunRequest({
    project,
    workspace: WORKSPACE,
    overrides: { generateCut: true },
    now: NOW,
  });
  assert.equal(overridden.options.generateCut, true, "explicit override outranks prefs");
});

test("the caption separation rule is structural: no builder output can request ASR", () => {
  const req = buildAnalysisRunRequest({
    project: opinionatedProject(),
    workspace: WORKSPACE,
    overrides: { generateCaptions: true }, // even an explicit attempt
    now: NOW,
  });
  assert.ok(!("generateCaptions" in req.options), "generateCaptions is always stripped");
});

test("coreEnginesOff surfaces the dialog's historical guard for every entry point", () => {
  const req = buildAnalysisRunRequest({
    project: { selectedVideoType: "auto" },
    workspace: {
      analysisEngines: {
        generateCameraEdits: false,
        generateCut: false,
        generateSpeed: false,
      },
    },
    now: NOW,
  });
  assert.equal(req.coreEnginesOff, true);
});

test("plan mode rides the request; options carry no undefined values", () => {
  const req = buildAnalysisRunRequest({
    project: { selectedVideoType: "auto" }, // no template, no brief
    workspace: null,
    planOnly: true,
    now: NOW,
  });
  assert.equal(req.options.directorPlanOnly, true);
  assert.equal(req.options.applyDirectorBrief, false, "no brief ⇒ nothing to apply");
  for (const [k, v] of Object.entries(req.options)) {
    assert.notEqual(v, undefined, `options.${k} must never be undefined (Firestore)`);
  }
  assert.ok(!("templateId" in req.options), "absent template is omitted, not undefined");
});

/* ── 2. Natural language is a DELTA ──────────────────────────────────────── */

const brief = (): DirectorBrief => ({
  prompt: "Clean this up for the team",
  form: {
    platform: "youtube",
    aspectRatio: "16:9",
    captionStyle: "clean",
    cta: "auto",
    targetDurationSeconds: 120,
  },
  updatedAt: NOW - 1000,
});

test('"Focus more on authentication" changes the prompt and NOTHING structured', () => {
  const merged = mergeInstructionIntoBrief(
    brief(),
    "Focus more on the authentication section.",
    undefined,
    NOW
  );
  assert.equal(merged.prompt, "Focus more on the authentication section.");
  assert.deepEqual(merged.form, brief().form, "every structured field survives");
});

test('"Make it about 60 seconds" changes duration — and only duration', () => {
  const merged = mergeInstructionIntoBrief(brief(), "Make it about 60 seconds", undefined, NOW);
  assert.equal(merged.form.targetDurationSeconds, 60);
  const { targetDurationSeconds: _a, ...restMerged } = merged.form;
  const { targetDurationSeconds: _b, ...restOriginal } = brief().form;
  assert.deepEqual(restMerged, restOriginal);
});

test('"Make this vertical for TikTok" changes aspect + platform, preserves the rest', () => {
  const merged = mergeInstructionIntoBrief(brief(), "Make this vertical for TikTok", undefined, NOW);
  assert.equal(merged.form.aspectRatio, "9:16");
  assert.equal(merged.form.platform, "tiktok");
  assert.equal(merged.form.captionStyle, "clean", "captions untouched");
  assert.equal(merged.form.targetDurationSeconds, 120, "duration untouched");
});

test("\"Don't add captions\" changes captions only", () => {
  const merged = mergeInstructionIntoBrief(brief(), "Don't add captions", undefined, NOW);
  assert.equal(merged.form.captionStyle, "none");
  assert.equal(merged.form.platform, "youtube");
  assert.equal(merged.form.aspectRatio, "16:9");
});

test("explicit setup-control changes apply even when the instruction says nothing", () => {
  const merged = mergeInstructionIntoBrief(
    brief(),
    "Punch up the intro",
    { platform: "linkedin" },
    NOW
  );
  assert.equal(merged.form.platform, "linkedin", "control change lands");
  assert.equal(merged.form.aspectRatio, "16:9", "everything else survives");
});

test("an instruction's confident extraction outranks a stale saved value, not a control change", () => {
  // Control says linkedin; message says TikTok — the message is this run's ask.
  const merged = mergeInstructionIntoBrief(
    brief(),
    "Actually make it for TikTok",
    { platform: "linkedin" },
    NOW
  );
  assert.equal(merged.form.platform, "tiktok");
});

test("builder round-trip: an instruction produces a brief that PRESERVES setup", () => {
  const project = opinionatedProject();
  const req = buildAnalysisRunRequest({
    project,
    workspace: WORKSPACE,
    instruction: "Focus more on the authentication section.",
    now: NOW,
  });
  assert.equal(req.briefChanged, true);
  assert.equal(req.brief?.prompt, "Focus more on the authentication section.");
  assert.deepEqual(req.brief?.form, project.directorBrief?.form, "no wipe — the 2A fix");
  assert.equal(req.options.applyDirectorBrief, true);
});

test("no instruction and no control change: the saved brief runs untouched", () => {
  const project = opinionatedProject();
  const req = buildAnalysisRunRequest({ project, workspace: WORKSPACE, now: NOW });
  assert.equal(req.briefChanged, false);
  assert.deepEqual(req.brief, project.directorBrief);
});
