/**
 * Smart Clip EDITS — the contract that makes a clip more than a time range.
 *
 * These lock down the invariants the feature depends on:
 *   • opening/previewing a clip NEVER mutates the main timeline
 *   • a clip export = clip edits + range cuts (+ its aspect)
 *   • the full-video export is byte-identical to before clips existed
 *   • aspect / hook / caption-style overrides are scoped to the clip ONLY
 *   • export status + duplicate-export prevention behave correctly
 *
 * Run with:  npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildClipEditMoments,
  applyClipCaptionStyle,
  clipPreviewMoments,
  clipExportMoments,
  clipEffects,
  applyClipEditsToTimeline,
  isClipEditMoment,
  withoutClipEditMoments,
} from "../src/lib/clips/clip-edits.ts";
import {
  decideClipExport,
  isDuplicateClipExport,
  withClipExportEvent,
  replaceClip,
  stableHash,
  isClipExportActive,
} from "../src/lib/clips/clip-export-status.ts";
import { buildTimelineMap } from "../src/lib/timeline/crop-speed.ts";
import type {
  DetectedMoment,
  EffectsSettings,
  GeneratedClip,
} from "../src/lib/firebase/schema.ts";

const NOW = 1_700_000_000_000;
const SOURCE_DURATION = 200;

function clip(over: Partial<GeneratedClip> = {}): GeneratedClip {
  return {
    id: "clip_a",
    title: "Hook — the good part",
    reason: "High attention",
    startTime: 40,
    endTime: 80,
    duration: 40,
    score: 0.8,
    clipType: "best_hook",
    suggestedAspectRatio: "9:16",
    suggestedCaptionStyle: "bold_social",
    suggestedHookText: "Watch this",
    editOperations: [
      { type: "trim", startTime: 40, endTime: 80 },
      { type: "smart-crop", startTime: 40, endTime: 80, params: { aspect: "9:16" } },
      { type: "hook-text", startTime: 40, endTime: 43, params: { text: "Watch this" } },
      { type: "captions", startTime: 40, endTime: 80, params: { stylePreset: "bold_social" } },
      {
        type: "zoom",
        startTime: 50,
        endTime: 53,
        params: { focusRegion: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 }, intensity: 0.8 },
      },
    ],
    exportStatus: "idle",
    createdAt: NOW,
    ...over,
  };
}

function moment(over: Partial<DetectedMoment> & { id: string }): DetectedMoment {
  return {
    startTime: 0,
    endTime: 5,
    label: "m",
    reason: "r",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType: "zoom",
    ...over,
  };
}

/** A timeline with a caption INSIDE the clip and one OUTSIDE it. */
function baseTimeline(): DetectedMoment[] {
  return [
    moment({ id: "z1", startTime: 10, endTime: 14, effectType: "zoom" }),
    moment({
      id: "capIn",
      startTime: 50,
      endTime: 55,
      effectType: "captions",
      captions: { text: "inside", stylePreset: "clean", position: "bottom" },
    }),
    moment({
      id: "capOut",
      startTime: 120,
      endTime: 125,
      effectType: "captions",
      captions: { text: "outside", stylePreset: "clean", position: "bottom" },
    }),
  ];
}

const BASE_EFFECTS = {
  autoZoom: 0.5,
  zoomSpeed: 0.5,
  pacing: "moderate",
  clickHighlights: true,
} as unknown as EffectsSettings;

// ── 1. Opening / previewing a clip must not mutate the main timeline ─────────

test("clip preview does NOT mutate the base timeline (no in-place writes)", () => {
  const base = baseTimeline();
  const snapshot = structuredClone(base);
  const c = clip();

  const preview = clipPreviewMoments(base, c);

  // The base array + every moment object is byte-identical afterwards.
  assert.deepEqual(base, snapshot, "base timeline was mutated");
  // And the preview is a DIFFERENT array (an override, not the same list).
  assert.notEqual(preview, base);
  // The untouched moments are passed through BY REFERENCE (cheap, no churn).
  assert.equal(preview.find((m) => m.id === "z1"), base.find((m) => m.id === "z1"));
});

test("clip preview does NOT mutate the base effects", () => {
  const c = clip();
  const snapshot = structuredClone(BASE_EFFECTS);
  const eff = clipEffects(BASE_EFFECTS, c, 1920, 1080);
  assert.deepEqual(BASE_EFFECTS, snapshot, "base effects were mutated");
  assert.notEqual(eff, BASE_EFFECTS);
});

// ── 2. The clip's edit operations actually become renderable moments ─────────

test("editOperations materialize into real moments (hook text, zoom)", () => {
  const edits = buildClipEditMoments(clip());
  const hook = edits.find((m) => m.effectType === "hook-text");
  const zoom = edits.find((m) => m.effectType === "zoom");

  assert.ok(hook, "hook-text moment missing");
  assert.equal(hook!.hookText?.text, "Watch this");
  assert.ok(zoom, "zoom moment missing");
  assert.equal(zoom!.focusRegion.width, 0.5);
  // Every synthesized moment is tagged + confined to the clip window.
  for (const m of edits) {
    assert.ok(isClipEditMoment(m), `${m.id} not tagged as a clip edit`);
    assert.ok(m.startTime >= 40 - 1e-9 && m.endTime <= 80 + 1e-9, "edit leaked outside the clip");
  }
});

test("clip edits never leak outside the clip window (ops are clamped)", () => {
  const c = clip({
    editOperations: [
      // Deliberately out-of-range op.
      { type: "hook-text", startTime: 0, endTime: 200, params: { text: "x" } },
    ],
  });
  const edits = buildClipEditMoments(c);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].startTime, 40);
  assert.equal(edits[0].endTime, 80);
});

// ── 3. Caption-style override is scoped to the clip only ────────────────────

test("caption style override affects captions INSIDE the clip only", () => {
  const base = baseTimeline();
  const preview = clipPreviewMoments(base, clip());

  const inside = preview.find((m) => m.id === "capIn")!;
  const outside = preview.find((m) => m.id === "capOut")!;

  assert.equal(inside.captions?.stylePreset, "bold_social", "inside caption not restyled");
  assert.equal(outside.captions?.stylePreset, "clean", "outside caption was restyled");
  // The base objects are untouched.
  assert.equal(base.find((m) => m.id === "capIn")!.captions?.stylePreset, "clean");
});

// ── 4. Aspect override is scoped to the clip only ────────────────────────────

test("aspect ratio override applies to the clip's effects, not the project's", () => {
  const eff = clipEffects(BASE_EFFECTS, clip({ suggestedAspectRatio: "9:16" }), 1920, 1080);
  assert.equal(eff.outputCanvas?.aspectRatio, "9:16");
  assert.equal(eff.outputCanvas?.width, 1080);
  assert.equal(eff.outputCanvas?.height, 1920);
  // The project's own effects still have NO canvas → full-video export unchanged.
  assert.equal(BASE_EFFECTS.outputCanvas, undefined);
});

// ── 5. Clip export = clip edits + range cuts; full export is unchanged ───────

test("clip export uses range cuts AND carries the clip's edits", () => {
  const base = baseTimeline();
  const c = clip();
  const exported = clipExportMoments(base, c, SOURCE_DURATION);

  // Range cuts carve exactly [40,80].
  const cuts = exported.filter((m) => m.effectType === "cut");
  assert.equal(cuts.length, 2);
  const map = buildTimelineMap(exported, SOURCE_DURATION);
  assert.ok(Math.abs(map.outputDuration - 40) < 0.01, `output ${map.outputDuration} != 40`);

  // The smart edits rode along.
  assert.ok(exported.some((m) => m.effectType === "hook-text"));
  assert.ok(exported.some((m) => isClipEditMoment(m) && m.effectType === "zoom"));
  assert.equal(exported.find((m) => m.id === "capIn")!.captions?.stylePreset, "bold_social");
});

test("FULL-video export is unchanged by the existence of clips", () => {
  const base = baseTimeline();
  const snapshot = structuredClone(base);

  // The full export path passes the project's moments straight through — it
  // never calls the clip helpers. Nothing about them alters the base list.
  clipPreviewMoments(base, clip());
  clipExportMoments(base, clip(), SOURCE_DURATION);
  clipEffects(BASE_EFFECTS, clip(), 1920, 1080);

  assert.deepEqual(base, snapshot);
  const fullMap = buildTimelineMap(base, SOURCE_DURATION);
  assert.equal(fullMap.outputDuration, SOURCE_DURATION, "full video no longer renders in full");
  assert.equal(base.filter((m) => m.effectType === "cut").length, 0, "cuts leaked into the timeline");
});

// ── 6. Apply-to-timeline is the ONLY mutation path ───────────────────────────

test("applyClipEditsToTimeline bakes the edits in as user-owned moments (no cuts)", () => {
  const base = baseTimeline();
  const snapshot = structuredClone(base);
  const applied = applyClipEditsToTimeline(base, clip());

  // Still non-mutating — it RETURNS the new list for the caller to commit.
  assert.deepEqual(base, snapshot);

  // Edits are present, owned by the user (so they're editable/undoable)…
  const hook = applied.find((m) => m.effectType === "hook-text")!;
  assert.equal(hook.source, "user");
  assert.equal(hook.edited, true);
  // …and the full video stays full: no range cuts are committed.
  assert.equal(applied.filter((m) => m.effectType === "cut").length, 0);
  assert.equal(buildTimelineMap(applied, SOURCE_DURATION).outputDuration, SOURCE_DURATION);
});

test("re-applying a clip replaces its edits instead of stacking duplicates", () => {
  const base = baseTimeline();
  const once = applyClipEditsToTimeline(base, clip());
  const twice = applyClipEditsToTimeline(once, clip());
  const count = (ms: DetectedMoment[]) => ms.filter((m) => m.effectType === "hook-text").length;
  assert.equal(count(once), 1);
  assert.equal(count(twice), 1, "clip edits stacked on re-apply");
  assert.equal(withoutClipEditMoments(twice).length, base.length);
});

// ── 7. Export status tracking ────────────────────────────────────────────────

test("exportStatus transitions queued → rendering → completed", () => {
  const id = { sourceFingerprint: "src1", settingsHash: "h1" };
  let c = clip();
  assert.equal(c.exportStatus, "idle");

  c = withClipExportEvent(c, { status: "queued", jobId: "job1", identity: id, now: NOW });
  assert.equal(c.exportStatus, "queued");
  assert.equal(c.exportJobId, "job1");
  assert.equal(c.exportSettingsHash, "h1");
  assert.ok(isClipExportActive(c));

  c = withClipExportEvent(c, { status: "rendering", now: NOW });
  assert.equal(c.exportStatus, "rendering");
  assert.ok(isClipExportActive(c));

  c = withClipExportEvent(c, { status: "completed", url: "https://x/clip.mp4", now: NOW });
  assert.equal(c.exportStatus, "completed");
  assert.equal(c.exportUrl, "https://x/clip.mp4");
  assert.equal(c.exportError, undefined);
  assert.ok(!isClipExportActive(c));
});

test("a failed export records the error and drops any stale URL", () => {
  const c0 = withClipExportEvent(clip(), {
    status: "completed",
    url: "https://x/old.mp4",
    now: NOW,
  });
  const c1 = withClipExportEvent(c0, { status: "failed", error: "Render crashed", now: NOW });
  assert.equal(c1.exportStatus, "failed");
  assert.equal(c1.exportError, "Render crashed");
  assert.equal(c1.exportUrl, undefined, "stale download URL survived a failure");
});

test("clip export status is independent per clip", () => {
  const a = clip({ id: "a" });
  const b = clip({ id: "b" });
  const done = withClipExportEvent(a, { status: "completed", url: "u", now: NOW });
  const list = replaceClip([a, b], done);
  assert.equal(list.find((c) => c.id === "a")!.exportStatus, "completed");
  assert.equal(list.find((c) => c.id === "b")!.exportStatus, "idle", "sibling clip was affected");
});

// ── 8. Duplicate-export prevention ──────────────────────────────────────────

test("duplicate clip export is prevented (same clip + source + settings)", () => {
  const id = { sourceFingerprint: "src1", settingsHash: "h1" };
  const exported = withClipExportEvent(clip(), {
    status: "completed",
    url: "https://x/clip.mp4",
    identity: id,
    now: NOW,
  });

  assert.ok(isDuplicateClipExport(exported, id));
  const decision = decideClipExport(exported, id);
  assert.equal(decision.kind, "reuse");
  assert.equal(decision.kind === "reuse" && decision.url, "https://x/clip.mp4");
});

test("re-export is allowed when the user forces it, or when settings/source change", () => {
  const id = { sourceFingerprint: "src1", settingsHash: "h1" };
  const exported = withClipExportEvent(clip(), {
    status: "completed",
    url: "u",
    identity: id,
    now: NOW,
  });

  // Explicit "Re-export anyway".
  assert.equal(decideClipExport(exported, id, { force: true }).kind, "start");
  // Different settings (e.g. resolution changed) → genuinely new render.
  assert.equal(
    decideClipExport(exported, { ...id, settingsHash: "h2" }).kind,
    "start"
  );
  // Source re-uploaded → new render.
  assert.equal(
    decideClipExport(exported, { ...id, sourceFingerprint: "src2" }).kind,
    "start"
  );
});

test("a clip already rendering is blocked from starting a second job", () => {
  const id = { sourceFingerprint: "src1", settingsHash: "h1" };
  const inFlight = withClipExportEvent(clip(), { status: "rendering", now: NOW });
  assert.equal(decideClipExport(inFlight, id).kind, "blocked");
  // Even forcing cannot double-submit a genuinely in-flight clip.
  assert.equal(
    decideClipExport(inFlight, id, { force: true, liveActive: true }).kind,
    "blocked"
  );
});

test("a STALE 'rendering' status does not permanently block the clip", () => {
  // The dialog was closed mid-render, so nothing wrote the terminal status —
  // the clip is stuck at "rendering" even though nothing is running. The LIVE
  // signal must win, or this clip could never be exported again.
  const id = { sourceFingerprint: "src1", settingsHash: "h1" };
  const stale = withClipExportEvent(clip(), { status: "rendering", now: NOW });
  assert.equal(decideClipExport(stale, id, { liveActive: false }).kind, "start");
});

test("stableHash is deterministic and key-order independent", () => {
  assert.equal(stableHash({ a: 1, b: [1, 2] }), stableHash({ b: [1, 2], a: 1 }));
  assert.notEqual(stableHash({ a: 1 }), stableHash({ a: 2 }));
});
