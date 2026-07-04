/**
 * Analysis-progress UI model — locks the modern, video-type-aware progress copy:
 * steps reflect the new AI edit types + selected options, screen-recording
 * language is confined to Screen Recording, "zoom timeline" is gone, edit counts
 * include every type, activity is product-friendly, and Gemini connection errors
 * map to a friendly kind. Pure functions → node --test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildProgressSteps,
  progressHeadline,
  countGeneratedEdits,
  editsProgressLine,
  friendlyActivityFeed,
  mapActivity,
} from "../src/lib/analysis-progress.ts";
import { classifyError, ANALYSIS_STAGES } from "../src/lib/analysis-stages.ts";

const ALL_ON = {
  generateCameraEdits: true,
  generateCut: true,
  generateSpeed: true,
  generateCaptions: true,
  generateHookText: true,
  generateTextOverlays: true,
  generateSmartCrop: true,
  generateCallouts: true,
  generateTransitions: true,
  generateCta: true,
  existingEditMode: "replace-selected",
  chunkMode: "balanced",
  chunkSizeSeconds: 30,
};

const NORMAL_TYPES = ["reels-shorts", "talking-head", "product-demo", "tutorial", "ad-promo", "vlog", "podcast-clip", "auto"];

test("progress steps include the new AI edit types", () => {
  const ids = buildProgressSteps({ videoType: "reels-shorts", options: ALL_ON }).map((s) => s.id);
  for (const id of ["cuts", "zooms", "speed", "captions", "hook", "text", "smartcrop", "callouts", "cta", "transitions", "timeline", "finalize"]) {
    assert.ok(ids.includes(id), `missing step: ${id}`);
  }
});

test("'Building zoom timeline' no longer appears anywhere", () => {
  const steps = buildProgressSteps({ videoType: "auto", options: ALL_ON });
  assert.ok(steps.every((s) => !/zoom timeline/i.test(s.label)));
  assert.ok(ANALYSIS_STAGES.every((s) => !/zoom timeline/i.test(s.label) && !/zoom timeline/i.test(s.description)));
});

test("cursor / click / UI-interaction language ONLY for Screen Recording", () => {
  const screen = buildProgressSteps({ videoType: "screen-recording", options: ALL_ON }).map((s) => s.label).join(" | ");
  assert.match(screen, /interaction|click|focus/i, "screen recording keeps interaction language");
  for (const vt of NORMAL_TYPES) {
    const labels = buildProgressSteps({ videoType: vt, options: ALL_ON }).map((s) => s.label).join(" | ");
    assert.ok(!/cursor|clicks|ui interaction/i.test(labels), `${vt} leaks screen-recording language: ${labels}`);
  }
  // Headline subtitle: interaction language only for screen recording.
  assert.ok(!/interaction|click/i.test(progressHeadline("reels-shorts").subtitle));
  assert.match(progressHeadline("screen-recording").subtitle, /interaction/i);
});

test("disabled generation options are NOT shown as steps", () => {
  const opts = { ...ALL_ON, generateCaptions: false, generateCallouts: false, generateCta: false, generateSmartCrop: false };
  const ids = buildProgressSteps({ videoType: "product-demo", options: opts }).map((s) => s.id);
  for (const gone of ["captions", "callouts", "cta", "smartcrop", "transcribe"]) {
    assert.ok(!ids.includes(gone), `${gone} should be hidden when off`);
  }
  assert.ok(ids.includes("cuts") && ids.includes("zooms") && ids.includes("timeline"));
});

test("captions off also removes the transcribe step (transcript's main consumer)", () => {
  const ids = buildProgressSteps({ videoType: "talking-head", options: { ...ALL_ON, generateCaptions: false } }).map((s) => s.id);
  assert.ok(!ids.includes("transcribe"));
  assert.ok(!ids.includes("captions"));
});

test("headline is generic 'Generating your AI edit…'", () => {
  assert.equal(progressHeadline("reels-shorts").headline, "Generating your AI edit…");
  assert.equal(progressHeadline("screen-recording").headline, "Generating your AI edit…");
});

test("edit count includes ALL types (cuts/zooms/speeds/captions/overlays), not only zooms", () => {
  const m = (effectType) => ({
    effectType, id: effectType, startTime: 0, endTime: 1, label: "", reason: "",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
  });
  const moments = [m("zoom"), m("cut"), m("speed-up"), m("captions"), m("callout"), m("hook-text"), m("branding-cta")];
  assert.equal(countGeneratedEdits(moments), 7);
  assert.equal(countGeneratedEdits([]), 0);
  assert.equal(countGeneratedEdits(undefined), 0, "old projects without moments still load");
});

test("edits progress line is honest (0 vs N)", () => {
  assert.match(editsProgressLine(0), /Preparing your selected AI edits/i);
  assert.ok(!/0 edits/i.test(editsProgressLine(0)));
  assert.match(editsProgressLine(12), /^12 edits generated so far/i);
  assert.match(editsProgressLine(1), /^1 edit generated so far/);
});

test("activity feed hides technical Gemini lines + renames to friendly labels", () => {
  const raw = [
    { ts: 1, kind: "info", text: "Analysis started" },
    { ts: 2, kind: "ok", text: "Downloaded video (43.0 MB)" },
    { ts: 3, kind: "info", text: "Uploading video to Gemini Files API" },
    { ts: 4, kind: "ok", text: "Uploaded — file id abc123" },
    { ts: 5, kind: "info", text: "Gemini state: PROCESSING" },
    { ts: 6, kind: "ok", text: "Analysis complete — 12 moments" },
  ];
  const labels = friendlyActivityFeed(raw).map((f) => f.label);
  assert.ok(labels.includes("Analysis started"));
  assert.ok(labels.includes("Video prepared"));
  assert.ok(labels.includes("Analysis complete — 12 moments"));
  // No raw technical strings leak into the friendly feed.
  assert.ok(!labels.some((l) => /gemini|files api|file id|state:/i.test(l)), `technical leaked: ${labels.join(" | ")}`);
  // The upload lines collapse into a single friendly "Preparing AI analysis".
  assert.equal(labels.filter((l) => l === "Preparing AI analysis").length, 1);
  // mapActivity flags the un-renamed technical line, not the friendly ones.
  assert.equal(mapActivity({ ts: 5, kind: "info", text: "Gemini state: PROCESSING" }).technical, true);
  assert.equal(mapActivity({ ts: 1, kind: "info", text: "Analysis started" }).technical, false);
});

test("Gemini connection failures map to a friendly network kind", () => {
  assert.equal(
    classifyError("14 UNAVAILABLE: No connection established. Last error: Failed to connect (2026-07-02T18:45:39.612Z)"),
    "network_interruption"
  );
  assert.equal(classifyError("Couldn't reach the Gemini API to upload the video"), "network_interruption");
  assert.equal(classifyError("connection failed"), "network_interruption");
  // Adjacent kinds still classify correctly.
  assert.equal(classifyError("Uploading the video to Gemini timed out"), "gemini_timeout");
  assert.equal(classifyError("quota exceeded"), "gemini_quota");
});
