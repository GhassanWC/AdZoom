/**
 * Framevo AI — panel state, completion narration, template offering, and the
 * Editorial-Engine integration that keeps the conversation from bypassing the
 * policy (approved rules 4, 5, 10, 13).
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveStage,
  outputRowLabel,
  templateChips,
  templateChoicesForProject,
  videoRowLabel,
} from "@/lib/framevo-ai/state";
import {
  buildCompletionNarration,
  omissionSentence,
} from "@/lib/framevo-ai/narration";
import { activeStepIndex, progressFraction } from "@/lib/framevo-ai/progress";
import {
  EDITING_TEMPLATES,
  TALKING_CLEAN_PRO,
  templatesForProfile,
} from "@/lib/editorial/templates";
import { contextFromSelectedVideoType } from "@/lib/editorial/context";
import { resolveEditorialPolicy, resolveProjectPolicy } from "@/lib/editorial/resolve";
import { applyEditorialJudgment } from "@/lib/director/editorial-judgment";
import { runDirectorPipeline } from "@/lib/director/pipeline";
import type { DetectedMoment, ProjectDoc } from "@/lib/firebase/schema";
import type { DirectorPlan } from "@/lib/director/types";
import type { RecipeSignals } from "@/lib/analysis/edit-recipe";

/* ── One panel, three states ─────────────────────────────────────────────── */

test("stage derivation: setup → working → conversation", () => {
  assert.equal(
    deriveStage({ hasMoments: false, analyzing: false, projectStatus: "uploaded" }),
    "setup"
  );
  assert.equal(
    deriveStage({ hasMoments: false, analyzing: true, projectStatus: "analyzing" }),
    "working"
  );
  // Processing status alone (analyzing flag lost on reload) still shows working.
  assert.equal(
    deriveStage({ hasMoments: true, analyzing: false, projectStatus: "generating_timeline" }),
    "working"
  );
  assert.equal(
    deriveStage({ hasMoments: true, analyzing: false, projectStatus: "analyzed" }),
    "conversation"
  );
  // "Change setup" re-opens setup over an existing edit.
  assert.equal(
    deriveStage({
      hasMoments: true,
      analyzing: false,
      projectStatus: "analyzed",
      setupRequested: true,
    }),
    "setup"
  );
});

test("setup rows read as outcomes, not configuration", () => {
  assert.equal(videoRowLabel({ selectedVideoType: "tutorial" }).label, "Tutorial / Educational");
  assert.equal(videoRowLabel({ selectedVideoType: undefined }).label, "Auto detect");
  assert.equal(
    outputRowLabel({
      prompt: "",
      form: { platform: "youtube", aspectRatio: "16:9" },
      updatedAt: 0,
    }),
    "YouTube · 16:9 · Keep original length"
  );
  assert.equal(
    outputRowLabel({
      prompt: "",
      form: { platform: "tiktok", aspectRatio: "9:16", targetDurationSeconds: 60 },
      updatedAt: 0,
    }),
    "TikTok · 9:16 · About 1:00"
  );
});

/* ── Template offering follows the profile ───────────────────────────────── */

test("a talking head is offered talking styles; a screen recording screen styles", () => {
  const talking = templatesForProfile(contextFromSelectedVideoType("talking-head"));
  assert.ok(talking.some((t) => t.id === "talking-clean-pro"));
  assert.ok(talking.some((t) => t.id === "talking-high-energy"));
  assert.ok(!talking.some((t) => t.id === "screen-pro-demo"), "no screen styles on camera footage");

  const screen = templatesForProfile(contextFromSelectedVideoType("screen-recording"));
  assert.ok(screen.some((t) => t.id === "screen-pro-demo"));
  assert.ok(!screen.some((t) => t.id === "talking-clean-pro"));

  // Unknown axes are permissive — auto sees every style.
  const auto = templatesForProfile(contextFromSelectedVideoType("auto"));
  assert.ok(auto.length >= 8, `auto offers the full set (got ${auto.length})`);
});

test("the picker always ends with Classic, and chips come from real policy", () => {
  const choices = templateChoicesForProject({ selectedVideoType: "talking-head" });
  assert.equal(choices[choices.length - 1].name, "Classic");
  const chips = templateChips(TALKING_CLEAN_PRO);
  assert.ok(chips.includes("Captions"));
  assert.ok(chips.includes("Tight cuts"));
  // No planned category may ever appear on a card.
  for (const t of EDITING_TEMPLATES) {
    for (const chip of templateChips(t)) {
      assert.ok(!/music|b-?roll|freeze/i.test(chip), `${t.id} advertises "${chip}"`);
    }
  }
});

/* ── Completion narration uses REAL data (rule 10) ───────────────────────── */

function narrationProject(over: Partial<ProjectDoc["analysis"]> = {}): Pick<
  ProjectDoc,
  "analysis" | "duration" | "editingTemplateId"
> {
  const m = (
    id: string,
    startTime: number,
    endTime: number,
    effectType: DetectedMoment["effectType"],
    extra: Partial<DetectedMoment> = {}
  ): DetectedMoment =>
    ({
      id,
      startTime,
      endTime,
      label: "x",
      reason: "y",
      focusRegion: { x: 0, y: 0, width: 1, height: 1 },
      effectType,
      source: "ai",
      provenance: "cv",
      ...extra,
    }) as DetectedMoment;
  return {
    duration: 214, // 3:34
    editingTemplateId: "talking-clean-pro",
    analysis: {
      status: "complete",
      detectedMoments: [
        m("c1", 10, 25, "cut"),
        m("c2", 100, 128, "cut"),
        m("z1", 40, 43, "zoom"),
        m("z2", 60, 63, "zoom"),
        m("z3", 150, 153, "zoom"),
        m("cap1", 5, 8, "captions"),
        m("cap2", 30, 33, "captions"),
      ],
      boringSections: [],
      editorialPolicy: {
        templateId: "talking-clean-pro",
        templateVersion: 1,
        mode: "enforce",
        statuses: {
          transition: "disabled-by-default",
          callout: "disabled-by-default",
          speed: "disabled-by-default",
          zoom: "allowed",
        },
        reasons: {
          transition: "Clean Professional does not use this edit",
          callout: "Clean Professional does not use this edit",
          speed: "turned off in the analysis options", // the USER's choice
        },
      },
      ...over,
    } as ProjectDoc["analysis"],
  };
}

test("narration counts and durations come from the actual timeline", () => {
  const n = buildCompletionNarration(narrationProject())!;
  assert.ok(n, "narration exists for a complete analysis");
  assert.equal(n.durationLine, "3:34 → 2:51", "43s of cuts → the real before/after");
  assert.ok(n.lines.some((l) => /Added 3 zooms/.test(l)));
  assert.ok(n.lines.some((l) => /Added 2 caption lines/.test(l)));
  assert.ok(n.lines.some((l) => /Removed 43s/.test(l)));
});

test("omissions narrate ONLY the template's taste — never the user's toggle", () => {
  const n = buildCompletionNarration(narrationProject())!;
  const sentence = omissionSentence(n)!;
  assert.ok(sentence.includes("transitions"), "template-driven omission narrated");
  assert.ok(sentence.includes("callouts"));
  assert.ok(sentence.includes("Clean Professional"));
  assert.ok(!sentence.includes("speed"), "a user toggle is not the template's taste");
});

test("a Classic run narrates no omissions — Classic expresses no editorial taste", () => {
  const p = narrationProject();
  p.analysis!.editorialPolicy = {
    templateId: "classic-talking-head",
    templateVersion: 1,
    mode: "classic",
    statuses: { transition: "disabled-by-default" },
    reasons: { transition: "not part of the Talking Head recipe" },
  };
  const n = buildCompletionNarration(p)!;
  assert.equal(omissionSentence(n), null);
});

test("no narration before a complete analysis", () => {
  assert.equal(
    buildCompletionNarration({ duration: 100, analysis: undefined, editingTemplateId: undefined }),
    null
  );
});

/* ── Working-state math is shared, not duplicated ────────────────────────── */

test("progress fraction: CV-real beats estimate beats stage index", () => {
  assert.equal(
    progressFraction({ status: "scanning_frames", cvProgress: 0.5, elapsedMs: 0, estimateSeconds: 60 }),
    0.5
  );
  assert.equal(
    progressFraction({ status: "analyzing", cvProgress: null, elapsedMs: 30_000, estimateSeconds: 60 }),
    0.5
  );
  const steps = [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }];
  assert.equal(activeStepIndex(0, steps), 0);
  assert.equal(activeStepIndex(0.5, steps), 1);
  assert.equal(activeStepIndex(1, steps), 2);
});

/* ── The conversation controls the Editorial Engine, never bypasses it ───── */

const SIGNALS: RecipeSignals = {
  hasTranscript: true,
  hasAudioAnalysis: true,
  hasUsableSpeech: true,
  silenceSegmentCount: 3,
  hasSceneData: true,
  hasVisualMoments: true,
  hasInteractionData: false,
  isScreenRecording: false,
  durationSeconds: 120,
};

function planWith(ops: DirectorPlan["editOperations"]): DirectorPlan {
  return {
    planVersion: 1,
    goal: "clean-up",
    platform: "youtube",
    storyStructure: [],
    clipOperations: [],
    editOperations: ops,
    audioOperations: [],
    captionInstructions: { enabled: false, reason: "test" },
    reviewRules: [],
    explanation: "test plan",
    modelVersion: "heuristic-v1",
    createdAt: 0,
  } as unknown as DirectorPlan;
}

const op = (
  id: string,
  editType: DirectorPlan["editOperations"][number]["editType"],
  extra: Record<string, unknown> = {}
): DirectorPlan["editOperations"][number] =>
  ({
    id,
    startTime: 10,
    endTime: 13,
    reason: "A real editorial reason for the test",
    confidence: 0.8,
    priority: 0.7,
    evidence: [{ kind: "transcript", detail: "evidence", at: 10 }],
    editType,
    ...extra,
  }) as DirectorPlan["editOperations"][number];

test("judgment rejects plan ops the template forbids — reported, never executed", () => {
  const policy = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: SIGNALS,
  });
  const plan = planWith([
    op("keepable", "zoom"),
    op("forbidden-transition", "transition", { params: { transitionStyle: "fade" } }),
    op("forbidden-cursor", "click-highlight"),
  ]);
  const result = applyEditorialJudgment(plan, {
    statuses: policy.statuses,
    mode: policy.mode,
    templateName: "Clean Professional",
  });
  const surviving = result.plan.editOperations.map((o) => o.id);
  assert.deepEqual(surviving, ["keepable"]);
  const forbidden = result.failures.filter((f) => f.reason === "policy_forbidden");
  assert.equal(forbidden.length, 2);
  assert.ok(forbidden[0].detail.includes("Clean Professional"));
});

test("a Classic policy leaves Director judgment exactly as it was", () => {
  const classic = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: templateChoicesForProject({ selectedVideoType: "talking-head" }).at(-1)!,
    signals: SIGNALS,
  });
  const plan = planWith([op("t1", "transition", { params: { transitionStyle: "fade" } })]);
  const withPolicy = applyEditorialJudgment(plan, {
    statuses: classic.statuses,
    mode: classic.mode,
  });
  const without = applyEditorialJudgment(plan);
  assert.deepEqual(withPolicy, without, "classic mode is a no-op gate");
});

test("the pipeline threads the policy end to end", () => {
  const policy = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: SIGNALS,
  });
  const result = runDirectorPipeline({
    plan: planWith([op("forbidden", "click-highlight")]),
    moments: [],
    duration: 120,
    revision: 0,
    policy: { statuses: policy.statuses, mode: policy.mode, templateName: "Clean Professional" },
  });
  assert.equal(result.applied, false, "nothing forbidden ever lands");
  assert.ok(result.failures.some((f) => f.reason === "policy_forbidden"));
});

test("resolveProjectPolicy judges chat revisions under the project's template", () => {
  const policy = resolveProjectPolicy({
    selectedVideoType: "talking-head",
    editingTemplateId: "talking-clean-pro",
    contentProfile: undefined,
    directorBrief: null,
    analysis: undefined,
    visualAnalysis: undefined,
    interactionScope: undefined,
    duration: 120,
  });
  assert.equal(policy.mode, "enforce");
  assert.equal(policy.templateId, "talking-clean-pro");
});

/* ── Brief deltas shape the policy (2C) ──────────────────────────────────── */

test('"never add a CTA" turns branding off; "no captions" turns captions off', () => {
  const noCta = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("ad-promo"),
    template: EDITING_TEMPLATES.find((t) => t.id === "promo-punchy")!,
    signals: SIGNALS,
    brief: { prompt: "x", form: { cta: "never", captionStyle: "none" }, updatedAt: 0 },
  });
  assert.equal(noCta.statuses.branding, "disabled-by-default");
  assert.match(noCta.reasons.branding, /your instructions/);
  assert.equal(noCta.statuses.captions, "disabled-by-default");
});

test("brief deltas never resurrect a computed-impossible category", () => {
  const p = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: SIGNALS,
    brief: { prompt: "x", form: { cta: "always" }, updatedAt: 0 },
  });
  assert.equal(p.statuses.cursor_emphasis, "impossible", "matrix stays absolute");
  assert.ok(p.statuses.branding === "allowed" || p.statuses.branding === "core");
});
