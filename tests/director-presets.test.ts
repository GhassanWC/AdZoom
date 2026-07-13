/**
 * The Director chooses its DESIGNS from Framevo's real preset library.
 *
 * The property under test throughout: a design that reaches the timeline is
 * always a registry entry. The AI may NAME one (validated), or name nothing (the
 * deterministic scorer picks) — but it can never invent one, and a name it gets
 * wrong is REPORTED rather than quietly swapped for a lookalike.
 *
 * Pure modules only: no Gemini, no Firebase, no API key. `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDirectorContext } from "../src/lib/director/context-builder.ts";
import { buildHeuristicPlan } from "../src/lib/director/planner.ts";
import { runDirectorPipeline } from "../src/lib/director/pipeline.ts";
import { applyRevision, parseRevisionCommand } from "../src/lib/director/revision.ts";
import { parseDirectorRequest } from "../src/lib/director/request.ts";
// NOTE: imported from `types` (pure), NOT from `analysis-stage` — the stage pulls
// in the Gemini planner (`server-only`), and this suite must stay runnable under
// `node --test` with no API key and no Next.js runtime.
import { hasDirectorBrief, shouldRunDirectorStage } from "../src/lib/director/types.ts";
import type { DirectorPlan, DirectorRequest } from "../src/lib/director/types.ts";

import {
  CATEGORY_SLOT,
  KIT_SLOT_CATEGORY,
  presetCatalogueForModel,
  resolveDirectorPreset,
  selectPresetKit,
  textOverlayCategory,
} from "../src/lib/presets/director.ts";
import { PRESETS, PRESET_IDS, getPreset } from "../src/lib/presets/registry.ts";
import { PRESET_CATEGORIES } from "../src/lib/presets/types.ts";

import { buildRenderRecipe } from "../src/lib/render/recipe.ts";
import { materializeProject } from "../src/lib/firebase/materialize-project.ts";
import type { DetectedMoment, EffectsSettings } from "../src/lib/firebase/schema.ts";

import { demoProject, SOURCE_DURATION } from "./director-fixtures.ts";

const NOW = 1_700_000_000_000;

const TIKTOK: DirectorRequest = parseDirectorRequest(
  "Turn this into a fast 45-second product demo for TikTok. Energetic captions, finish with a CTA.",
  {}
);

function planFor(request = TIKTOK, project = demoProject()): DirectorPlan {
  return buildHeuristicPlan(buildDirectorContext(project), request, NOW);
}

function run(plan: DirectorPlan, project = demoProject()) {
  return runDirectorPipeline({
    plan,
    moments: project.analysis!.detectedMoments,
    duration: project.duration!,
    revision: 0,
    transcript: project.analysis?.transcript,
    videoType: project.selectedVideoType,
    sourceWidth: project.width,
    sourceHeight: project.height,
    effects: project.effectsSettings,
  });
}

/** Every Director-made moment that wears a design. */
function dressed(moments: { source?: string; preset?: { id: string } }[]) {
  return moments.filter((m) => m.source === "ai-director" && m.preset?.id);
}

/**
 * The designed edits the user ACTUALLY GOT — i.e. excluding any the review turned
 * off. This is the population the summary is allowed to claim; see the recount in
 * pipeline.ts ("a zoom the review disabled is not a zoom the user got").
 */
function dressedAndLive(
  moments: { source?: string; enabled?: boolean; preset?: { id: string } }[]
) {
  return dressed(moments).filter((m) => (m as { enabled?: boolean }).enabled !== false);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. The library is fully reachable — no category is a dead letter
// ════════════════════════════════════════════════════════════════════════════

test("presets: every registry category has a kit slot the Director can fill", () => {
  for (const category of PRESET_CATEGORIES) {
    assert.ok(
      CATEGORY_SLOT[category],
      `category "${category}" has no kit slot — the Director could never choose it`
    );
    // …and the mapping round-trips.
    assert.equal(KIT_SLOT_CATEGORY[CATEGORY_SLOT[category]], category);
  }
});

test("presets: the kit fills every slot the plan asks for, across all 9 categories", () => {
  const kit = selectPresetKit({
    tone: "energetic",
    platform: "tiktok",
    aspect: "9:16",
    wantCaptions: true,
    wantHook: true,
    wantCta: true,
    wantTransitions: true,
    wantTitle: true,
    wantCallout: true,
    wantIntro: true,
    wantOutro: true,
    wantTextAnimation: true,
  });

  for (const slot of Object.keys(KIT_SLOT_CATEGORY) as (keyof typeof KIT_SLOT_CATEGORY)[]) {
    const preset = kit[slot];
    assert.ok(preset, `slot "${slot}" was not filled`);
    // The chosen preset really is from that slot's category, and really exists.
    assert.equal(preset.category, KIT_SLOT_CATEGORY[slot]);
    assert.ok(getPreset(preset.id), `"${preset.id}" is not in the registry`);
  }
});

test("presets: a slot the plan did NOT ask for stays empty", () => {
  const kit = selectPresetKit({
    wantCaptions: true,
    wantHook: false,
    wantCta: false,
    wantTransitions: false,
  });
  assert.ok(kit.captions);
  assert.equal(kit.hook, undefined);
  assert.equal(kit.cta, undefined);
  assert.equal(kit.intro, undefined);
  assert.equal(kit.outro, undefined);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. text-overlay resolves to the right DESIGN JOB by story position
// ════════════════════════════════════════════════════════════════════════════

test("presets: a text overlay in the hook is an INTRO design; in the CTA, an OUTRO", () => {
  assert.equal(textOverlayCategory({ sectionKind: "hook", durationSeconds: 4 }), "intros");
  assert.equal(textOverlayCategory({ sectionKind: "cta", durationSeconds: 4 }), "outros");
  // A long overlay in the body is a title…
  assert.equal(textOverlayCategory({ sectionKind: "demo", durationSeconds: 4 }), "titles");
  // …and a short one is an emphasis beat.
  assert.equal(
    textOverlayCategory({ sectionKind: "demo", durationSeconds: 1.5 }),
    "text-animations"
  );
  // No section at all still resolves to a real category, never undefined.
  assert.equal(textOverlayCategory({ durationSeconds: 5 }), "titles");
});

// ════════════════════════════════════════════════════════════════════════════
// 3. THE GATE — a named id is honoured, a hallucinated one is reported
// ════════════════════════════════════════════════════════════════════════════

test("presets: the model can only name ids that exist — the catalogue is the registry", () => {
  const catalogue = presetCatalogueForModel();
  for (const p of PRESETS) {
    assert.ok(
      catalogue.includes(p.id),
      `"${p.id}" is in the registry but absent from the model's catalogue`
    );
  }
  // Nothing in the catalogue that isn't a real id.
  for (const line of catalogue.split("\n")) {
    const m = line.match(/^ {2}- (\S+) ·/);
    if (m) assert.ok(PRESET_IDS.includes(m[1]), `catalogue lists unknown id "${m[1]}"`);
  }
});

test("presets: a preset id the plan NAMED is the one that lands on the timeline", () => {
  const plan = planFor();
  const hook = plan.editOperations.find((o) => o.editType === "hook-text");
  assert.ok(hook, "fixture should plan a hook");

  // Ask for a specific, real hook design that is NOT the one the scorer would pick
  // for an energetic TikTok brief.
  hook.params = { ...hook.params, presetId: "hook-shake-alert" };

  const result = run(plan);
  const hookMoment = result.moments.find(
    (m) => m.source === "ai-director" && m.effectType === "hook-text"
  );
  assert.ok(hookMoment);
  assert.equal(hookMoment.preset?.id, "hook-shake-alert");

  const choice = result.summary.presets?.find((p) => p.slot === "hook");
  assert.equal(choice?.presetId, "hook-shake-alert");
  assert.equal(choice?.chosenBy, "plan", "a named preset must be attributed to the plan");
  assert.equal(result.failures.filter((f) => f.reason === "unknown_preset").length, 0);
});

test("presets: a HALLUCINATED preset id is reported, never coerced — and the edit still lands", () => {
  const plan = planFor();
  const hook = plan.editOperations.find((o) => o.editType === "hook-text");
  assert.ok(hook);
  hook.params = { ...hook.params, presetId: "hook-neon-explosion-3000" };

  const result = run(plan);

  // Reported, by name, with a reason a user can read.
  const failure = result.failures.find((f) => f.reason === "unknown_preset");
  assert.ok(failure, "an unknown preset id must produce a reported failure");
  assert.match(failure.detail, /hook-neon-explosion-3000/);

  // The edit is NOT dropped, and NOT left undesigned — it wears a REAL preset the
  // scorer chose. Silently applying nothing would be as bad as inventing a look.
  const hookMoment = result.moments.find(
    (m) => m.source === "ai-director" && m.effectType === "hook-text"
  );
  assert.ok(hookMoment, "the edit itself must survive a bad design request");
  assert.ok(hookMoment.preset?.id, "it must still wear a design");
  assert.ok(
    getPreset(hookMoment.preset.id),
    "and that design must be a real registry entry"
  );
  assert.notEqual(hookMoment.preset.id, "hook-neon-explosion-3000");

  const choice = result.summary.presets?.find((p) => p.slot === "hook");
  assert.equal(choice?.chosenBy, "scorer", "the fallback must be attributed to the scorer");
});

test("presets: a real id in the WRONG category is refused (a title is not a caption)", () => {
  const wrong = resolveDirectorPreset("title-glitch", "captions");
  assert.equal(wrong.preset, null);
  assert.equal(wrong.rejection, "wrong_category");

  const right = resolveDirectorPreset("title-glitch", "titles");
  assert.equal(right.preset?.id, "title-glitch");
});

// ════════════════════════════════════════════════════════════════════════════
// 4. EVERY design on the timeline is a real one — the invariant, end to end
// ════════════════════════════════════════════════════════════════════════════

test("presets: every design the Director applies is a validated registry entry", () => {
  const result = run(planFor());
  const styled = dressed(result.moments);
  assert.ok(styled.length > 0, "the run should dress at least one edit");

  for (const m of styled) {
    assert.ok(
      getPreset(m.preset!.id),
      `moment wears "${m.preset!.id}", which is not in the registry`
    );
  }
});

test("presets: the summary names the designs, and claims only the edits the user GOT", () => {
  const result = run(planFor());
  const choices = result.summary.presets ?? [];
  assert.ok(choices.length > 0, "the summary must report the designs it applied");

  // The claimed counts are recounted from the FINAL timeline and exclude anything
  // the review disabled — the summary must never overstate what landed.
  const live = dressedAndLive(result.moments);
  for (const c of choices) {
    assert.ok(getPreset(c.presetId));
    assert.ok(c.momentCount > 0, "a design with no surviving edits must not be claimed");
    const actual = live.filter((m) => m.preset!.id === c.presetId).length;
    assert.equal(
      c.momentCount,
      actual,
      `claimed ${c.momentCount} × ${c.presetId}, but ${actual} are live on the timeline`
    );
  }

  // And the human-readable line mentions them.
  assert.ok(
    result.summary.lines.some((l) => /Styled with/i.test(l)),
    "the summary should say which designs were used"
  );
});

test("presets: a design the review disabled is NOT claimed in the summary", () => {
  const result = run(planFor());

  // The fixture's caption run is long enough that the review disables at least one
  // (safe-area / density). If it ever stops doing so this test is vacuous, so
  // assert the precondition rather than silently passing.
  const all = dressed(result.moments);
  const live = dressedAndLive(result.moments);
  const disabled = all.length - live.length;
  assert.ok(disabled > 0, "precondition: the review should have disabled at least one edit");

  const claimed = (result.summary.presets ?? []).reduce((n, p) => n + p.momentCount, 0);
  assert.equal(
    claimed,
    live.length,
    "the summary claimed edits the review had turned off"
  );
});

test("presets: selection is DETERMINISTIC — the same brief picks the same designs twice", () => {
  const a = run(planFor());
  const b = run(planFor());
  assert.deepEqual(
    (a.summary.presets ?? []).map((p) => `${p.slot}:${p.presetId}`),
    (b.summary.presets ?? []).map((p) => `${p.slot}:${p.presetId}`)
  );
});

test("presets: the brief's STYLE actually changes the designs chosen", () => {
  const energetic = run(
    planFor(parseDirectorRequest("Punchy TikTok promo with captions and a CTA", {}))
  );
  const calm = run(
    planFor(
      parseDirectorRequest("A calm, minimal LinkedIn walkthrough with captions and a CTA", {
        style: "minimal",
        platform: "linkedin",
      })
    )
  );

  const idsOf = (r: typeof energetic) =>
    (r.summary.presets ?? []).map((p) => p.presetId).join(",");
  assert.notEqual(
    idsOf(energetic),
    idsOf(calm),
    "an energetic TikTok brief and a minimal LinkedIn brief must not resolve to the same look"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Presets compile to ORDINARY, EDITABLE moments — not a private format
// ════════════════════════════════════════════════════════════════════════════

test("presets: a directed, designed edit is an ordinary editable moment", () => {
  const result = run(planFor());
  const m = dressed(result.moments)[0] as Record<string, unknown>;
  assert.ok(m);

  // It lives on the ordinary timeline, with the ordinary fields every tool reads.
  assert.equal(typeof m.id, "string");
  assert.equal(typeof m.startTime, "number");
  assert.equal(typeof m.endTime, "number");
  assert.ok((m.endTime as number) > (m.startTime as number));
  assert.ok(m.effectType, "it must be a real Framevo effect type");
  assert.ok(m.textStyle ?? m.transition, "the design must be baked onto the moment");
  // Which means the preview and all three export paths read it with no new code.
  assert.ok((m.startTime as number) >= 0 && (m.endTime as number) <= SOURCE_DURATION);
});

// ════════════════════════════════════════════════════════════════════════════
// 6. No brief ⇒ plain analysis is untouched
// ════════════════════════════════════════════════════════════════════════════

test("stage: analysis runs the Director only when the user actually wrote a brief", () => {
  assert.equal(shouldRunDirectorStage(undefined, undefined), false);
  assert.equal(shouldRunDirectorStage(undefined, true), false);
  // An empty/whitespace prompt is not a brief.
  assert.equal(
    shouldRunDirectorStage({ prompt: "   ", form: {}, updatedAt: NOW }, true),
    false
  );

  const brief = { prompt: "Make it a 30s TikTok", form: {}, updatedAt: NOW };
  // Opt-OUT: a saved brief applies by default…
  assert.equal(shouldRunDirectorStage(brief, undefined), true);
  assert.equal(shouldRunDirectorStage(brief, true), true);
  // …unless this run explicitly suppressed it.
  assert.equal(shouldRunDirectorStage(brief, false), false);
});

test("stage: hasDirectorBrief is the single definition of 'the user asked for something'", () => {
  assert.equal(hasDirectorBrief(undefined), false);
  assert.equal(hasDirectorBrief({ prompt: "", form: {}, updatedAt: NOW }), false);
  assert.equal(hasDirectorBrief({ prompt: "\n\t ", form: {}, updatedAt: NOW }), false);
  assert.equal(hasDirectorBrief({ prompt: "go", form: {}, updatedAt: NOW }), true);
});

// ════════════════════════════════════════════════════════════════════════════
// 6b. A revision that restyles the captions must not be overruled by a stale pin
//
// A pinned preset BEATS the scorer and bakes its own typography over the plan's.
// So if "make the captions minimal" changed the tone but left the previously
// pinned energetic caption design in place, the user would be told the captions
// were restyled and still get the old look. Regression test for exactly that.
// ════════════════════════════════════════════════════════════════════════════

test("presets: 'make the captions minimal' drops a pinned energetic caption design", () => {
  const project = demoProject();
  const plan = planFor();

  // The first run pinned an energetic caption look.
  plan.captionInstructions = {
    ...plan.captionInstructions,
    enabled: true,
    presetId: "caption-bold-pop",
  };
  const before = run(plan, project);
  assert.equal(
    before.summary.presets?.find((p) => p.slot === "captions")?.presetId,
    "caption-bold-pop"
  );

  // Now the user asks for something calmer.
  const intents = parseRevisionCommand("make the captions minimal");
  const revised = applyRevision(plan, intents.intents, buildDirectorContext(project), 1);

  assert.equal(
    revised.plan.captionInstructions.presetId,
    undefined,
    "the stale pin survived the revision and will override the new style"
  );

  const after = run(revised.plan, project);
  const caption = after.summary.presets?.find((p) => p.slot === "captions");
  assert.ok(caption);
  assert.notEqual(
    caption.presetId,
    "caption-bold-pop",
    "the captions were restyled but kept the old energetic design"
  );
  assert.equal(caption.chosenBy, "scorer");
  assert.ok(getPreset(caption.presetId), "and the replacement is still a real design");
});

// ════════════════════════════════════════════════════════════════════════════
// 7. SAVE — the brief survives the round trip through Firestore
//
// `materializeProject` is a WHITELIST: a persisted field it doesn't list reads
// back `undefined` forever, and the write still LOOKS fine in the console. That
// silent, one-way failure has already cost this codebase seven fields once, and
// a dropped brief here would mean analysis quietly ignoring the user's
// instructions with no error anywhere.
// ════════════════════════════════════════════════════════════════════════════

test("save: the Director brief round-trips through materializeProject", () => {
  const brief = {
    prompt: "Punchy 45s TikTok demo, energetic captions, end on a CTA",
    form: {
      goal: "product-demo" as const,
      platform: "tiktok" as const,
      aspectRatio: "9:16" as const,
      style: "energetic" as const,
      captionStyle: "bold_social" as const,
      cta: "always" as const,
      ctaText: "Try it free",
      targetDurationSeconds: 45,
    },
    updatedAt: NOW,
  };

  const read = materializeProject("proj-1", {
    userId: "u1",
    duration: SOURCE_DURATION,
    directorBrief: brief,
  });

  assert.deepEqual(
    read.directorBrief,
    brief,
    "the brief was dropped on read — add it to materializeProject"
  );
  // And every field the analysis stage reads is intact, not just the prompt.
  assert.equal(read.directorBrief!.form.captionStyle, "bold_social");
  assert.equal(read.directorBrief!.form.ctaText, "Try it free");
  assert.equal(read.directorBrief!.form.targetDurationSeconds, 45);
});

test("save: a project with no brief reads back cleanly (plain analysis is unaffected)", () => {
  const read = materializeProject("proj-2", { userId: "u1", duration: SOURCE_DURATION });
  assert.equal(read.directorBrief, undefined);
  assert.equal(shouldRunDirectorStage(read.directorBrief, undefined), false);
});

// ════════════════════════════════════════════════════════════════════════════
// 8. EXPORT — the chosen design reaches the render recipe unchanged
//
// The preview and all three export paths read `detectedMoments`. A directed,
// preset-dressed moment must serialize like any other, or the video the user
// approved in the editor is not the video that renders.
// ════════════════════════════════════════════════════════════════════════════

test("export: a Director-chosen design is carried into the render recipe verbatim", () => {
  const project = demoProject();
  const result = run(planFor(), project);

  const styled = dressedAndLive(result.moments);
  assert.ok(styled.length > 0);

  const recipe = buildRenderRecipe({
    sourceWidth: project.width!,
    sourceHeight: project.height!,
    fps: 30,
    resolution: "1080p",
    format: "Source",
    sourceDuration: project.duration!,
    moments: result.moments as DetectedMoment[],
    effects: (result.outputCanvas
      ? { ...project.effectsSettings, outputCanvas: result.outputCanvas }
      : project.effectsSettings) as EffectsSettings,
    sourceCrop: null,
    applyWatermark: false,
  });

  // The recipe is REAL — a garbage input would produce undefined dims and make
  // the id check below pass vacuously.
  assert.ok(recipe.canvasW > 0 && recipe.canvasH > 0);

  const serialized = JSON.stringify(recipe);
  for (const m of styled) {
    // The design travels WITH the edit — the renderer never re-derives it.
    assert.ok(
      serialized.includes(m.preset!.id),
      `"${m.preset!.id}" was chosen by the Director but is absent from the render recipe`
    );
  }
});
