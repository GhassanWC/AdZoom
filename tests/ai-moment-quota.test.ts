/**
 * AI moment quota — the balancer's post-condition.
 *
 * `enforceAiQuota` prunes AI moments until they are ≤ AI_MOMENT_QUOTA of the
 * FINAL timeline, and `assertAiQuota` re-checks that invariant and throws in
 * dev. They must agree: any input the enforcer accepts must pass the assertion,
 * or the assertion 500s a request the enforcer believed it had fixed.
 *
 * Regression: the allowance used to be measured against the PRE-drop total
 * (`total·Q`) rather than the surviving non-AI count, so enforcement always
 * overshot — the denominator shrinks as AI moments are dropped. A real run with
 * 160 candidates / 90 AI "enforced" down to 24/94 = 25.5% against a 15% cap and
 * blew up the finalize pass with a 500.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { enforceAiQuota, assertAiQuota } from "../src/lib/timeline-balancer.ts";
import { AI_MOMENT_QUOTA } from "../src/lib/firebase/schema.ts";
import type { DetectedMoment, MomentProvenance } from "../src/lib/firebase/schema.ts";

/** Minimal moment shaped just enough for the quota pass (provenance + score). */
function moment(i: number, provenance: MomentProvenance): DetectedMoment {
  return {
    id: `m${i}`,
    startTime: i,
    endTime: i + 1,
    // Varied so the "drop lowest confidence first" ordering is exercised.
    confidenceScore: (i % 10) / 10,
    provenance,
  } as DetectedMoment;
}

/** `ai` AI moments followed by `total - ai` cv moments. */
function pool(total: number, ai: number): DetectedMoment[] {
  return Array.from({ length: total }, (_, i) =>
    moment(i, i < ai ? "ai" : "cv")
  );
}

const aiShare = (ms: DetectedMoment[]) =>
  ms.length === 0 ? 0 : ms.filter((m) => m.provenance === "ai").length / ms.length;

test("the reported failure: 160 candidates / 90 AI no longer breaches the cap", () => {
  const { kept } = enforceAiQuota(pool(160, 90));
  assert.ok(
    aiShare(kept) <= AI_MOMENT_QUOTA + 1e-6,
    `expected ≤ ${AI_MOMENT_QUOTA * 100}% AI, got ${(aiShare(kept) * 100).toFixed(1)}%`
  );
  // The old math kept 24/94 = 25.5% here and threw.
  assert.doesNotThrow(() => assertAiQuota(kept));
});

test("enforcement output always satisfies the assertion (full sweep)", () => {
  const breaches: string[] = [];
  for (let total = 1; total <= 220; total++) {
    for (let ai = 0; ai <= total; ai++) {
      const { kept } = enforceAiQuota(pool(total, ai));
      // All-AI pools are the one unsatisfiable case — covered separately below.
      if (ai === total) continue;
      if (aiShare(kept) > AI_MOMENT_QUOTA + 1e-6) {
        breaches.push(
          `total=${total} ai=${ai} -> ${(aiShare(kept) * 100).toFixed(1)}%`
        );
      }
    }
  }
  assert.deepEqual(breaches.slice(0, 5), [], `${breaches.length} breaching inputs`);
});

test("enforcement never throws its own assertion (the 500 that was reported)", () => {
  for (let total = 1; total <= 120; total++) {
    for (let ai = 0; ai <= total; ai++) {
      const { kept } = enforceAiQuota(pool(total, ai));
      assert.doesNotThrow(
        () => assertAiQuota(kept),
        `enforceAiQuota(total=${total}, ai=${ai}) produced a set its own assertion rejects`
      );
    }
  }
});

test("a pool already under quota is left completely untouched", () => {
  const input = pool(100, 10); // 10% AI, under the 15% cap
  const { kept, quotaDropped } = enforceAiQuota(input);
  assert.equal(quotaDropped, 0);
  assert.equal(kept.length, input.length);
});

test("only AI moments are dropped — cv/event/user moments always survive", () => {
  const input = pool(100, 60);
  const { kept } = enforceAiQuota(input);
  const nonAiIn = input.filter((m) => m.provenance !== "ai").length;
  const nonAiOut = kept.filter((m) => m.provenance !== "ai").length;
  assert.equal(nonAiOut, nonAiIn, "enforcement must never drop a non-AI moment");
});

test("ai-override counts toward the quota just like ai", () => {
  const input = [
    ...Array.from({ length: 30 }, (_, i) => moment(i, "ai-override")),
    ...Array.from({ length: 70 }, (_, i) => moment(i + 30, "cv")),
  ];
  const { kept } = enforceAiQuota(input);
  const overrideShare =
    kept.filter((m) => m.provenance === "ai-override").length / kept.length;
  assert.ok(
    overrideShare <= AI_MOMENT_QUOTA + 1e-6,
    `ai-override must count as AI, got ${(overrideShare * 100).toFixed(1)}%`
  );
});

test("an all-AI pool is kept rather than emptied, and does not throw", () => {
  // The quota is unsatisfiable here except by deleting the whole timeline —
  // that serves nobody, so the pool survives and the assertion tolerates it.
  const input = pool(40, 40);
  const { kept, quotaDropped } = enforceAiQuota(input);
  assert.equal(quotaDropped, 0);
  assert.equal(kept.length, 40);
  assert.doesNotThrow(() => assertAiQuota(kept));
});

test("an empty timeline is a no-op", () => {
  const { kept, quotaDropped } = enforceAiQuota([]);
  assert.deepEqual(kept, []);
  assert.equal(quotaDropped, 0);
  assert.doesNotThrow(() => assertAiQuota([]));
});
