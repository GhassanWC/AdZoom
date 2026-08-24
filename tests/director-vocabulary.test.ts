/**
 * AI Director — what the chat can HEAR.
 *
 * The regression these lock down is a real one: a user looked at a finished edit
 * and typed
 *
 *     "please reomve focus and cuts and zooms"
 *
 * …and was told "I didn't catch a change I can make in that. Try naming the
 * length, the shape, or an edit type." Every part of that sentence names an edit
 * type. It failed on a transposed letter, on two edit types the parser had no
 * word for at all, and on a phrasing ("remove X") that only ever meant something
 * when it was spelled "remove some X".
 *
 * So these tests are deliberately written the way people type, not the way the
 * parser used to demand: typos in, synonyms in, several instructions in one
 * sentence. The other half of the file is the opposite guarantee — that widening
 * what the parser hears did NOT make it start guessing, because a wrong guess
 * silently rewrites someone's video.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findEditTargets,
  isResetCommand,
  normalizeCommand,
} from "../src/lib/director/vocabulary.ts";
import { applyRevision, parseRevisionCommand } from "../src/lib/director/revision.ts";
import { buildDirectorContext } from "../src/lib/director/context-builder.ts";
import { buildHeuristicPlan } from "../src/lib/director/planner.ts";
import { runDirectorPipeline } from "../src/lib/director/pipeline.ts";
import { parseDirectorRequest } from "../src/lib/director/request.ts";
import { isDirectorMoment } from "../src/lib/director/executor.ts";
import type { DirectorPlan } from "../src/lib/director/types.ts";

import { demoProject, SOURCE_DURATION } from "./director-fixtures.ts";

const NOW = 1_700_000_000_000;
const REQUEST = parseDirectorRequest(
  "Fast 45-second product demo for TikTok with captions and a CTA.",
  {}
);

function ctxFor(project = demoProject()) {
  return buildDirectorContext(project);
}

function planFor(project = demoProject()): DirectorPlan {
  return buildHeuristicPlan(ctxFor(project), REQUEST, NOW);
}

function runFull(project = demoProject()) {
  return runDirectorPipeline({
    plan: planFor(project),
    moments: [],
    duration: SOURCE_DURATION,
    revision: 0,
    transcript: project.analysis!.transcript,
    videoType: project.selectedVideoType,
    sourceWidth: project.width,
    sourceHeight: project.height,
    effects: project.effectsSettings,
  });
}

const kinds = (command: string) =>
  parseRevisionCommand(command).intents.map((i) => i.kind);

// ════════════════════════════════════════════════════════════════════════════
// 1. Typos
// ════════════════════════════════════════════════════════════════════════════

test("V1. typos: a transposed letter no longer changes what a command means", () => {
  for (const [typed, intended] of [
    ["reomve", "remove"],
    ["captoins", "captions"],
    ["trasition", "transition"],
    ["vertcial", "vertical"],
    ["secodns", "seconds"],
  ] as const) {
    assert.match(
      normalizeCommand(typed),
      new RegExp(`^${intended}$`),
      `"${typed}" should normalize to "${intended}"`
    );
  }
});

test("V1b. typos: words that aren't near-misses are left exactly as typed", () => {
  // If this ever "corrects" something, the parser starts inventing meanings —
  // which is the one failure mode worse than not understanding.
  for (const word of ["banana", "flavoured", "kubernetes", "pricing", "checkout"]) {
    assert.equal(normalizeCommand(word), word, `"${word}" must survive untouched`);
  }
});

test("V1c. typos: short words are never corrected — too many false positives", () => {
  // "cut" is one edit away from "cta", "cup", "cur", "cot"… At three letters a
  // near-match is a coincidence, not evidence.
  assert.equal(normalizeCommand("cut"), "cut");
  assert.equal(normalizeCommand("cta"), "cta");
  assert.equal(normalizeCommand("zom"), "zom");
});

// ════════════════════════════════════════════════════════════════════════════
// 2. The message from the bug report
// ════════════════════════════════════════════════════════════════════════════

test("V2. THE REGRESSION: 'please reomve focus and cuts and zooms' is understood", () => {
  const parsed = parseRevisionCommand("please reomve focus and cuts and zooms");

  assert.equal(parsed.unrecognized, false, "this is a perfectly clear instruction");
  assert.equal(parsed.intents.length, 3, "three edit types were named, so three intents");

  const byType = new Map(
    parsed.intents.map((i) =>
      i.kind === "adjust-edit-count" ? [i.editType, i.direction] : ["?", "?"]
    )
  );
  assert.equal(byType.get("cursor-focus"), "none", "focus → remove them all");
  assert.equal(byType.get("cut"), "none", "cuts → put the footage back");
  assert.equal(byType.get("zoom"), "none", "zooms → remove them all");
});

test("V2b. the conjunction carries the verb: 'and X and Y' inherits 'remove'", () => {
  const targets = findEditTargets("remove the callouts and the transitions");
  assert.deepEqual(
    targets.map((t) => [t.type, t.direction]),
    [
      ["callout", "none"],
      ["transition", "none"],
    ]
  );
});

test("V2c. one sentence can say two opposite things", () => {
  const targets = findEditTargets("fewer zooms but more callouts please");
  assert.deepEqual(
    targets.map((t) => [t.type, t.direction]),
    [
      ["zoom", "fewer"],
      ["callout", "more"],
    ],
    "direction is read per mention, not once for the whole sentence"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Every edit type has a word people actually use
// ════════════════════════════════════════════════════════════════════════════

test("V3. every Director edit type can be named in plain English", () => {
  const cases: Array<[string, string]> = [
    ["get rid of the zooms", "zoom"],
    ["no more focus effects", "cursor-focus"],
    ["remove the click highlights", "click-highlight"],
    ["drop the callouts", "callout"],
    ["lose the arrows", "callout"],
    ["take out the transitions", "transition"],
    ["remove the crossfades", "transition"],
    ["no text overlays", "text-overlay"],
    ["get rid of the labels", "text-overlay"],
    ["remove the hook text", "hook-text"],
    ["kill the speed ups", "speed-up"],
    ["remove the fast forwards", "speed-up"],
    ["turn off the captions", "captions"],
    ["no subtitles", "captions"],
  ];

  for (const [command, expected] of cases) {
    const targets = findEditTargets(normalizeCommand(command));
    assert.ok(
      targets.some((t) => t.type === expected),
      `"${command}" → ${expected} (got ${targets.map((t) => t.type).join(",") || "nothing"})`
    );
    assert.equal(
      parseRevisionCommand(command).unrecognized,
      false,
      `"${command}" must produce a real intent`
    );
  }
});

test("V3b. a longer name wins over the shorter one inside it", () => {
  // "whip cut" is a transition. Hearing it as a transition AND a cut would put
  // 6 minutes of removed footage back because the user asked about a wipe.
  const targets = findEditTargets("remove the whip cuts");
  assert.deepEqual(targets.map((t) => t.type), ["transition"]);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Widening the vocabulary must not make it guess
// ════════════════════════════════════════════════════════════════════════════

test("V4. verbs that share a word with an edit type stay verbs", () => {
  // "cut it to 30 seconds" is a DURATION. If "cut" read as the edit type here,
  // asking for a shorter video would restore the whole recording instead.
  assert.deepEqual(kinds("cut it to 30 seconds"), ["set-target-duration"]);
  assert.deepEqual(kinds("trim it to a minute"), ["set-target-duration"]);
  assert.deepEqual(kinds("crop it to vertical"), ["set-aspect"]);
});

test("V4b. 'remove SOME zooms' is a reduction, not a deletion", () => {
  const parsed = parseRevisionCommand("remove some of the zooms");
  assert.deepEqual(parsed.intents, [
    { kind: "adjust-edit-count", editType: "zoom", direction: "fewer" },
  ]);
});

test("V4c. gibberish is still reported as unrecognized rather than guessed at", () => {
  for (const command of [
    "make it more banana flavoured",
    "add some background music",
    "put the clips in a different order",
    "asdfghjkl",
  ]) {
    assert.equal(
      parseRevisionCommand(command).unrecognized,
      true,
      `"${command}" must escalate rather than be guessed at`
    );
  }
});

test("V4d. naming an edit type without a direction is not an instruction", () => {
  // "what are the zooms doing?" names a type but asks for nothing. Better to
  // escalate to the model than to invent a direction.
  assert.equal(parseRevisionCommand("what are the zooms doing").unrecognized, true);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. The intents actually change the timeline
// ════════════════════════════════════════════════════════════════════════════

test("V5. 'remove the zooms' really removes every zoom from the timeline", () => {
  const project = demoProject();
  const ctx = ctxFor(project);
  const first = runFull(project);

  const zoomsBefore = first.moments.filter(
    (m) => isDirectorMoment(m) && m.effectType === "zoom" && m.enabled !== false
  ).length;
  assert.ok(zoomsBefore >= 1, "there are zooms to remove");

  const { intents } = parseRevisionCommand("remove the zooms");
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
  assert.equal(zoomsAfter, 0, `${zoomsBefore} zooms → none`);
  assert.ok(
    revised.changes.some((c) => /zoom/i.test(c)),
    "and it says so in words the user can read"
  );
});

test("V5b. 'remove the cuts' gives the removed footage back", () => {
  const project = demoProject();
  const ctx = ctxFor(project);
  const first = runFull(project);
  assert.ok(
    first.summary.outputDurationSeconds < SOURCE_DURATION * 0.9,
    "the first pass really did cut the video down"
  );

  const { intents } = parseRevisionCommand("remove the cuts");
  const revised = applyRevision(first.plan, intents, ctx, 1);
  const second = runDirectorPipeline({
    plan: revised.plan,
    moments: first.moments,
    duration: SOURCE_DURATION,
    revision: 1,
    transcript: project.analysis!.transcript,
    effects: project.effectsSettings,
  });

  assert.equal(
    second.moments.filter((m) => isDirectorMoment(m) && m.effectType === "cut" && m.enabled !== false)
      .length,
    0,
    "not one cut moment survives"
  );
  assert.ok(
    second.summary.removedSeconds < 1,
    `nothing is removed any more (was ${first.summary.removedSeconds.toFixed(0)}s)`
  );
  // Deliberately NOT `> SOURCE_DURATION * 0.95`: a surviving speed-up still
  // compresses the output, and "remove the cuts" is not a request to remove
  // speed-ups. The video is whole; it is not necessarily the same length.
  assert.ok(
    second.summary.outputDurationSeconds > first.summary.outputDurationSeconds * 2,
    `far more of the recording plays (${first.summary.outputDurationSeconds.toFixed(0)}s → ${second.summary.outputDurationSeconds.toFixed(0)}s)`
  );
});

test("V5c. the message from the bug report applies cleanly, end to end", () => {
  const project = demoProject();
  const ctx = ctxFor(project);
  const first = runFull(project);

  const { intents } = parseRevisionCommand("please reomve focus and cuts and zooms");
  const revised = applyRevision(first.plan, intents, ctx, 1);
  const second = runDirectorPipeline({
    plan: revised.plan,
    moments: first.moments,
    duration: SOURCE_DURATION,
    revision: 1,
    transcript: project.analysis!.transcript,
    effects: project.effectsSettings,
  });

  assert.ok(second.applied, "the change lands on the timeline");
  assert.ok(revised.changes.length > 0, "and the user is told what it did");

  const live = (type: string) =>
    second.moments.filter(
      (m) => isDirectorMoment(m) && m.effectType === type && m.enabled !== false
    ).length;
  assert.equal(live("zoom"), 0, "no zooms left");
  assert.equal(live("cursor-focus"), 0, "no focus effects left");
  assert.equal(live("cut"), 0, "no cuts left");
});

test("V5d. asking to remove something that isn't there is reported, not silently ignored", () => {
  const project = demoProject();
  const ctx = ctxFor(project);
  const first = runFull(project);

  // Strip the callouts, then ask for them to be stripped again.
  const stripped = applyRevision(
    first.plan,
    [{ kind: "adjust-edit-count", editType: "callout", direction: "none" }],
    ctx,
    1
  );
  const again = applyRevision(
    stripped.plan,
    [{ kind: "adjust-edit-count", editType: "callout", direction: "none" }],
    ctx,
    2
  );

  assert.equal(again.changes.length, 0, "nothing changed");
  assert.ok(again.noops.length > 0, "and the user is told why, rather than shown a fake success");
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Start over
// ════════════════════════════════════════════════════════════════════════════

test("V6. 'start over' is recognised however it's phrased", () => {
  for (const command of [
    "start over",
    "remove everything",
    "get rid of all the edits",
    "just give me the original video",
    "reset",
  ]) {
    assert.ok(isResetCommand(command), `"${command}" should reset`);
    assert.deepEqual(kinds(command), ["reset-edits"], `"${command}" → reset-edits`);
  }
});

test("V6b. reset really does clear the timeline back to the raw recording", () => {
  const project = demoProject();
  const ctx = ctxFor(project);
  const first = runFull(project);

  const revised = applyRevision(first.plan, [{ kind: "reset-edits" }], ctx, 1);
  const second = runDirectorPipeline({
    plan: revised.plan,
    moments: first.moments,
    duration: SOURCE_DURATION,
    revision: 1,
    transcript: project.analysis!.transcript,
    effects: project.effectsSettings,
  });

  assert.equal(
    second.moments.filter((m) => isDirectorMoment(m) && m.enabled !== false).length,
    0,
    "not one Director edit is left"
  );
  assert.ok(
    second.summary.outputDurationSeconds > SOURCE_DURATION * 0.95,
    "and the full recording is back"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 7. The phrasing table
// ════════════════════════════════════════════════════════════════════════════

/**
 * A broad sweep of how people really write, kept as one table so that widening
 * the parser later can't quietly narrow it somewhere else. Anything that fails
 * here isn't refused — it escalates to the model — but every line in this list
 * is common enough that paying a network round-trip for it would be a bug.
 */
test("V7. the phrasings people actually type are handled locally", () => {
  const shouldParse = [
    "please reomve focus and cuts and zooms",
    "remove the zooms", "no zooms please", "get rid of all the zooms",
    "too many zooms", "way too many transitions", "tone down the callouts",
    "lose the text overlays", "kill the captions", "turn off the subtitles",
    "make it 30 seconds", "make it thirty seconds", "cut it down to a minute",
    "half a minute", "under 45 seconds", "make it 1:30",
    "make it vertical", "square please", "switch to 16:9", "convert to portrait",
    "remove the cuts", "fewer cuts", "the cuts are too choppy",
    "start over", "remove everything", "give me the raw video back",
    "add more callouts", "more transitions",
    "make the beginning faster", "let the ending breathe",
    "remove the third clip", "keep more of the pricing",
    "stronger CTA", "remove the CTA", "no call to action",
    "make the captions minimal", "captions should be more professional",
    "delete the hook", "remove the speed ups", "no reframe",
    "remove teh zooms", "fewer zoosm", "no captoins",
  ];

  const missed = shouldParse.filter((c) => parseRevisionCommand(c).unrecognized);
  assert.deepEqual(missed, [], "these should never need a model round-trip");
});

test("V7b. genuinely unsupported asks escalate instead of being faked", () => {
  // Framevo cannot add music, cannot reorder clips (buildTimelineMap is
  // monotonic), and has no idea what "funnier" means. The parser must NOT
  // invent an intent for these — they go to the model, and if it agrees they're
  // impossible the user is told so and offered a re-direct.
  for (const command of ["add background music", "reorder the clips", "make it funnier"]) {
    assert.equal(
      parseRevisionCommand(command).unrecognized,
      true,
      `"${command}" must not be guessed at locally`
    );
  }
});
