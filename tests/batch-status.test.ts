/**
 * Unit tests for the pure Batch-status helpers: allocation-location selection and
 * classification of a Batch job's status into the terminal-bad / capacity flags
 * the reconciler acts on. Pure module (no `@/` / server-only / gRPC), so it
 * imports cleanly under `node --test`.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  batchAllowedLocations,
  classifyBatchJobStatus,
  BatchCapacityError,
  BATCH_CAPACITY_ERROR_CODE,
  BATCH_CAPACITY_ERROR_MESSAGE,
} from "../src/lib/export/batch-status.ts";

// ── batchAllowedLocations ────────────────────────────────────────────────────

test("allowedLocations: default is the WHOLE region (not a single zone)", () => {
  assert.deepEqual(batchAllowedLocations("us-central1", {}), ["regions/us-central1"]);
});

test("allowedLocations: BATCH_ALLOWED_LOCATIONS overrides with a zone subset", () => {
  const env = {
    BATCH_ALLOWED_LOCATIONS: "zones/us-central1-a,zones/us-central1-c,zones/us-central1-f",
  } as NodeJS.ProcessEnv;
  assert.deepEqual(batchAllowedLocations("us-central1", env), [
    "zones/us-central1-a",
    "zones/us-central1-c",
    "zones/us-central1-f",
  ]);
});

test("allowedLocations: trims whitespace and drops empty entries", () => {
  const env = { BATCH_ALLOWED_LOCATIONS: " regions/us-central1 , , " } as NodeJS.ProcessEnv;
  assert.deepEqual(batchAllowedLocations("us-central1", env), ["regions/us-central1"]);
});

test("allowedLocations: blank/whitespace-only env falls back to the region default", () => {
  assert.deepEqual(batchAllowedLocations("us-east1", { BATCH_ALLOWED_LOCATIONS: "   " }), [
    "regions/us-east1",
  ]);
});

// ── classifyBatchJobStatus ───────────────────────────────────────────────────

test("classify: FAILED + zone-exhausted event → terminalBad + capacityExhausted", () => {
  const r = classifyBatchJobStatus("FAILED", [
    { description: "Job state is set from RUNNING to FAILED" },
    {
      description:
        "Batch Error: code - CODE_GCE_ZONE_RESOURCE_POOL_EXHAUSTED, description - ...",
    },
  ]);
  assert.equal(r.terminalBad, true);
  assert.equal(r.capacityExhausted, true);
});

test("classify: numeric state 5 (FAILED) is treated as terminalBad", () => {
  const r = classifyBatchJobStatus(5, []);
  assert.equal(r.terminalBad, true);
  assert.equal(r.capacityExhausted, false);
});

test("classify: numeric state 8 (CANCELLED) without a capacity event", () => {
  const r = classifyBatchJobStatus(8, [{ description: "user requested cancellation" }]);
  assert.equal(r.terminalBad, true);
  assert.equal(r.capacityExhausted, false);
});

test("classify: GCE 'stockout' wording also flags capacity", () => {
  const r = classifyBatchJobStatus("CANCELLED", [{ description: "ZONE stockout in us-central1-b" }]);
  assert.equal(r.terminalBad, true);
  assert.equal(r.capacityExhausted, true);
});

test("classify: RUNNING is not terminalBad", () => {
  assert.equal(classifyBatchJobStatus("RUNNING", []).terminalBad, false);
  assert.equal(classifyBatchJobStatus(3, []).terminalBad, false);
});

test("classify: QUEUED/SCHEDULED (still provisioning) is not terminalBad", () => {
  assert.equal(classifyBatchJobStatus("QUEUED", null).terminalBad, false);
  assert.equal(classifyBatchJobStatus("SCHEDULED", undefined).terminalBad, false);
});

test("classify: null/undefined state is never terminalBad", () => {
  assert.equal(classifyBatchJobStatus(null, []).terminalBad, false);
  assert.equal(classifyBatchJobStatus(undefined, []).terminalBad, false);
});

test("classify: missing/empty statusEvents → capacityExhausted false", () => {
  assert.equal(classifyBatchJobStatus("FAILED", null).capacityExhausted, false);
  assert.equal(classifyBatchJobStatus("FAILED", undefined).capacityExhausted, false);
});

// ── BatchCapacityError ───────────────────────────────────────────────────────

test("BatchCapacityError carries the stable code + default user message", () => {
  const e = new BatchCapacityError();
  assert.equal(e.code, BATCH_CAPACITY_ERROR_CODE);
  assert.equal(e.code, "batch_capacity_unavailable");
  assert.equal(e.message, BATCH_CAPACITY_ERROR_MESSAGE);
  assert.ok(e instanceof Error);
});
