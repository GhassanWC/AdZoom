/**
 * Edit-acceptance telemetry — the outcome diff + the counts-only privacy rule.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { DetectedMoment, EffectType } from "@/lib/firebase/schema";
import {
  buildEditsGeneratedMetadata,
  computeEditOutcomes,
  confidenceBucket,
} from "@/lib/editorial/telemetry";
import { contextFromSelectedVideoType } from "@/lib/editorial/context";
import { resolveEditorialPolicy } from "@/lib/editorial/resolve";
import { TALKING_CLEAN_PRO } from "@/lib/editorial/templates";

function m(
  over: Partial<DetectedMoment> & { id: string }
): DetectedMoment {
  return {
    startTime: 10,
    endTime: 12,
    label: "Zoom on the pricing button",
    reason: "The user clicked here",
    focusRegion: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
    effectType: "zoom" as EffectType,
    confidenceScore: 0.8,
    source: "ai",
    provenance: "cv",
    ...over,
  } as DetectedMoment;
}

/* ── The diff ────────────────────────────────────────────────────────────── */

test("outcomes derive from the generation-vs-final diff", () => {
  const generated = [
    m({ id: "kept" }),
    m({ id: "moved", startTime: 20, endTime: 22 }),
    m({ id: "off", startTime: 30, endTime: 32 }),
    m({ id: "gone", startTime: 40, endTime: 42 }),
    m({ id: "flagged-edited", startTime: 50, endTime: 52 }),
  ];
  const final = [
    m({ id: "kept" }),
    m({ id: "moved", startTime: 21.5, endTime: 23.5 }), // dragged → modified
    m({ id: "off", startTime: 30, endTime: 32, enabled: false }), // disabled
    // "gone" deleted
    m({ id: "flagged-edited", startTime: 50, endTime: 52, edited: true }), // modified
    m({ id: "mine", source: "user", provenance: "user" }), // user-added
  ];
  const r = computeEditOutcomes(generated, final);
  assert.equal(r.totals.generated, 5);
  assert.equal(r.totals.kept, 1);
  assert.equal(r.totals.modified, 2);
  assert.equal(r.totals.disabled, 1);
  assert.equal(r.totals.deleted, 1);
  assert.equal(r.userAdded, 1);
  assert.equal(r.byType.zoom?.generated, 5);
  assert.equal(r.byType.zoom?.kept, 1);
});

test("user-authored moments in the generation snapshot are never attributed", () => {
  const generated = [m({ id: "u", source: "user", provenance: "user" })];
  const r = computeEditOutcomes(generated, []);
  assert.equal(r.totals.generated, 0);
});

test("cursor emphasis and zoom are counted as separate categories", () => {
  const generated = [
    m({ id: "z" }),
    m({ id: "c", effectType: "click-highlight" as EffectType }),
    m({ id: "f", effectType: "cursor-focus" as EffectType }),
  ];
  const r = computeEditOutcomes(generated, generated);
  assert.equal(r.byType.zoom?.generated, 1);
  assert.equal(r.byType.cursor_emphasis?.generated, 2);
});

test("confidence buckets are stable enums", () => {
  assert.equal(confidenceBucket(undefined), "none");
  assert.equal(confidenceBucket(0.2), "lt50");
  assert.equal(confidenceBucket(0.5), "b50to70");
  assert.equal(confidenceBucket(0.7), "b70to90");
  assert.equal(confidenceBucket(0.9), "gte90");
});

/* ── The privacy contract: counts + enums ONLY ───────────────────────────── */

const ALLOWED_STRINGS = new Set([
  // policy modes + intents + modes + targets + buckets — the enum universe.
  "classic", "enforce",
  "tutorial", "demo", "promo", "conversation", "story", "unknown",
  "screen", "camera", "slides", "gameplay", "other", "mixed",
  "tiktok", "reels", "shorts", "youtube", "linkedin", "x", "internal",
  "lt50", "b50to70", "b70to90", "gte90", "none",
  "lte60", "lte300", "lte900", "gt900",
]);

function assertCountsOnly(value: unknown, path: string): void {
  if (value == null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    assert.ok(
      ALLOWED_STRINGS.has(value) || /^[a-z0-9-]{1,40}$/.test(value),
      `free text leaked into telemetry at ${path}: "${value}"`
    );
    return;
  }
  assert.ok(typeof value === "object", `unexpected ${typeof value} at ${path}`);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertCountsOnly(v, `${path}.${k}`);
  }
}

test("edits_generated metadata carries no user text — even when moments do", () => {
  const policy = resolveEditorialPolicy({
    profile: contextFromSelectedVideoType("talking-head"),
    template: TALKING_CLEAN_PRO,
    signals: {
      hasTranscript: true,
      hasAudioAnalysis: true,
      hasUsableSpeech: true,
      silenceSegmentCount: 3,
      hasSceneData: true,
      hasVisualMoments: true,
      hasInteractionData: false,
      isScreenRecording: false,
    },
  });
  const moments = [
    m({ id: "a", label: "SECRET transcript sentence", reason: "user said something private" }),
    m({ id: "b", effectType: "hook-text" as EffectType, label: "My hook line" }),
  ];
  const meta = buildEditsGeneratedMetadata({
    policy,
    profile: contextFromSelectedVideoType("talking-head"),
    finalMoments: moments,
    selectionDropped: 4,
    compositionDisabled: 1,
    durationSeconds: 120,
  });
  assertCountsOnly(meta, "meta");
  const json = JSON.stringify(meta);
  assert.ok(!json.includes("SECRET"), "labels must never reach telemetry");
  assert.ok(!json.includes("private"), "reasons must never reach telemetry");
  assert.equal(meta.totalGenerated, 2);
  assert.equal(meta.countsByType.zoom, 1);
  assert.equal(meta.countsByType.hook_text, 1);
  assert.equal(meta.durationBucket, "lte300");
  assert.deepEqual(meta.gateDrops, { selection: 4, composition: 1 });
});
