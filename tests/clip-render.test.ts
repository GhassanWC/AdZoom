/**
 * Clips must SURVIVE the round trip and REACH the screen.
 *
 * The bug this locks down: `ProjectDoc.clips` was written to Firestore fine, but
 * `materializeProject` — a whitelist mapper — never read it back, so the editor
 * saw `clips: undefined` forever. The panel's header (local run state) said
 * "3 smart clips generated" while the list (project state) rendered nothing.
 *
 * Two halves:
 *   1. the persisted doc must materialize its clips (and its other top-level
 *      fields — the same mapper was quietly dropping six of them)
 *   2. whatever comes back must be renderable: a clip missing optional fields
 *      still becomes a card, and anything genuinely un-renderable is REPORTED,
 *      never silently filtered.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { toRenderableClips, normalizeClip } from "../src/lib/clips/clip-render.ts";
import { generateClips } from "../src/lib/clips/clip-generator.ts";
import { materializeProject } from "../src/lib/firebase/materialize-project.ts";
import type { GeneratedClip } from "../src/lib/firebase/schema.ts";

const NOW = 1_700_000_000_000;

function clip(over: Partial<GeneratedClip> = {}): GeneratedClip {
  return {
    id: "c1",
    title: "A clip",
    reason: "because",
    startTime: 10,
    endTime: 40,
    duration: 30,
    score: 0.8,
    clipType: "best_hook",
    suggestedAspectRatio: "9:16",
    suggestedCaptionStyle: "clean",
    suggestedHookText: "hook",
    editOperations: [{ type: "trim", startTime: 10, endTime: 40 }],
    exportStatus: "idle",
    createdAt: NOW,
    ...over,
  };
}

/* ── The round trip (the actual bug) ─────────────────────────────────────── */

test("materializeProject reads clips BACK out of the document (the actual bug)", () => {
  // The mapper is a whitelist: a field it doesn't list reads back as undefined
  // no matter what's in Firestore. `clips` fell through exactly this gap — the
  // write landed, the read dropped it, and the panel rendered nothing.
  const stored = [clip({ id: "a" }), clip({ id: "b" }), clip({ id: "c" })];

  const p = materializeProject("p1", {
    userId: "u1",
    title: "Demo",
    duration: 180,
    status: "ready",
    clips: stored,
  });

  assert.equal(p.clips?.length, 3, "clips must survive the snapshot → ProjectDoc mapping");
  assert.deepEqual(p.clips?.map((c) => c.id), ["a", "b", "c"]);
});

test("materializeProject keeps the other top-level fields the mapper used to drop", () => {
  // Same whitelist gap, same silent failure mode: these were written but never
  // read back, so the editor saw `undefined` for all of them.
  const p = materializeProject("p1", {
    userId: "u1",
    duration: 60,
    selectedVideoType: "podcast-clip",
    visualAnalysis: { sampleRate: 1, motion: [1, 2, 3] },
    selectedPresetId: "preset-x",
    normalizedSourcePath: "users/u1/normalized/source.mp4",
    normalizedSourceKey: "gen:md5",
    normalizedAudioDropped: true,
  });

  assert.equal(p.selectedVideoType, "podcast-clip");
  assert.equal(p.visualAnalysis?.sampleRate, 1);
  assert.equal(p.selectedPresetId, "preset-x");
  assert.equal(p.normalizedSourcePath, "users/u1/normalized/source.mp4");
  assert.equal(p.normalizedSourceKey, "gen:md5");
  assert.equal(p.normalizedAudioDropped, true);
});

test("a document with no clips materializes cleanly (not an error)", () => {
  const p = materializeProject("p1", { userId: "u1", duration: 60 });
  assert.equal(p.clips, undefined);
  assert.deepEqual(toRenderableClips(p.clips), { clips: [], dropped: [] });
});

test("generated clips survive the full round trip and render as cards", () => {
  // generator → Firestore (plain JSON) → materializeProject → panel.
  // Nothing may be lost at any hop.
  const generated = generateClips({ duration: 180, selectedVideoType: "reels-shorts", now: NOW });
  assert.ok(generated.length > 0);

  const snapshot = JSON.parse(JSON.stringify({ userId: "u1", duration: 180, clips: generated }));
  const project = materializeProject("p1", snapshot);
  const { clips, dropped } = toRenderableClips(project.clips);

  assert.equal(dropped.length, 0, "a freshly generated clip must never be un-renderable");
  assert.equal(clips.length, generated.length, "every generated clip must reach the screen");
  for (const c of clips) {
    // The card's minimum contract: title, reason, range, duration, score.
    assert.ok(c.title.length > 0);
    assert.ok(c.reason.length > 0);
    assert.ok(Number.isFinite(c.startTime) && Number.isFinite(c.endTime));
    assert.equal(c.duration, c.endTime - c.startTime);
    assert.ok(c.score >= 0 && c.score <= 1);
  }
});

/* ── Defensive rendering ─────────────────────────────────────────────────── */

test("a clip missing every optional field still renders", () => {
  // The bare minimum a clip can be: a window. Everything else is defaulted.
  const bare = normalizeClip({ startTime: 10, endTime: 40 } as Partial<GeneratedClip>, 0);
  assert.ok(bare, "a clip with a valid window must never be dropped");
  assert.equal(bare.startTime, 10);
  assert.equal(bare.endTime, 40);
  assert.equal(bare.duration, 30);
  assert.equal(bare.score, 0.5);
  assert.equal(bare.clipType, "best_hook");
  assert.equal(bare.exportStatus, "idle");
  assert.equal(bare.suggestedAspectRatio, "9:16");
  assert.equal(bare.suggestedCaptionStyle, "clean");
  assert.ok(bare.title.length > 0, "a card needs a title");
  assert.ok(bare.reason.length > 0, "a card needs a reason");
  assert.ok(bare.id.length > 0);
  // Always exportable: the trim is synthesized if it's missing.
  assert.deepEqual(bare.editOperations, [{ type: "trim", startTime: 10, endTime: 40 }]);
});

test("out-of-range enums fall back instead of crashing the card", () => {
  // An unknown clipType used to index CLIP_TYPE_META to undefined and throw on
  // `meta.accent`, blanking the whole panel.
  const weird = normalizeClip(
    {
      startTime: 0,
      endTime: 20,
      clipType: "vibes" as never,
      exportStatus: "exploded" as never,
      suggestedAspectRatio: "3:2" as never,
      suggestedCaptionStyle: "neon" as never,
      score: 42,
    },
    0
  );
  assert.ok(weird);
  assert.equal(weird.clipType, "best_hook");
  assert.equal(weird.exportStatus, "idle");
  assert.equal(weird.suggestedAspectRatio, "9:16");
  assert.equal(weird.suggestedCaptionStyle, "clean");
  assert.equal(weird.score, 1, "score is clamped, not passed through");
});

test("a window is recovered from start + duration, or end + duration", () => {
  const fromStart = normalizeClip({ startTime: 10, duration: 30 } as Partial<GeneratedClip>, 0);
  assert.deepEqual(
    [fromStart?.startTime, fromStart?.endTime],
    [10, 40],
    "start + duration is a usable window"
  );

  const fromEnd = normalizeClip({ endTime: 40, duration: 30 } as Partial<GeneratedClip>, 0);
  assert.deepEqual([fromEnd?.startTime, fromEnd?.endTime], [10, 40]);
});

test("duration is always recomputed, so it can't disagree with the range", () => {
  const lying = normalizeClip(clip({ startTime: 10, endTime: 40, duration: 999 }), 0);
  assert.equal(lying?.duration, 30);
});

test("export records are preserved through normalization", () => {
  const done = normalizeClip(
    clip({
      exportStatus: "completed",
      exportUrl: "https://cdn.example/c.mp4",
      exportSettingsHash: "h1",
      exportSourceFingerprint: "fp1",
    }),
    0
  );
  assert.equal(done?.exportStatus, "completed");
  assert.equal(done?.exportUrl, "https://cdn.example/c.mp4");
  assert.equal(done?.exportSettingsHash, "h1");
});

/* ── Nothing is filtered out silently ───────────────────────────────────── */

test("un-renderable clips are REPORTED, and never take the good ones down with them", () => {
  const stored = [
    clip({ id: "good1", startTime: 0, endTime: 20 }),
    { id: "broken", title: "no window" }, // nothing to seek to, open or export
    null,
    clip({ id: "good2", startTime: 30, endTime: 60 }),
  ];

  const { clips, dropped } = toRenderableClips(stored);

  assert.deepEqual(clips.map((c) => c.id), ["good1", "good2"], "good clips still render");
  assert.equal(dropped.length, 2);
  assert.deepEqual(dropped.map((d) => d.id), ["broken", "#3"]);
  for (const d of dropped) assert.ok(d.reason.length > 0, "a dropped clip must say why");

  // The invariant the panel relies on to prove nothing vanished.
  assert.equal(clips.length + dropped.length, stored.length);
});

test("an empty or absent clip list is not an error", () => {
  assert.deepEqual(toRenderableClips(undefined), { clips: [], dropped: [] });
  assert.deepEqual(toRenderableClips([]), { clips: [], dropped: [] });
  assert.deepEqual(toRenderableClips(null), { clips: [], dropped: [] });
});
