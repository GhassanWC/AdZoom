/**
 * The editing command layer: clip derivation, the validating executor, the
 * local request parser and footage search — the parts every model and the
 * chat share. React-free; the context wiring is covered by the e2e proof.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { DetectedMoment, Transcript } from "../src/lib/firebase/schema.ts";
import { deriveClips, sourceAtOutput, outputAtSource } from "../src/lib/edit-commands/clips.ts";
import { applyEditCommands, requestIdPrefix, positionStyle } from "../src/lib/edit-commands/apply.ts";
import { parseEditRequest, parseAmount, clauses } from "../src/lib/edit-commands/parse.ts";
import { buildAssistantDigest, type AssistantInput } from "../src/lib/edit-commands/context.ts";
import { findIntroductions, findRepeatedTakes, findFootage } from "../src/lib/edit-commands/footage.ts";
import { buildTimelineMap } from "../src/lib/timeline/crop-speed.ts";
import { buildRenderRecipe } from "../src/lib/render/recipe.ts";
import { DEFAULT_EFFECTS_SETTINGS } from "../src/lib/firebase/schema.ts";

const SOURCE = 60;

function m(id: string, effectType: DetectedMoment["effectType"], start: number, end: number, over: Partial<DetectedMoment> = {}): DetectedMoment {
  return {
    id,
    startTime: start,
    endTime: end,
    label: id,
    reason: "test",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType,
    ...(effectType === "cut" ? { cut: { active: true } } : {}),
    ...(effectType === "speed-up" ? { speed: { multiplier: 2, audioMode: "mute", transition: "cut" } } : {}),
    ...over,
  } as DetectedMoment;
}

function words(text: string, start: number, perWord = 0.4) {
  return text.split(" ").map((w, i) => ({ word: w, startTime: start + i * perWord, endTime: start + i * perWord + perWord * 0.85 }));
}

/** An interview: intro at 2s, an answer at 10s repeated at 18s, more at 30s. */
function interviewTranscript(): Transcript {
  const segs = [
    { id: "s0", startTime: 2, endTime: 5.2, text: "Hi, I'm Sarah Chen, head of design at Lumen." },
    { id: "s1", startTime: 10, endTime: 15.6, text: "We rebuilt the onboarding flow because new users kept getting lost on the second screen." },
    { id: "s2", startTime: 18, endTime: 23.6, text: "We rebuilt the onboarding flow because new users kept getting lost on that second screen." },
    { id: "s3", startTime: 30, endTime: 33, text: "The result was a forty percent lift in activation." },
  ];
  return {
    status: "complete",
    language: "en",
    text: segs.map((s) => s.text).join(" "),
    segments: segs,
    words: segs.flatMap((s) => words(s.text, s.startTime, (s.endTime - s.startTime) / s.text.split(" ").length)),
  } as Transcript;
}

function input(over: Partial<AssistantInput> = {}): AssistantInput {
  return {
    project: { analysis: { transcript: interviewTranscript(), detectedMoments: [] } as never, duration: SOURCE },
    moments: [],
    layers: {},
    sourceDuration: SOURCE,
    playhead: 0,
    selection: {},
    recentElementIds: [],
    ...over,
  };
}

const state = (moments: DetectedMoment[], extra: Partial<Parameters<typeof applyEditCommands>[0]> = {}) => ({
  moments,
  sourceDuration: SOURCE,
  canvasWidth: 1920,
  canvasHeight: 1080,
  transcript: interviewTranscript(),
  ...extra,
});

/** Preview (timeline map) and export (render recipe) must agree after every edit. */
function assertParity(moments: DetectedMoment[]) {
  const map = buildTimelineMap(moments, SOURCE);
  const recipe = buildRenderRecipe({
    sourceWidth: 1920, sourceHeight: 1080, fps: 30, resolution: "1080p", format: "Source",
    sourceDuration: SOURCE, moments, effects: DEFAULT_EFFECTS_SETTINGS, sourceCrop: null, applyWatermark: false,
  } as never);
  assert.equal(recipe.timelineMap.outputDuration, map.outputDuration);
}

// ── Clips ───────────────────────────────────────────────────────────────────

test("clips: kept spans between cuts, named by their boundaries", () => {
  const clips = deriveClips([m("c1", "cut", 10, 20), m("c2", "cut", 40, 45)], SOURCE);
  assert.deepEqual(clips.map((c) => [c.id, c.sourceStart, c.sourceEnd]), [
    ["clip:in:c1", 0, 10],
    ["clip:c1:c2", 20, 40],
    ["clip:c2:out", 45, 60],
  ]);
  assert.deepEqual(clips.map((c) => [c.outputStart, c.outputEnd]), [[0, 10], [10, 30], [30, 45]]);
});

test("clips: a speed section does not split a clip; hidden/inactive cuts don't create one", () => {
  const clips = deriveClips([m("sp", "speed-up", 5, 15), m("off", "cut", 20, 30, { cut: { active: false } })], SOURCE);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].outputEnd, 55, "10s at 2x plays in 5s");
});

test("output <-> source mapping respects speed", () => {
  const map = buildTimelineMap([m("sp", "speed-up", 0, 10)], SOURCE);
  assert.equal(sourceAtOutput(map, 2), 4);
  assert.equal(outputAtSource(map, 4), 2);
});

// ── THE PROOF: "Trim the first two seconds" of the selected clip ────────────

test("proof: selected clip + 'Trim the first two seconds' → one cut, undo-able, idempotent", () => {
  const base = [m("c1", "cut", 10, 20)];
  const clips = deriveClips(base, SOURCE);
  const selected = clips[1]; // 20–60, left boundary is c1
  const parsed = parseEditRequest("Trim the first two seconds", input({ moments: base, selection: { clipId: selected.id } }));
  assert.equal(parsed.kind, "commands");
  assert.deepEqual((parsed as { commands: unknown[] }).commands, [{ op: "trim_clip", clipId: selected.id, edge: "start", seconds: 2 }]);

  const res = applyEditCommands(state(base), (parsed as { commands: never[] }).commands, "req-1");
  assert.ok(res.ok);
  // The boundary cut was EXTENDED (no new edit), so the clip keeps its id.
  assert.equal(res.moments.length, 1);
  assert.equal(res.moments[0].endTime, 22);
  assert.equal(res.clipRenames.length, 0);
  assert.equal(deriveClips(res.moments, SOURCE)[1].sourceStart, 22);
  assert.match(res.changes[0].summary, /Trimmed 2\.0s from the start of clip 2/);
  // The original array is untouched — the undo snapshot is just the old array.
  assert.equal(base[0].endTime, 20);
  assertParity(res.moments);

  // Re-running the same request on the same base yields identical output.
  const again = applyEditCommands(state(base), (parsed as { commands: never[] }).commands, "req-1");
  assert.deepEqual(again.ok && again.moments, res.moments);
});

test("trim the first clip: creates a boundary cut with a request-derived id and reports the rename", () => {
  const clips = deriveClips([], SOURCE);
  const res = applyEditCommands(state([]), [{ op: "trim_clip", clipId: clips[0].id, edge: "start", seconds: 2 }], "req-A");
  assert.ok(res.ok);
  assert.equal(res.moments[0].id, `${requestIdPrefix("req-A")}_1`);
  assert.deepEqual([res.moments[0].startTime, res.moments[0].endTime], [0, 2]);
  assert.deepEqual(res.clipRenames, [{ from: "clip:in:out", to: `clip:${res.moments[0].id}:out` }]);
});

test("trim uses VIEWER seconds inside a sped-up clip", () => {
  const base = [m("sp", "speed-up", 0, 10)];
  const clip = deriveClips(base, SOURCE)[0];
  const res = applyEditCommands(state(base), [{ op: "trim_clip", clipId: clip.id, edge: "start", seconds: 2 }], "r");
  assert.ok(res.ok);
  const cut = res.moments.find((x) => x.effectType === "cut")!;
  assert.equal(cut.endTime, 4, "2 viewer seconds at 2x = 4 source seconds");
});

test("executor is all-or-nothing and rejects stale references", () => {
  const res = applyEditCommands(state([]), [
    { op: "remove_range", start: 1, end: 2 },
    { op: "trim_clip", clipId: "clip:gone:out", edge: "start", seconds: 1 },
  ], "r");
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.errors[0].code, "not_found");
});

test("executor validation: too-long trims, slow-motion, out-of-range", () => {
  const clip = deriveClips([], SOURCE)[0];
  const bad = (c: never) => applyEditCommands(state([]), [c], "r");
  assert.equal((bad({ op: "trim_clip", clipId: clip.id, edge: "end", seconds: 59.9 } as never) as { errors: { code: string }[] }).errors[0].code, "too_short");
  assert.match((bad({ op: "set_speed", start: 0, end: 5, multiplier: 0.5 } as never) as { errors: { message: string }[] }).errors[0].message, /Slow motion/);
  assert.equal((bad({ op: "remove_range", start: 50, end: 70 } as never) as { errors: { code: string }[] }).errors[0].code, "out_of_range");
});

test("restore_range splits a cut in the middle and keeps both outer parts", () => {
  const res = applyEditCommands(state([m("c", "cut", 10, 30)]), [{ op: "restore_range", start: 15, end: 20 }], "r");
  assert.ok(res.ok);
  const cuts = res.moments.filter((x) => x.effectType === "cut").map((x) => [x.startTime, x.endTime]);
  assert.deepEqual(cuts, [[10, 15], [20, 30]]);
  assertParity(res.moments);
});

// ── Scenario: interview — remove the repeated answer, add captions ─────────

test("interview: repeated answer is found and the EARLIER take is removed on word boundaries", () => {
  const takes = findRepeatedTakes(interviewTranscript());
  assert.equal(takes.length, 1);
  assert.equal(takes[0].first.start, 10);
  assert.equal(takes[0].second.start, 18);

  const parsed = parseEditRequest("Remove the repeated answer and add captions", input());
  assert.equal(parsed.kind, "commands");
  const cmds = (parsed as { commands: { op: string; start?: number; end?: number }[] }).commands;
  assert.deepEqual(cmds.map((c) => c.op), ["remove_range", "add_captions"]);
  const cut = cmds[0];
  assert.ok(cut.start! >= 9.5 && cut.start! <= 10, `cut starts in the gap before the take (${cut.start})`);
  assert.ok(cut.end! <= 18, "the kept take's first word is never clipped");

  const res = applyEditCommands(state([]), cmds as never, "interview-1");
  assert.ok(res.ok);
  const captions = res.moments.filter((x) => x.effectType === "captions");
  assert.ok(captions.length >= 3);
  // Captions are SOURCE-anchored: the kept take's caption still starts at its words.
  const kept = captions.filter((c) => c.startTime >= 18 && c.startTime < 23.6);
  assert.ok(kept.length > 0, "the kept take is captioned");
  assert.ok(kept.every((c) => c.captions?.words?.every((w) => w.start >= 18)), "word timings unchanged by the cut");
  // A caption entirely inside the removed range never plays — check via the map.
  const map = buildTimelineMap(res.moments, SOURCE);
  assert.ok(map.totalRemoved > 7, `removed ${map.totalRemoved} via ${JSON.stringify(cmds[0])}`);
  assertParity(res.moments);
});

test("interview: 'keep the first take' removes the second instead", () => {
  const parsed = parseEditRequest("remove the repeated answer, keep the first take", input());
  const cmds = (parsed as { commands: { start: number }[] }).commands;
  assert.ok(cmds[0].start >= 17.5, "drops the later take");
});

test("captions without a transcript are refused honestly, never invented", () => {
  const res = applyEditCommands(state([], { transcript: null }), [{ op: "add_captions" }], "r");
  assert.equal(!res.ok && res.errors[0].code, "no_transcript");
});

// ── Scenario: motion graphics — lower third at the introduction ─────────────

test("lower third: placed at the introduction with the spoken name, then moved + delayed", () => {
  const intros = findIntroductions(interviewTranscript());
  assert.equal(intros[0].name, "Sarah Chen");

  const first = parseEditRequest("Add an animated lower third when the speaker introduces herself", input());
  assert.equal(first.kind, "commands");
  const add = (first as { commands: { op: string; text: string; start: number; presetId: string }[] }).commands[0];
  assert.equal(add.op, "add_graphic");
  assert.equal(add.presetId, "callout-lower-third");
  assert.match(add.text, /^Sarah Chen/);
  assert.ok(add.start >= 2 && add.start < 3);

  const r1 = applyEditCommands(state([]), [add as never], "lt-1");
  assert.ok(r1.ok);
  const lt = r1.moments[0];
  assert.equal(lt.effectType, "text-overlay");
  assert.ok(lt.animation?.in, "keeps the preset's animated entrance");

  // Revision: "Move it to the top left and delay it half a second" — "it"
  // resolves to the element the previous request created.
  const rev = parseEditRequest("Move it to the top left and delay it half a second", input({ moments: r1.moments, recentElementIds: [lt.id] }));
  assert.equal(rev.kind, "commands");
  const r2 = applyEditCommands(state(r1.moments), (rev as { commands: never[] }).commands, "lt-2");
  assert.ok(r2.ok);
  const moved = r2.moments.find((x) => x.id === lt.id)!;
  assert.equal(moved.startTime, Math.round((lt.startTime + 0.5) * 1000) / 1000);
  assert.equal(moved.endTime - moved.startTime, lt.endTime - lt.startTime, "duration preserved");
  assert.equal(moved.textStyle?.align, "left");
  assert.ok((moved.textStyle?.customY ?? 1) < 0.2, "near the top");
  assert.equal(moved.textOverlay?.text, lt.textOverlay?.text, "text untouched by a positional revision");
  assert.deepEqual(moved.animation, lt.animation, "animation untouched");
});

test("a targeted revision preserves unrelated edits, including manual ones made after the draft", () => {
  const manualZoom = m("u-zoom", "zoom", 30, 32, { source: "user", edited: true });
  const lt = applyEditCommands(state([]), [{ op: "add_graphic", presetId: "callout-lower-third", text: "Sarah", start: 2 }], "a");
  assert.ok(lt.ok);
  const withManual = [...lt.moments, manualZoom];
  const rev = applyEditCommands(state(withManual), [{ op: "update_element", elementId: lt.moments[0].id, position: "top-left" }], "b");
  assert.ok(rev.ok);
  assert.deepEqual(rev.moments.find((x) => x.id === "u-zoom"), manualZoom);
});

test("positionStyle keeps graphics inside the platform safe area", () => {
  const p = positionStyle("top-left", 1080, 1920);
  assert.equal(p.align, "left");
  assert.ok(p.customX! > 0.02 && p.customY! > 0.05);
});

// ── References ──────────────────────────────────────────────────────────────

test("'the shot before this one' resolves relative to the selected clip", () => {
  const base = [m("c1", "cut", 10, 20), m("c2", "cut", 40, 45)];
  const clips = deriveClips(base, SOURCE);
  const parsed = parseEditRequest("delete the shot before this one", input({ moments: base, selection: { clipId: clips[2].id } }));
  assert.deepEqual((parsed as { commands: unknown[] }).commands, [{ op: "delete_clip", clipId: clips[1].id }]);
});

test("ambiguous references become a question, never a guess", () => {
  const two = [
    m("t1", "text-overlay", 1, 3, { textOverlay: { text: "A" } as never }),
    m("t2", "text-overlay", 10, 13, { textOverlay: { text: "B" } as never }),
  ];
  const parsed = parseEditRequest("move the title to the top", input({ moments: two, playhead: 20 }));
  assert.equal(parsed.kind, "question");
});

test("unrecognized requests fall through to the model", () => {
  assert.equal(parseEditRequest("make it feel more cinematic", input()).kind, "none");
  assert.equal(parseEditRequest("open with the celebration, then cut back to the buildup", input()).kind, "none");
});

// ── Parsing helpers, digest, search ─────────────────────────────────────────

test("amounts and clauses", () => {
  assert.equal(parseAmount("two"), 2);
  assert.equal(parseAmount("half a"), 0.5);
  assert.equal(parseAmount("one and a half"), 1.5);
  assert.deepEqual(clauses("Move it to the top left and delay it half a second"), ["Move it to the top left", "delay it half a second"]);
  assert.deepEqual(clauses("salt and pepper"), ["salt and pepper"]);
});

test("digest gives the model selection, playhead, clips and elements without caption flood", () => {
  const caps = Array.from({ length: 50 }, (_, i) => m(`cap${i}`, "captions", i, i + 0.9, { captions: { text: "x" } as never }));
  const d = buildAssistantDigest(input({ moments: [m("c1", "cut", 10, 20), ...caps], playhead: 25 }));
  assert.equal(d.clips.length, 2);
  assert.equal(d.captions.count, 50);
  assert.equal(d.elements.length, 1);
  assert.equal(d.playhead.output, 15);
  assert.equal(d.playhead.clipId, d.clips[1].id);
});

test("findFootage matches speech", () => {
  const hits = findFootage({ analysis: { transcript: interviewTranscript() } as never }, "activation lift");
  assert.equal(hits[0].start, 30);
});

// ── Model tools, transitions, request log, old projects ─────────────────────

import { EDIT_TOOLS, toolCallToCommand, TOOL_KIND } from "../src/lib/edit-commands/tools.ts";
import { executeReadTool } from "../src/lib/edit-commands/read-tools.ts";
import { appendLog, entryFor, wasApplied, recentElementIds, ASSISTANT_LOG_LIMIT } from "../src/lib/edit-commands/log.ts";
import { materializeProject } from "../src/lib/firebase/materialize-project.ts";

test("every edit tool maps to a command the executor knows; bad args become model-readable errors", () => {
  const sample: Record<string, Record<string, unknown>> = {
    trim_clip: { clip_id: "clip:in:out", edge: "start", seconds: 2 },
    delete_clip: { clip_id: "clip:in:out" },
    remove_range: { start: 1, end: 2 },
    restore_range: { start: 1, end: 2 },
    set_speed: { start: 1, end: 5, multiplier: 2 },
    add_captions: {},
    add_graphic: { preset_id: "callout-lower-third", text: "Sarah", start: 2, position: "top-left" },
    add_zoom: { start: 1, end: 3 },
    add_transition: { at: 5, style: "fade" },
    add_click_zooms: {},
    set_camera: { start: 10, end: 16, beats: [{ at: 0, x: 0.5, y: 0.5, zoom: 1 }, { at: 1.5, x: 0.7, y: 0.5, zoom: 1.5 }] },
    update_camera: { element_id: "z", slower: true },
    compose_graphic: { start: 12, label_title: "Chicken Tikka", label_sub: "Rs 380", label_tone: "premium" },
    update_graphic: { element_id: "g", remove_parts: ["line"] },
    tighten_pauses: { min_pause: 1.2 },
    update_element: { element_id: "x", text: "Hi" },
    shift_element: { element_id: "x", seconds: 0.5 },
    split_element: { element_id: "x", at: 1 },
    remove_element: { element_id: "x" },
  };
  for (const tool of EDIT_TOOLS.filter((t) => t.kind === "edit")) {
    const cmd = toolCallToCommand(tool.name, sample[tool.name]);
    assert.equal(typeof cmd, "object", `${tool.name} maps to a command`);
  }
  assert.match(toolCallToCommand("trim_clip", { edge: "start" }) as string, /Missing clip_id/);
  assert.equal(TOOL_KIND.get("ask_user"), "control");
  // Tool schemas are plain JSON Schema objects (usable by Gemini and Claude alike).
  for (const t of EDIT_TOOLS) assert.equal((t.parameters as { type: string }).type, "object");
});

test("transitions: 'add fade transitions between clips' puts one at every join", () => {
  const base = [m("c1", "cut", 10, 20), m("c2", "cut", 40, 45)];
  const parsed = parseEditRequest("add fade transitions between the clips", input({ moments: base }));
  assert.equal(parsed.kind, "commands");
  const res = applyEditCommands(state(base), (parsed as { commands: never[] }).commands, "tr");
  assert.ok(res.ok);
  const tr = res.moments.filter((x) => x.effectType === "transition");
  assert.deepEqual(tr.map((x) => x.startTime), [20, 45]);
  assert.ok(tr.every((x) => x.transition?.style === "fade"));
  assertParity(res.moments);
});

test("read tools answer from the same footage search the parser uses", async () => {
  const project = { analysis: { transcript: interviewTranscript(), detectedMoments: [] } } as never;
  const digest = buildAssistantDigest(input());
  const takes = (await executeReadTool("find_repeated_takes", {}, { project, digest })) as { takes: { suggestedRemoveFirst: { start: number; end: number } }[] };
  assert.equal(takes.takes.length, 1);
  assert.ok(takes.takes[0].suggestedRemoveFirst.end <= 18);
  const intro = (await executeReadTool("find_introductions", {}, { project, digest })) as { introductions: { name: string }[] };
  assert.equal(intro.introductions[0].name, "Sarah Chen");
  const noInspect = (await executeReadTool("inspect_footage", { start: 0, end: 5, question: "?" }, { project, digest })) as { error: string };
  assert.match(noInspect.error, /isn't available/);
  const graphics = (await executeReadTool("list_graphics", { category: "callouts" }, { project, digest })) as { graphics: { id: string }[] };
  assert.ok(graphics.graphics.some((g) => g.id === "callout-lower-third"));
});

test("request log: a known request id is recognised (retry = no-op), log is bounded, 'it' comes from it", () => {
  const e1 = entryFor("req-1", "add a lower third", "local", [{ kind: "added", elementId: "lt", effectType: "text-overlay", summary: "Added", at: 2 }], 1);
  let log = appendLog(undefined, e1);
  assert.ok(wasApplied(log, "req-1"));
  assert.equal(wasApplied(log, "req-2"), null);
  assert.deepEqual(recentElementIds(log), ["lt"]);
  for (let i = 0; i < ASSISTANT_LOG_LIMIT + 5; i++) log = appendLog(log, { ...e1, requestId: `r${i}` });
  assert.equal(log.length, ASSISTANT_LOG_LIMIT);
  // Re-appending the same id replaces, never duplicates.
  assert.equal(appendLog(log, { ...e1, requestId: "r44" }).filter((e) => e.requestId === "r44").length, 1);
});

test("old projects: no assistantLog materializes as undefined; a saved log round-trips", () => {
  const legacy = materializeProject("p1", { title: "Old", status: "analyzed", analysis: { detectedMoments: [] } });
  assert.equal(legacy.assistantLog, undefined);
  const garbage = materializeProject("p1", { title: "Odd", assistantLog: "nope" });
  assert.equal(garbage.assistantLog, undefined);
  const entry = entryFor("req-x", "trim", "local", [], 5);
  const saved = materializeProject("p1", { title: "New", assistantLog: [entry] });
  assert.deepEqual(saved.assistantLog, [entry]);
});
