/**
 * Unit tests for the global active-Batch-export cap config. Pure module (no `@/`
 * runtime deps beyond a type import, no server-only), so it imports cleanly under
 * `node --test`.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  maxActiveBatchJobs,
  DEFAULT_MAX_ACTIVE_BATCH_JOBS,
  BATCH_SLOT_STATUSES,
  QUEUE_REASON_WAITING_FOR_SLOT,
  WAITING_FOR_SLOT_MESSAGE,
  clampWorkersForDiskQuota,
} from "../src/lib/export/batch-capacity.ts";

test("maxActiveBatchJobs: default is 1 when no env var is set", () => {
  assert.equal(maxActiveBatchJobs({}), 1);
  assert.equal(DEFAULT_MAX_ACTIVE_BATCH_JOBS, 1);
});

test("maxActiveBatchJobs: reads EXPORT_MAX_ACTIVE_BATCH_JOBS", () => {
  assert.equal(maxActiveBatchJobs({ EXPORT_MAX_ACTIVE_BATCH_JOBS: "3" }), 3);
  assert.equal(maxActiveBatchJobs({ EXPORT_MAX_ACTIVE_BATCH_JOBS: "7" }), 7);
});

test("maxActiveBatchJobs: EXPORT_MAX_ACTIVE_BATCH_JOBS wins over the legacy var", () => {
  assert.equal(
    maxActiveBatchJobs({
      EXPORT_MAX_ACTIVE_BATCH_JOBS: "5",
      EXPORT_MAX_ACTIVE_BATCH_EXPORTS: "9",
    }),
    5
  );
});

test("maxActiveBatchJobs: falls back to the legacy EXPORT_MAX_ACTIVE_BATCH_EXPORTS", () => {
  assert.equal(maxActiveBatchJobs({ EXPORT_MAX_ACTIVE_BATCH_EXPORTS: "4" }), 4);
});

test("maxActiveBatchJobs: invalid / non-positive values fall back to the default", () => {
  assert.equal(maxActiveBatchJobs({ EXPORT_MAX_ACTIVE_BATCH_JOBS: "" }), 1);
  assert.equal(maxActiveBatchJobs({ EXPORT_MAX_ACTIVE_BATCH_JOBS: "abc" }), 1);
  assert.equal(maxActiveBatchJobs({ EXPORT_MAX_ACTIVE_BATCH_JOBS: "0" }), 1);
  assert.equal(maxActiveBatchJobs({ EXPORT_MAX_ACTIVE_BATCH_JOBS: "-2" }), 1);
});

test("BATCH_SLOT_STATUSES = submitted/running only (queued is NOT a slot)", () => {
  // A slot is a job actually on Batch; queued jobs wait and must NOT occupy one,
  // else the queue can never drain (promotion deadlock).
  assert.deepEqual([...BATCH_SLOT_STATUSES], ["batch_submitted", "rendering", "uploading"]);
  assert.ok(!BATCH_SLOT_STATUSES.includes("queued" as never));
});

test("queue constants", () => {
  assert.equal(QUEUE_REASON_WAITING_FOR_SLOT, "waiting_for_slot");
  assert.equal(WAITING_FOR_SLOT_MESSAGE, "Waiting for cloud export slot");
});

// ── clampWorkersForDiskQuota (SSD_TOTAL_GB guard) ─────────────────────────────

test("disk guard: 8 workers × 50GB = 400GB fits under 450 → 8 (the acceptance case)", () => {
  assert.equal(clampWorkersForDiskQuota(8, 50, 450), 8);
});

test("disk guard: 8 workers × 100GB = 800GB busts 450 → floor(450/100)=4", () => {
  assert.equal(clampWorkersForDiskQuota(8, 100, 450), 4);
});

test("disk guard: fits exactly at the cap → unchanged", () => {
  assert.equal(clampWorkersForDiskQuota(9, 50, 450), 9); // 9×50 = 450
  assert.equal(clampWorkersForDiskQuota(6, 50, 450), 6); // 6×50 = 300
});

test("disk guard: never returns < 1 even when one disk exceeds the cap", () => {
  assert.equal(clampWorkersForDiskQuota(8, 600, 450), 1);
});
