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
} from "../src/lib/export/batch-capacity.ts";

test("maxActiveBatchJobs: default is 2 when no env var is set", () => {
  assert.equal(maxActiveBatchJobs({}), 2);
  assert.equal(DEFAULT_MAX_ACTIVE_BATCH_JOBS, 2);
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
  assert.equal(maxActiveBatchJobs({ EXPORT_MAX_ACTIVE_BATCH_JOBS: "" }), 2);
  assert.equal(maxActiveBatchJobs({ EXPORT_MAX_ACTIVE_BATCH_JOBS: "abc" }), 2);
  assert.equal(maxActiveBatchJobs({ EXPORT_MAX_ACTIVE_BATCH_JOBS: "0" }), 2);
  assert.equal(maxActiveBatchJobs({ EXPORT_MAX_ACTIVE_BATCH_JOBS: "-2" }), 2);
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
