/**
 * Unit tests for the cloud-export gating DECISIONS — the pure logic the
 * `/api/export/cloud` route and the export panel rely on. Mirrors the product
 * test matrix (Free/Pro/Creator, duration cap, minutes exhausted).
 *
 * Run with:  npm test   (node --test, native TS strip; no test deps)
 *
 * Only modules with NO runtime `@/` aliases / `server-only` imports are loaded
 * here — `cloud-minutes.ts` and `plan.ts` use type-only imports, which Node's
 * type-stripping erases, so they import cleanly via relative paths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLOUD_EXPORT_MINUTES,
  planAllowsCloudExport,
  estimateExportMinutes,
  cloudMinutesRemaining,
  canCloudExport,
} from "../src/lib/usage/cloud-minutes.ts";
import {
  exceedsUploadDuration,
  FREE_UPLOAD_MAX_DURATION_SECONDS,
} from "../src/lib/usage/plan.ts";

test("plan minutes: Free 0, Pro 150, Creator 600", () => {
  assert.equal(CLOUD_EXPORT_MINUTES.free, 0);
  assert.equal(CLOUD_EXPORT_MINUTES.pro, 150);
  assert.equal(CLOUD_EXPORT_MINUTES.creator, 600);
});

test("planAllowsCloudExport: only paid plans", () => {
  assert.equal(planAllowsCloudExport("free"), false);
  assert.equal(planAllowsCloudExport("pro"), true);
  assert.equal(planAllowsCloudExport("creator"), true);
});

test("estimateExportMinutes: whole minutes, rounded up, floor 1", () => {
  assert.equal(estimateExportMinutes(0), 1);
  assert.equal(estimateExportMinutes(5), 1);
  assert.equal(estimateExportMinutes(60), 1);
  assert.equal(estimateExportMinutes(61), 2);
  assert.equal(estimateExportMinutes(181), 4);
  assert.equal(estimateExportMinutes(NaN), 1);
});

// ── Scenario 1: Free user, 2-minute video ─────────────────────────────────
test("Scenario 1 — Free 2-min: browser allowed, cloud blocked", () => {
  // Browser export: a 2-min (120s) source is within the Free cap.
  assert.equal(exceedsUploadDuration("free", 120), false);
  // Cloud export: never available to Free.
  assert.equal(planAllowsCloudExport("free"), false);
  assert.equal(canCloudExport("free", undefined, 2), false);
});

// ── Scenario 2: Free user, 5-minute video ─────────────────────────────────
test("Scenario 2 — Free 5-min: blocked by the 3-minute cap", () => {
  assert.equal(FREE_UPLOAD_MAX_DURATION_SECONDS, 180);
  assert.equal(exceedsUploadDuration("free", 300), true);
});

// ── Scenario 3: Pro user ───────────────────────────────────────────────────
test("Scenario 3 — Pro: cloud export allowed within remaining minutes", () => {
  const estimate = estimateExportMinutes(150); // ~2.5 min clip → 3 minutes
  assert.equal(planAllowsCloudExport("pro"), true);
  assert.equal(canCloudExport("pro", { exportCount: 0, updatedAt: 0 }, estimate), true);
  assert.equal(cloudMinutesRemaining("pro", undefined), 150);
});

// ── Scenario 4: Creator user ───────────────────────────────────────────────
test("Scenario 4 — Creator: higher quota; priority is creator-only", () => {
  assert.equal(cloudMinutesRemaining("creator", undefined), 600);
  assert.equal(canCloudExport("creator", undefined, 10), true);
  // (The API maps creator → priority queue; pro/free → normal.)
});

// ── Scenario 5: Usage limit exceeded ───────────────────────────────────────
test("Scenario 5 — minutes exhausted: cloud blocked", () => {
  const usage = {
    exportCount: 0,
    updatedAt: 0,
    cloudMinutesConsumed: 149,
    cloudMinutesReserved: 1,
  };
  assert.equal(cloudMinutesRemaining("pro", usage), 0);
  assert.equal(canCloudExport("pro", usage, 1), false);
});

test("reservations count against the balance (no double-spend)", () => {
  // 150 limit, 140 consumed + 9 reserved by an in-flight job → 1 left.
  const usage = {
    exportCount: 0,
    updatedAt: 0,
    cloudMinutesConsumed: 140,
    cloudMinutesReserved: 9,
  };
  assert.equal(cloudMinutesRemaining("pro", usage), 1);
  assert.equal(canCloudExport("pro", usage, 2), false); // a 2-min job can't fit
  assert.equal(canCloudExport("pro", usage, 1), true); // a 1-min job just fits
});

test("remaining never goes negative when over-committed", () => {
  const usage = {
    exportCount: 0,
    updatedAt: 0,
    cloudMinutesConsumed: 600,
    cloudMinutesReserved: 50,
  };
  assert.equal(cloudMinutesRemaining("pro", usage), 0);
});
