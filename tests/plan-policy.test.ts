/**
 * Unit tests for the export PLAN POLICY — the pure rules the server enforces
 * (resolution/fps normalization, per-plan active caps, monthly free limit,
 * queue priority, global cap, 4K disabled). Locks the acceptance criteria.
 *
 * Run with:  npm test   (node --test, native TS strip; no test deps)
 *
 * `plan-policy.ts` uses a type-only `@/lib/usage/plan` import (erased by Node's
 * type stripping), so it loads cleanly via a relative path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FOUR_K_ENABLED,
  MAX_EXPORT_RESOLUTION,
  MAX_EXPORT_FPS,
  FREE_MONTHLY_CLOUD_EXPORTS,
  MAX_ACTIVE_EXPORTS_PER_PLAN,
  EXPORT_PRIORITY_RANK,
  DEFAULT_GLOBAL_ACTIVE_EXPORT_LIMIT,
  globalActiveExportLimit,
  canSelectResolution,
  availableResolutionsForPlan,
  normalizeResolution,
  normalizeFps,
  priorityLabelForPlan,
} from "../src/lib/export/plan-policy.ts";

test("4K is disabled platform-wide", () => {
  assert.equal(FOUR_K_ENABLED, false);
  for (const plan of ["free", "pro", "creator"] as const) {
    assert.notEqual(MAX_EXPORT_RESOLUTION[plan], "4K");
    assert.equal(canSelectResolution(plan, "4K"), false);
    assert.ok(!availableResolutionsForPlan(plan).includes("4K" as never));
  }
});

test("Free cannot select high quality — capped at 720p", () => {
  assert.equal(MAX_EXPORT_RESOLUTION.free, "720p");
  assert.deepEqual(availableResolutionsForPlan("free"), ["720p"]);
  assert.equal(canSelectResolution("free", "1080p"), false);
  // Normalization clamps ANY requested quality down to the Free cap.
  assert.equal(normalizeResolution("free", "1080p"), "720p");
  assert.equal(normalizeResolution("free", "4K"), "720p");
  assert.equal(normalizeResolution("free", "720p"), "720p");
});

test("Pro/Creator get 1080p, never 4K", () => {
  for (const plan of ["pro", "creator"] as const) {
    assert.equal(MAX_EXPORT_RESOLUTION[plan], "1080p");
    assert.equal(canSelectResolution(plan, "1080p"), true);
    assert.equal(normalizeResolution(plan, "1080p"), "1080p");
    assert.equal(normalizeResolution(plan, "4K"), "1080p"); // 4K clamped down
    assert.equal(normalizeResolution(plan, "720p"), "720p"); // may pick lower
  }
});

test("fps cap — Free 30, paid up to 60", () => {
  assert.equal(MAX_EXPORT_FPS.free, 30);
  assert.equal(normalizeFps("free", 60), 30);
  assert.equal(normalizeFps("free", 30), 30);
  assert.equal(normalizeFps("pro", 60), 60);
  assert.equal(normalizeFps("creator", 60), 60);
});

test("per-plan active export caps — Free 1, Pro 1, Creator 2", () => {
  assert.equal(MAX_ACTIVE_EXPORTS_PER_PLAN.free, 1);
  assert.equal(MAX_ACTIVE_EXPORTS_PER_PLAN.pro, 1);
  assert.equal(MAX_ACTIVE_EXPORTS_PER_PLAN.creator, 2);
});

test("Free monthly cloud export limit = 2", () => {
  assert.equal(FREE_MONTHLY_CLOUD_EXPORTS, 2);
});

test("queue priority — Creator > Pro > Free", () => {
  assert.ok(EXPORT_PRIORITY_RANK.creator > EXPORT_PRIORITY_RANK.pro);
  assert.ok(EXPORT_PRIORITY_RANK.pro > EXPORT_PRIORITY_RANK.free);
  // Sorting queued jobs by rank DESC yields creator first, then pro, then free.
  const order = (["free", "pro", "creator"] as const)
    .slice()
    .sort((a, b) => EXPORT_PRIORITY_RANK[b] - EXPORT_PRIORITY_RANK[a]);
  assert.deepEqual(order, ["creator", "pro", "free"]);
  assert.equal(priorityLabelForPlan("creator"), "priority");
  assert.equal(priorityLabelForPlan("pro"), "normal");
  assert.equal(priorityLabelForPlan("free"), "normal");
});

test("global active export limit — default 5, env override", () => {
  assert.equal(DEFAULT_GLOBAL_ACTIVE_EXPORT_LIMIT, 5);
  assert.equal(globalActiveExportLimit({} as NodeJS.ProcessEnv), 5);
  assert.equal(
    globalActiveExportLimit({ GLOBAL_ACTIVE_EXPORT_LIMIT: "8" } as unknown as NodeJS.ProcessEnv),
    8
  );
  // Invalid / non-positive falls back to the default.
  assert.equal(
    globalActiveExportLimit({ GLOBAL_ACTIVE_EXPORT_LIMIT: "0" } as unknown as NodeJS.ProcessEnv),
    5
  );
  assert.equal(
    globalActiveExportLimit({ GLOBAL_ACTIVE_EXPORT_LIMIT: "nope" } as unknown as NodeJS.ProcessEnv),
    5
  );
});
