/**
 * Unit tests for planChunking — the single-vs-chunked decision + chunk math.
 * Pure module (no `@/` / server-only), so it imports cleanly under `node --test`.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { planChunking, chunkingEnabled, type ChunkPlanInput } from "../src/lib/export/chunk-plan.ts";

const ON = { EXPORT_CHUNKED_RENDER: "1" } as Record<string, string | undefined>;

function base(over: Partial<ChunkPlanInput> = {}): ChunkPlanInput {
  return {
    outputDurationSeconds: 420, // 7 min
    format: "mp4",
    linear: true,
    plan: "pro",
    env: ON,
    ...over,
  };
}

test("kill switch: chunking OFF unless EXPORT_CHUNKED_RENDER is 1/true", () => {
  assert.equal(chunkingEnabled({}), false);
  assert.equal(chunkingEnabled({ EXPORT_CHUNKED_RENDER: "0" }), false);
  assert.equal(chunkingEnabled({ EXPORT_CHUNKED_RENDER: "1" }), true);
  assert.equal(chunkingEnabled({ EXPORT_CHUNKED_RENDER: "true" }), true);
  // Unset → single (default OFF in prod).
  assert.equal(planChunking(base({ env: {} })).renderMode, "single");
  assert.equal(planChunking(base({ env: { EXPORT_CHUNKED_RENDER: "0" } })).reason, "kill_switch_off");
});

test("7-min linear MP4 (pro) → chunked, 2-way parallel", () => {
  const p = planChunking(base());
  assert.equal(p.renderMode, "chunked");
  assert.equal(p.chunkSeconds, 120);
  assert.equal(p.chunkCount, 4); // ceil(420/120)
  assert.equal(p.chunkParallelism, 2); // pro cap
});

test("creator gets 4-way parallel; capped by chunkCount", () => {
  assert.equal(planChunking(base({ plan: "creator", outputDurationSeconds: 1200 })).chunkParallelism, 4);
  // chunkCount=3 (360/120) → parallelism min(4,3)=3
  assert.equal(planChunking(base({ plan: "creator", outputDurationSeconds: 360 })).chunkParallelism, 3);
});

test("short videos fall back to single", () => {
  assert.equal(planChunking(base({ outputDurationSeconds: 359 })).renderMode, "single");
  assert.equal(planChunking(base({ outputDurationSeconds: 359 })).reason, "too_short");
  assert.equal(planChunking(base({ outputDurationSeconds: 360 })).renderMode, "chunked"); // boundary inclusive
});

test("non-linear (cuts/speed) falls back to single", () => {
  assert.equal(planChunking(base({ linear: false })).renderMode, "single");
  assert.equal(planChunking(base({ linear: false })).reason, "nonlinear_timeline");
});

test("non-mp4 and free plan fall back to single", () => {
  assert.equal(planChunking(base({ format: "webm" })).reason, "not_mp4");
  assert.equal(planChunking(base({ plan: "free" })).reason, "plan_no_cloud");
});

test("max total chunks cap: count never exceeds cap, no empty trailing chunk", () => {
  // 66 min = 3960s; ceil(3960/120)=33 > 30 → grow chunkSeconds.
  const p = planChunking(base({ outputDurationSeconds: 3960, plan: "creator" }));
  assert.equal(p.renderMode, "chunked");
  assert.ok(p.chunkCount <= 30, `chunkCount ${p.chunkCount} should be <= 30`);
  // Worker derives count as ceil(dur/chunkSeconds); it must match the stored count
  // so the last index has a non-empty window.
  assert.equal(p.chunkCount, Math.ceil(3960 / p.chunkSeconds));
  // And (chunkCount-1)*chunkSeconds < dur (last chunk non-empty).
  assert.ok((p.chunkCount - 1) * p.chunkSeconds < 3960);
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
  assert.equal(p.chunkParallelism, 3);
});

test("invalid duration → single", () => {
  assert.equal(planChunking(base({ outputDurationSeconds: 0 })).renderMode, "single");
  assert.equal(planChunking(base({ outputDurationSeconds: NaN })).reason, "invalid_duration");
});
