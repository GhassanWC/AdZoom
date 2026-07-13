/**
 * Smart Clips PANEL STATE — the button label/enabled rules and the status line.
 *
 * The bug this locks down: the panel used to show "Finding the best clips…"
 * followed by a bare "No clips yet", with generation hidden behind an auto-run
 * and an unlabelled refresh icon. Every state below must name what happened and
 * offer a visible, clickable way forward.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clipsButtonDisabled,
  clipsButtonLabel,
  clipsNeedsRegenerateConfirm,
  clipsShowEmptyState,
  clipsShowRetry,
  clipsSignalNote,
  clipsStatus,
  clipsUnrenderableNote,
  type ClipsPanelInput,
} from "@/components/dashboard/real-editor/clips-panel-state";
import type { ClipGenerationResult } from "@/lib/clips/clip-generation";

const base: ClipsPanelInput = {
  running: false,
  clipCount: 0,
  storedCount: 0,
  lastRun: null,
  analysisComplete: true,
};

/** Clips that rendered fine: stored and visible agree. */
const withClips = (n: number, lastRun: ClipGenerationResult | null = null): ClipsPanelInput => ({
  ...base,
  clipCount: n,
  storedCount: n,
  lastRun,
});

const generated = (count: number, fallbackUsed = false): ClipGenerationResult => ({
  status: "generated",
  count,
  fallbackUsed,
  reasonCode: fallbackUsed ? "fallback" : "ok",
  message: fallbackUsed
    ? `Could not find strong moments, so ${count} fallback clips were created`
    : `${count} smart clips generated`,
});

const failed = (error = "boom"): ClipGenerationResult => ({
  status: "failed",
  count: 0,
  fallbackUsed: false,
  reasonCode: null,
  message: "Clip generation failed",
  error,
});

const empty = (
  reasonCode: ClipGenerationResult["reasonCode"],
  message: string
): ClipGenerationResult => ({
  status: "empty",
  count: 0,
  fallbackUsed: false,
  reasonCode,
  message,
});

/* ── Button label ────────────────────────────────────────────────────────── */

test("the primary button names the action in every state", () => {
  assert.equal(clipsButtonLabel(base), "Generate Smart Clips");
  assert.equal(clipsButtonLabel({ ...base, running: true }), "Generating clips…");
  assert.equal(clipsButtonLabel({ ...base, clipCount: 5 }), "Regenerate Clips");
  assert.equal(clipsButtonLabel({ ...base, lastRun: failed() }), "Try Again");
});

test("a failure asks to retry even when clips are already on screen", () => {
  assert.equal(
    clipsButtonLabel({ ...base, clipCount: 3, lastRun: failed() }),
    "Try Again"
  );
});

test("an in-flight run outranks every other label", () => {
  assert.equal(
    clipsButtonLabel({ ...base, running: true, clipCount: 3, lastRun: failed() }),
    "Generating clips…"
  );
});

/* ── Disabled ────────────────────────────────────────────────────────────── */

test("the button is disabled ONLY while a run is actually in flight", () => {
  assert.equal(clipsButtonDisabled({ ...base, running: true }), true);

  // Every other state stays clickable — a dead button is what made this feature
  // look broken.
  assert.equal(clipsButtonDisabled(base), false);
  assert.equal(clipsButtonDisabled({ ...base, lastRun: failed() }), false);
  assert.equal(clipsButtonDisabled({ ...base, clipCount: 4 }), false);
  assert.equal(clipsButtonDisabled({ ...base, analysisComplete: false }), false);
  assert.equal(
    clipsButtonDisabled({ ...base, lastRun: empty("source_too_short", "too short") }),
    false
  );
});

/* ── Status line ─────────────────────────────────────────────────────────── */

test("before generation: the panel invites the action", () => {
  assert.deepEqual(clipsStatus(base), {
    tone: "info",
    text: "Generate short clips from this edited video.",
  });
});

test("during generation: progress, not silence", () => {
  assert.deepEqual(clipsStatus({ ...base, running: true }), {
    tone: "info",
    text: "Finding the best moments…",
  });
});

test("success: the result count", () => {
  assert.deepEqual(clipsStatus({ ...base, clipCount: 5, lastRun: generated(5) }), {
    tone: "success",
    text: "5 smart clips generated",
  });
});

test("fallback success says the clips are fallbacks", () => {
  const s = clipsStatus({ ...base, clipCount: 2, lastRun: generated(2, true) });
  assert.equal(s.tone, "success");
  assert.match(s.text, /Could not find strong moments/);
});

test("failure: names the failure and offers a retry", () => {
  const s: ClipsPanelInput = { ...base, lastRun: failed("permission-denied") };
  assert.deepEqual(clipsStatus(s), { tone: "error", text: "Clip generation failed" });
  assert.equal(clipsShowRetry(s), true);
});

test("empty: shows the generator's REAL reason, never a vague shrug", () => {
  const tooShort = clipsStatus({
    ...base,
    lastRun: empty(
      "source_too_short",
      "No clips can be generated because the video is shorter than 8 seconds."
    ),
  });
  assert.equal(tooShort.tone, "error");
  assert.equal(
    tooShort.text,
    "No clips can be generated because the video is shorter than 8 seconds."
  );

  const notAnalyzed = clipsStatus({
    ...base,
    lastRun: empty("not_analyzed", "Analyze video first to generate smart clips."),
  });
  assert.equal(notAnalyzed.text, "Analyze video first to generate smart clips.");

  // The old copy is gone for good.
  for (const s of [tooShort, notAnalyzed]) {
    assert.ok(!/no clips yet/i.test(s.text), "the vague empty state must not come back");
  }
});

test("an un-analyzed project says so up front", () => {
  assert.deepEqual(clipsStatus({ ...base, analysisComplete: false }), {
    tone: "info",
    text: "Analyze video first to generate smart clips.",
  });
});

test("clips loaded from a previous session (no run yet) get a plain count", () => {
  assert.deepEqual(clipsStatus({ ...base, clipCount: 1 }), {
    tone: "info",
    text: "1 suggested clip · shorts from this video",
  });
});

test("a busy (no-op) click falls through to the resting state", () => {
  const busy: ClipGenerationResult = {
    status: "busy",
    count: 0,
    fallbackUsed: false,
    reasonCode: null,
    message: "Clip generation is already running.",
  };
  assert.deepEqual(clipsStatus({ ...base, clipCount: 3, lastRun: busy }), {
    tone: "info",
    text: "3 suggested clips · shorts from this video",
  });
});

/* ── The count and the cards can never disagree ──────────────────────────── */

test("the header count comes from the RENDERED clips, not the last run's tally", () => {
  // The run said 5, but only 3 clips are actually on screen (say two failed to
  // normalize). The header must say 3 — the number the user can count.
  const s = clipsStatus({ ...base, clipCount: 3, storedCount: 3, lastRun: generated(5) });
  assert.equal(s.text, "3 smart clips generated");
});

test("the empty state NEVER shows while clips are on screen", () => {
  for (const lastRun of [null, generated(3), failed(), empty("source_too_short", "too short")]) {
    const s = withClips(3, lastRun);
    assert.equal(clipsShowEmptyState(s), false, `empty state leaked with lastRun=${lastRun?.status}`);
  }
});

test("saved-but-unrenderable clips are reported, not called 'no clips'", () => {
  // THE BUG: header said "3 smart clips generated", body said "No clips generated".
  // With clips saved but none rendered, the panel must name the real problem and
  // must NOT show the empty state.
  const s: ClipsPanelInput = {
    ...base,
    clipCount: 0,
    storedCount: 3,
    lastRun: generated(3),
  };

  const status = clipsStatus(s);
  assert.equal(status.tone, "error");
  assert.equal(status.text, "3 saved clips could not be displayed.");
  assert.ok(!/no clips/i.test(status.text));

  // Requirement 8: empty state only when the visible list AND project.clips are empty.
  assert.equal(clipsShowEmptyState(s), false);

  // Requirement: a filter can never hide clips without showing the reason.
  const note = clipsUnrenderableNote(s, ["no usable start/end time"]);
  assert.equal(
    note,
    "3 of 3 saved clips could not be displayed (no usable start/end time). Regenerate to rebuild them."
  );
});

test("a partial render loss is surfaced with counts", () => {
  const s: ClipsPanelInput = { ...base, clipCount: 2, storedCount: 3, lastRun: generated(3) };
  // The visible clips still lead the header…
  assert.equal(clipsStatus(s).text, "2 smart clips generated");
  // …but the missing one is never swept under the rug.
  assert.equal(
    clipsUnrenderableNote(s, ["no usable start/end time"]),
    "1 of 3 saved clips could not be displayed (no usable start/end time). Regenerate to rebuild them."
  );
});

test("nothing hidden → no note", () => {
  assert.equal(clipsUnrenderableNote(withClips(3)), null);
  assert.equal(clipsUnrenderableNote(base), null);
});

test("the empty state still shows when there is genuinely nothing", () => {
  assert.equal(
    clipsShowEmptyState({ ...base, lastRun: empty("source_too_short", "too short") }),
    true
  );
  // …but never while a run is in flight.
  assert.equal(clipsShowEmptyState({ ...base, running: true }), false);
});

/* ── Confirm + notes ─────────────────────────────────────────────────────── */

test("regenerating over an existing set needs a confirm; a first run does not", () => {
  assert.equal(clipsNeedsRegenerateConfirm({ ...base, clipCount: 3 }), true);
  assert.equal(clipsNeedsRegenerateConfirm(base), false);
  assert.equal(clipsNeedsRegenerateConfirm({ ...base, clipCount: 3, running: true }), false);
});

test("a missing transcript is explained, not treated as a blocker", () => {
  assert.equal(
    clipsSignalNote({ analysisComplete: true, transcriptAvailable: false, clipCount: 3 }),
    "No transcript available yet — these clips were scored from attention and edit density."
  );
  // Nothing to explain when the transcript is there, or when there are no clips.
  assert.equal(
    clipsSignalNote({ analysisComplete: true, transcriptAvailable: true, clipCount: 3 }),
    null
  );
  assert.equal(
    clipsSignalNote({ analysisComplete: true, transcriptAvailable: false, clipCount: 0 }),
    null
  );
});
