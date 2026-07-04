/**
 * Captions-vs-AI-edits SEPARATION — the structural rules that make captions an
 * independent transcription feature: their own dialog section, their own
 * state machine (never the main analysis status), their own timeline lane,
 * their own quota, and an export path that renders-but-never-creates them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AI_EDIT_GROUPS,
  AI_EDIT_TOGGLE_KEYS,
  AI_EDIT_EXTRA_KEYS,
  CAPTIONS_TOGGLE,
} from "@/lib/analysis/analyze-dialog-config";
import {
  CAPTION_STATE_LABEL,
  resolveCaptionState,
} from "@/lib/analysis/caption-state";
import {
  recipeGenerationDefaults,
  resolveInitialGenerationToggles,
  GENERATION_TOGGLE_KEYS,
} from "@/lib/analysis/edit-recipe";
import {
  EFFECT_TO_LANE,
  planTimelineLanes,
} from "@/components/dashboard/real-editor/timeline/laneModel";
import { activeOverlays } from "@/lib/render/overlay-draw";
import type { DetectedMoment, Transcript } from "@/lib/firebase/schema";

/* ── Dialog structure ────────────────────────────────────────────────────── */

test("captions are NOT listed inside the generic AI-edit groups", () => {
  for (const group of AI_EDIT_GROUPS) {
    for (const item of group.items) {
      assert.notEqual(item.key, "generateCaptions", `${group.title} must not contain captions`);
    }
  }
  assert.ok(!AI_EDIT_TOGGLE_KEYS.includes("generateCaptions"));
});

test("captions have their own dedicated dialog toggle spec", () => {
  assert.equal(CAPTIONS_TOGGLE.key, "generateCaptions");
  // Every OTHER generation toggle is covered by the AI-edit groups — captions
  // is exactly the one that isn't.
  const missing = GENERATION_TOGGLE_KEYS.filter((k) => !AI_EDIT_TOGGLE_KEYS.includes(k));
  assert.deepEqual(missing, ["generateCaptions"]);
});

test("AI-edit bulk actions (Disable extras) never touch the captions toggle", () => {
  assert.ok(!AI_EDIT_EXTRA_KEYS.includes("generateCaptions"));
  // ...and extras are a subset of the AI-edit keys.
  for (const k of AI_EDIT_EXTRA_KEYS) assert.ok(AI_EDIT_TOGGLE_KEYS.includes(k));
});

/* ── Independent control ─────────────────────────────────────────────────── */

test("turning captions off does not affect any other AI edit toggle", () => {
  const recipeDefaults = recipeGenerationDefaults("auto"); // everything on
  const seeded = resolveInitialGenerationToggles({
    recipeDefaults,
    lastRun: { generateCaptions: false },
  });
  assert.equal(seeded.generateCaptions, false);
  for (const k of AI_EDIT_TOGGLE_KEYS) {
    assert.equal(seeded[k], true, `${k} must stay on when captions are off`);
  }
});

test("re-analyze preserves the caption preference separately from other options", () => {
  // The recipe recommends captions ON; the user's last run turned them off
  // while keeping cuts off too — each is preserved independently.
  const seeded = resolveInitialGenerationToggles({
    recipeDefaults: recipeGenerationDefaults("auto"),
    lastRun: { generateCaptions: false, generateCut: false },
  });
  assert.equal(seeded.generateCaptions, false);
  assert.equal(seeded.generateCut, false);
  assert.equal(seeded.generateCameraEdits, true);
});

/* ── Separate state machine ──────────────────────────────────────────────── */

const T = (status: Transcript["status"], extra: Partial<Transcript> = {}): Transcript => ({
  status,
  ...extra,
});

test("caption state is derived from the transcript, never the analysis status", () => {
  // The main analysis is COMPLETE in every one of these — caption state varies
  // independently (main AI edit can finish while captions keep processing).
  assert.equal(
    resolveCaptionState({ captionsRequested: true, transcript: T("processing") }),
    "processing"
  );
  assert.equal(
    resolveCaptionState({ captionsRequested: true, transcript: T("complete") }),
    "complete"
  );
  assert.equal(
    resolveCaptionState({ captionsRequested: true, transcript: T("failed") }),
    "failed"
  );
  assert.equal(
    resolveCaptionState({ captionsRequested: true, transcript: null }),
    "not_started"
  );
});

test("captions off → disabled state regardless of any stale transcript", () => {
  assert.equal(
    resolveCaptionState({ captionsRequested: false, transcript: T("complete") }),
    "disabled"
  );
  assert.equal(resolveCaptionState({ captionsRequested: false, transcript: null }), "disabled");
});

test("quota-blocked runs resolve to blocked_by_quota (not generic unavailable)", () => {
  assert.equal(
    resolveCaptionState({
      captionsRequested: true,
      transcript: T("unavailable", { skipReason: "quota_exhausted" }),
    }),
    "blocked_by_quota"
  );
  assert.equal(
    resolveCaptionState({
      captionsRequested: true,
      transcript: T("unavailable", { skipReason: "per_video_limit" }),
    }),
    "blocked_by_quota"
  );
  // No provider configured stays a plain unavailable.
  assert.equal(
    resolveCaptionState({ captionsRequested: true, transcript: T("unavailable") }),
    "unavailable"
  );
});

test("legacy projects (no skipReason / usage fields) resolve exactly as before", () => {
  const legacy = T("complete", {
    segments: [{ id: "s", startTime: 0, endTime: 1, text: "hi" }],
    sourceFingerprint: "old|1|2",
  });
  assert.equal(resolveCaptionState({ captionsRequested: true, transcript: legacy }), "complete");
  assert.ok(CAPTION_STATE_LABEL.complete);
});

/* ── Timeline lane ───────────────────────────────────────────────────────── */

const captionMoment = (id: string, enabled?: boolean): DetectedMoment =>
  ({
    id,
    startTime: 1,
    endTime: 2,
    label: "cap",
    effectType: "captions",
    ...(enabled === undefined ? {} : { enabled }),
  }) as DetectedMoment;

test("caption moments route ONLY to the dedicated Captions lane", () => {
  assert.equal(EFFECT_TO_LANE.captions, "captions");
  const groups = planTimelineLanes([captionMoment("c1")]);
  const lanesWithCaption = groups
    .flatMap((g) => g.lanes)
    .filter((l) => l.moments.some((m) => m.id === "c1"));
  assert.equal(lanesWithCaption.length, 1);
  assert.equal(lanesWithCaption[0].def.id, "captions");
  assert.equal(lanesWithCaption[0].def.label, "Captions");
  // Existing projects with caption moments still load into the same lane.
});

/* ── Export behavior ─────────────────────────────────────────────────────── */

test("export renders ENABLED captions and skips DISABLED ones (shared gate)", () => {
  // activeOverlays is the single overlay gate shared by preview AND export.
  const on = captionMoment("on");
  const off = captionMoment("off", false);
  const { output } = activeOverlays([on, off], 1.5);
  assert.deepEqual(output.map((m) => m.id), ["on"]);
});

test("the export paths never generate captions or touch the caption ledger", () => {
  // Structural guard: the browser-export core and the cloud job creator must
  // not import the caption generator or the caption ledger — captions are
  // created ONLY during analysis (route/worker), never at export time.
  for (const file of [
    "src/components/dashboard/real-editor/export.ts",
    "src/lib/export/create-job.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.ok(!src.includes("caption-ledger"), `${file} must not touch the caption ledger`);
    assert.ok(!src.includes("generateCaptionMoments"), `${file} must not generate captions`);
    assert.ok(!src.includes("reserveCaptionSeconds"), `${file} must not reserve caption minutes`);
  }
});
