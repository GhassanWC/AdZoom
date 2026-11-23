/**
 * Chat-first editing: footage-dependent requests prepare their data instead of
 * asking the user, multi-part requests report partial results honestly, the
 * welcome is short and relevant, and the former toolbar tools are reachable by
 * name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { DetectedMoment, Transcript } from "../src/lib/firebase/schema.ts";
import { parseEditRequest, parseUiAction } from "../src/lib/edit-commands/parse.ts";
import { applyEditCommands, pauseCuts } from "../src/lib/edit-commands/apply.ts";
import { blockedLines, welcomeSuggestions, WELCOME } from "../src/lib/edit-commands/chat.ts";
import type { AssistantInput } from "../src/lib/edit-commands/context.ts";
import type { ClickMark } from "../src/lib/edit-commands/types.ts";
import { outputCanvasForAspect } from "../src/lib/timeline/canvas-layout.ts";
import { buildTimelineMap } from "../src/lib/timeline/crop-speed.ts";

const DUR = 31;

function transcript(): Transcript {
  const lines = [
    { start: 0.5, end: 4.2, text: "Hi, I'm Sarah Chen, and this is a quick tour of the Lumen dashboard." },
    { start: 7.7, end: 11.0, text: "First, I'll open the reports tab to see this week's numbers." },
    { start: 14.0, end: 17.0, text: "Then I click export, so the whole team gets a copy." },
    { start: 21.0, end: 25.0, text: "Finally, the settings button lets you invite a teammate. That's it." },
  ];
  const words = lines.flatMap((l) => {
    const ws = l.text.split(" ");
    const per = (l.end - l.start) / ws.length;
    return ws.map((w, i) => ({ word: w, startTime: l.start + i * per, endTime: l.start + (i + 0.85) * per }));
  });
  return { status: "complete", segments: lines.map((l, i) => ({ id: `s${i}`, startTime: l.start, endTime: l.end, text: l.text })), words, text: "" } as Transcript;
}

const clicks: ClickMark[] = [
  { t: 9.5, x: 0.18, y: 0.15, source: "frames" },
  { t: 16.0, x: 0.28, y: 0.15, source: "frames" },
  { t: 24.0, x: 0.38, y: 0.15, source: "frames" },
];

function input(over: Partial<AssistantInput> = {}): AssistantInput {
  return {
    project: { analysis: { detectedMoments: [] } as never, duration: DUR },
    moments: [],
    layers: {},
    sourceDuration: DUR,
    playhead: 0,
    selection: {},
    recentElementIds: [],
    ...over,
  };
}
const withTranscript = (over: Partial<AssistantInput> = {}) =>
  input({ project: { analysis: { transcript: transcript(), detectedMoments: [] } as never, duration: DUR }, ...over });

const state = (moments: DetectedMoment[] = [], extra: object = {}) => ({
  moments, sourceDuration: DUR, canvasWidth: 1280, canvasHeight: 720, ...extra,
});

// ── "add captions": transcript is prepared, never asked for ────────────────

test("'add captions' without a transcript asks to PREPARE one, not the user", () => {
  assert.deepEqual(parseEditRequest("add captions", input()), { kind: "needs", needs: ["transcript"] });
  const after = parseEditRequest("add captions", withTranscript({ prepared: ["transcript"] }));
  assert.deepEqual(after, { kind: "commands", commands: [{ op: "add_captions" }], notes: [] });
});

test("captions after a FAILED transcription: honest blocked reason from the prep step", () => {
  const p = parseEditRequest("add captions", input({ prepared: ["transcript"] }));
  assert.equal(p.kind, "commands");
  const res = applyEditCommands(state([], { transcript: null }), (p as { commands: never[] }).commands, "r");
  assert.equal(res.ok, false);
  const lines = blockedLines(!res.ok ? res.errors : [], [{ need: "transcript", note: "speech-to-text failed: quota reached" }]);
  assert.deepEqual(lines, ["Captions weren't added — speech-to-text failed: quota reached."]);
});

// ── "add zooms on clicks": clicks are found, then one zoom per click ───────

test("'add zooms on clicks' prepares clicks, then adds one framed zoom per click", () => {
  assert.deepEqual(parseEditRequest("add zooms on clicks", input()), { kind: "needs", needs: ["clicks"] });
  const p = parseEditRequest("add zooms on clicks", input({ prepared: ["clicks"], clicks }));
  assert.deepEqual((p as { commands: unknown[] }).commands, [{ op: "add_click_zooms" }]);
  const res = applyEditCommands(state([], { clicks }), [{ op: "add_click_zooms" }], "z");
  assert.ok(res.ok);
  const zooms = res.moments.filter((m) => m.effectType === "zoom");
  assert.equal(zooms.length, 3);
  assert.deepEqual(res.changes.map((c) => c.summary), ["Added 3 zooms on clicks"]);
  for (const [i, z] of zooms.entries()) {
    assert.ok(z.startTime < clicks[i].t && z.endTime > clicks[i].t, "zoom covers its click");
    const cx = z.focusRegion.x + z.focusRegion.width / 2;
    assert.ok(Math.abs(cx - Math.max(z.focusRegion.width / 2, clicks[i].x)) < 1e-6, "framed on the click (clamped inside the frame)");
  }
  // A second request doesn't stack zooms on the same clicks.
  const again = applyEditCommands(state(res.moments, { clicks }), [{ op: "add_click_zooms" }], "z2");
  assert.equal(again.ok, false);
});

test("no clicks found after preparing → blocked with the reason, no fake zooms", () => {
  const res = applyEditCommands(state([], { clicks: [] }), [{ op: "add_click_zooms" }], "z");
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.errors[0].code, "no_clicks");
});

// ── "make a calm walkthrough with captions": pacing AND captions ───────────

test("'make a calm walkthrough with captions' = calm pause tightening + captions", () => {
  assert.deepEqual(parseEditRequest("make a calm walkthrough with captions", input()), { kind: "needs", needs: ["transcript"] });
  const p = parseEditRequest("make a calm walkthrough with captions", withTranscript({ prepared: ["transcript"] }));
  assert.deepEqual((p as { commands: unknown[] }).commands, [
    { op: "tighten_pauses", minPause: 1.4, keep: 0.6 },
    { op: "add_captions" },
  ]);
  const res = applyEditCommands(state([], { transcript: transcript() }), (p as { commands: never[] }).commands, "calm", { partial: true });
  assert.ok(res.ok);
  assert.equal(res.errors.length, 0);
  const summaries = res.changes.map((c) => c.summary);
  assert.match(summaries[0], /^Tightened \d+ pauses \(−\d+\.\ds\)$/);
  assert.match(summaries[1], /^Added \d+ captions$/);
  // Pauses are cut BETWEEN words: no cut overlaps a spoken word.
  const words = transcript().words!;
  for (const c of res.moments.filter((m) => m.effectType === "cut")) {
    assert.ok(!words.some((w) => w.startTime < c.endTime && w.endTime > c.startTime), `cut ${c.startTime}–${c.endTime} clips a word`);
  }
  assert.ok(buildTimelineMap(res.moments, DUR).totalRemoved > 3);
});

test("partial request: pacing succeeds, captions blocked → applied with a blocked line", () => {
  const silences = [{ start: 4.5, end: 7.5 }, { start: 11.2, end: 13.9 }];
  const res = applyEditCommands(
    state([], { transcript: null, silences }),
    [{ op: "tighten_pauses", minPause: 1.4, keep: 0.6 }, { op: "add_captions" }],
    "p",
    { partial: true }
  );
  assert.ok(res.ok, "the part that works is applied");
  assert.equal(res.changes.length, 1);
  assert.equal(res.errors[0].code, "no_transcript");
});

test("pauseCuts keeps a breath and never cuts inside a word", () => {
  const cuts = pauseCuts({ transcript: transcript(), sourceDuration: DUR }, 1.0, 0.4);
  assert.ok(cuts.length >= 3);
  // Gap 4.2→7.7 keeps 0.2s on each side.
  const mid = cuts.find((c) => c.start > 4 && c.start < 5)!;
  assert.ok(Math.abs(mid.start - 4.4) < 0.05 && Math.abs(mid.end - 7.5) < 0.05, JSON.stringify(mid));
});

// ── Former toolbar tools by name ────────────────────────────────────────────

test("former right-toolbar actions are reachable by name in chat", () => {
  const cases: [string, string][] = [
    ["crop the frame", "crop"],
    ["open the canvas settings", "canvas"],
    ["change the caption language", "captions-panel"],
    ["show me the presets", "presets"],
    ["apply a look", "presets"],
    ["make some short clips", "clips"],
    ["any suggestions?", "insights"],
    ["auto-edit the whole video", "full-edit"],
  ];
  for (const [text, kind] of cases) {
    assert.equal(parseUiAction(text)?.kind, kind, text);
    assert.equal(parseEditRequest(text, input()).kind, "ui", text);
  }
  assert.deepEqual(parseUiAction("make it vertical"), { kind: "aspect", aspect: "9:16" });
  assert.deepEqual(parseUiAction("change it to square"), { kind: "aspect", aspect: "1:1" });
  assert.deepEqual(parseUiAction("change it back to the original size"), { kind: "aspect", aspect: "source" });
  assert.deepEqual(parseUiAction("go back to the source size"), { kind: "aspect", aspect: "source" });
});

test("the aspect command matches the Canvas panel's write (shared function)", () => {
  const oc = outputCanvasForAspect(null, "9:16", 1920, 1080);
  assert.equal(oc.aspectRatio, "9:16");
  assert.equal(oc.fitMode, "smart-fit");
  assert.ok(oc.height > oc.width);
  const kept = outputCanvasForAspect({ ...oc, fitMode: "fit", backgroundMode: "solid", backgroundColor: "#112233" }, "1:1", 1920, 1080);
  assert.equal(kept.fitMode, "fit", "user's fit survives an aspect change");
  assert.equal(kept.backgroundColor, "#112233");
  assert.equal(kept.width, kept.height);
});

// ── Welcome ─────────────────────────────────────────────────────────────────

test("welcome: one line, at most two suggestions that fit the footage", () => {
  assert.equal(WELCOME, "What would you like to change in your video?");
  const screen = welcomeSuggestions({ selectedVideoType: "screen-recording", analysis: { detectedMoments: [] } as never });
  assert.deepEqual(screen, ["Add captions", "Add zooms on clicks"]);
  const captioned = welcomeSuggestions({
    selectedVideoType: "talking-head",
    analysis: { detectedMoments: [{ id: "c", effectType: "captions", startTime: 0, endTime: 1 }] } as never,
  });
  assert.ok(!captioned.includes("Add captions"), "never suggests what's already done");
  assert.ok(captioned.length <= 2);
});

test("ordinal references pick the right element: 'delay the second zoom by half a second'", () => {
  const res = applyEditCommands(state([], { clicks }), [{ op: "add_click_zooms" }], "z");
  assert.ok(res.ok);
  const zooms = res.moments.filter((m) => m.effectType === "zoom").sort((a, b) => a.startTime - b.startTime);
  const p = parseEditRequest("delay the second zoom by half a second", input({ moments: res.moments, recentElementIds: [zooms[0].id] }));
  assert.deepEqual((p as { commands: unknown[] }).commands, [{ op: "shift_element", elementId: zooms[1].id, seconds: 0.5 }]);
  const last = parseEditRequest("remove the last zoom", input({ moments: res.moments }));
  assert.deepEqual((last as { commands: unknown[] }).commands, [{ op: "remove_element", elementId: zooms[2].id }]);
});

test("a creative brief is NOT a pacing command, and pacing never deletes a speechless video", () => {
  // "calm menu walkthrough" → the model (camera + graphics), not tighten_pauses.
  assert.equal(parseEditRequest("Give this a calm menu walkthrough", input()).kind, "none");
  assert.equal(parseEditRequest("Make the dish reveal feel like a premium food ad", input()).kind, "none");
  // Explicit pacing words still are.
  assert.deepEqual(parseEditRequest("tighten the long pauses", input({ prepared: ["pauses"] })), {
    kind: "commands", commands: [{ op: "tighten_pauses", minPause: 0.9, keep: 0.35 }], notes: [],
  });
  // No speech: one 33s "silence" must be refused, not cut.
  const res = applyEditCommands(state([], { transcript: null, silences: [{ start: 0, end: 33.2 }] }), [{ op: "tighten_pauses", minPause: 1.4, keep: 0.6 }], "p");
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.errors[0].code, "no_audio");
});
