/**
 * Unit tests for planChunking — the single-vs-chunked decision + chunk math + the
 * fail-closed effect-type allowlist. Pure module (no `@/` runtime / server-only),
 * so it imports cleanly under `node --test`.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  planChunking,
  chunkingEnabled,
  summarizeTimelineForChunking,
  type ChunkPlanInput,
  type ChunkTimelineSummary,
} from "../src/lib/export/chunk-plan.ts";

const ON = { EXPORT_CHUNKED_RENDER: "1" } as Record<string, string | undefined>;

/** A linear (no cuts/speed) timeline summary — the default for most cases. */
function linearTimeline(over: Partial<ChunkTimelineSummary> = {}): ChunkTimelineSummary {
  return {
    hasCuts: false,
    hasSpeed: false,
    hasMusic: false,
    hasAnimations: false,
    unsupportedEffects: [],
    ...over,
  };
}

function base(over: Partial<ChunkPlanInput> = {}): ChunkPlanInput {
  return {
    outputDurationSeconds: 420, // 7 min
    format: "mp4",
    plan: "pro",
    timeline: linearTimeline(),
    env: ON,
    ...over,
  };
}

test("kill switch: chunking OFF unless EXPORT_CHUNKED_RENDER is 1/true", () => {
  assert.equal(chunkingEnabled({}), false);
  assert.equal(chunkingEnabled({ EXPORT_CHUNKED_RENDER: "0" }), false);
  assert.equal(chunkingEnabled({ EXPORT_CHUNKED_RENDER: "1" }), true);
  assert.equal(chunkingEnabled({ EXPORT_CHUNKED_RENDER: "true" }), true);
  assert.equal(planChunking(base({ env: {} })).renderMode, "single");
  assert.equal(planChunking(base({ env: { EXPORT_CHUNKED_RENDER: "0" } })).reason, "kill_switch_off");
});

test("7-min linear MP4 (pro) → chunked, sharded across 6 workers", () => {
  const p = planChunking(base());
  assert.equal(p.renderMode, "chunked");
  assert.equal(p.chunkSeconds, 15);
  assert.equal(p.chunkCount, 28); // ceil(420/15) — TOTAL chunks
  assert.equal(p.workerCount, 6); // pro WORKER cap (Batch tasks), NOT chunkCount
});

test("SHARDING: 24-chunk export uses few workers, not one task per chunk", () => {
  // 360s / 15s = 24 chunks. Acceptance criterion #1.
  const pro = planChunking(base({ outputDurationSeconds: 360, plan: "pro" }));
  assert.equal(pro.chunkCount, 24);
  assert.equal(pro.workerCount, 6); // 6 Batch tasks, NOT 24
  const creator = planChunking(base({ outputDurationSeconds: 360, plan: "creator" }));
  assert.equal(creator.chunkCount, 24);
  assert.equal(creator.workerCount, 8); // 8 Batch tasks, NOT 24
});

test("worker count is capped by chunkCount (tiny videos)", () => {
  // 60s / 15s = 4 chunks → min(8, 4) = 4 workers (min-duration overridden for the test)
  const env = { EXPORT_CHUNKED_RENDER: "1", EXPORT_CHUNK_MIN_VIDEO_SECONDS: "30" } as Record<
    string,
    string | undefined
  >;
  const p = planChunking(base({ plan: "creator", outputDurationSeconds: 60, env }));
  assert.equal(p.chunkCount, 4);
  assert.equal(p.workerCount, 4);
});

test("short videos fall back to single", () => {
  assert.equal(planChunking(base({ outputDurationSeconds: 359 })).renderMode, "single");
  assert.equal(planChunking(base({ outputDurationSeconds: 359 })).reason, "too_short");
  assert.equal(planChunking(base({ outputDurationSeconds: 360 })).renderMode, "chunked"); // boundary inclusive
});

// ── Timeline-aware: cuts + speed are now CHUNKABLE (was nonlinear → single). ──
test("cuts-only timeline → chunked", () => {
  const p = planChunking(base({ timeline: linearTimeline({ hasCuts: true }) }));
  assert.equal(p.renderMode, "chunked");
  assert.equal(p.reason, "eligible");
});

test("speed-only timeline → chunked", () => {
  const p = planChunking(base({ timeline: linearTimeline({ hasSpeed: true }) }));
  assert.equal(p.renderMode, "chunked");
});

test("cuts + speed timeline → chunked", () => {
  const p = planChunking(base({ timeline: linearTimeline({ hasCuts: true, hasSpeed: true }) }));
  assert.equal(p.renderMode, "chunked");
});

test("music + animations → chunked (handled by global audio + deterministic effects)", () => {
  const p = planChunking(base({ timeline: linearTimeline({ hasMusic: true, hasAnimations: true }) }));
  assert.equal(p.renderMode, "chunked");
});

test("FAIL-CLOSED: an unsupported effect type forces single render", () => {
  const p = planChunking(base({ timeline: linearTimeline({ unsupportedEffects: ["green-screen"] }) }));
  assert.equal(p.renderMode, "single");
  assert.equal(p.reason, "unsupported_effects");
});

test("non-mp4 and free plan fall back to single", () => {
  assert.equal(planChunking(base({ format: "webm" })).reason, "not_mp4");
  assert.equal(planChunking(base({ plan: "free" })).reason, "plan_no_cloud");
});

test("max total chunks cap: count never exceeds cap, no empty trailing chunk", () => {
  // 3960s / 15s = 264 chunks > 80 cap → grow chunkSeconds to keep count <= 80.
  const p = planChunking(base({ outputDurationSeconds: 3960, plan: "creator" }));
  assert.equal(p.renderMode, "chunked");
  assert.ok(p.chunkCount <= 80, `chunkCount ${p.chunkCount} should be <= 80`);
  assert.equal(p.chunkCount, Math.ceil(3960 / p.chunkSeconds));
  assert.ok((p.chunkCount - 1) * p.chunkSeconds < 3960);
  assert.ok(p.workerCount <= 8, "worker count never exceeds the creator cap");
});

test("custom env overrides are honored", () => {
  const env = {
    EXPORT_CHUNKED_RENDER: "1",
    EXPORT_CHUNK_MIN_VIDEO_SECONDS: "120",
    EXPORT_CHUNK_SECONDS: "60",
    EXPORT_CHUNK_MAX_PARALLEL_PRO: "3",
  } as Record<string, string | undefined>;
  const p = planChunking(base({ outputDurationSeconds: 300, env }));
  assert.equal(p.renderMode, "chunked");
  assert.equal(p.chunkSeconds, 60);
  assert.equal(p.chunkCount, 5); // ceil(300/60)
  assert.equal(p.workerCount, 3); // EXPORT_CHUNK_MAX_PARALLEL_PRO = worker cap
});

test("invalid duration → single", () => {
  assert.equal(planChunking(base({ outputDurationSeconds: 0 })).renderMode, "single");
  assert.equal(planChunking(base({ outputDurationSeconds: NaN })).reason, "invalid_duration");
});

// ── summarizeTimelineForChunking: the allowlist classifier. ──────────────────
test("summarize: linear timeline → no flags, empty unsupported", () => {
  const s = summarizeTimelineForChunking([
    { effectType: "zoom" },
    { effectType: "click-highlight" },
  ] as never);
  assert.deepEqual(s, {
    hasCuts: false,
    hasSpeed: false,
    hasMusic: false,
    hasAnimations: false,
    unsupportedEffects: [],
  });
});

test("summarize: active cut sets hasCuts; restored cut does not", () => {
  assert.equal(
    summarizeTimelineForChunking([{ effectType: "cut", cut: { active: true } }] as never).hasCuts,
    true
  );
  assert.equal(
    summarizeTimelineForChunking([{ effectType: "cut", cut: { active: false } }] as never).hasCuts,
    false
  );
  // The `cut` TYPE is never "unsupported" regardless of active state.
  assert.deepEqual(
    summarizeTimelineForChunking([{ effectType: "cut", cut: { active: false } }] as never)
      .unsupportedEffects,
    []
  );
});

test("summarize: speed (type based) + keyframe animation flags", () => {
  const s = summarizeTimelineForChunking([
    { effectType: "speed-up", speed: { multiplier: 1, audioMode: "mute", transition: "cut" } },
    { effectType: "zoom", keyframes: [{ t: 0, x: 0.5, y: 0.5, scale: 0.5 }] },
  ] as never);
  assert.equal(s.hasSpeed, true);
  assert.equal(s.hasAnimations, true);
  assert.deepEqual(s.unsupportedEffects, []);
});

test("summarize: unknown effect type lands in unsupportedEffects (deduped, sorted)", () => {
  const s = summarizeTimelineForChunking([
    { effectType: "transition" },
    { effectType: "green-screen" },
    { effectType: "transition" },
    { effectType: "zoom" },
  ] as never);
  assert.deepEqual(s.unsupportedEffects, ["green-screen", "transition"]);
});
