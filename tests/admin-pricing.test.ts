/**
 * Billing metric semantics.
 *
 * `PLAN_MONTHLY_USD` is DERIVED from `pricingTiers` — the same array the public
 * pricing page renders — so a price change propagates everywhere instead of
 * drifting from the two hardcoded `{pro:25, creator:49}` copies the admin
 * routes used to carry. The trade is that a reformat of those display strings
 * ("$25" → "25 USD") would silently zero revenue, so these tests pin the parsed
 * result. If pricing genuinely changes, update the expectations deliberately.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PLAN_MONTHLY_USD,
  ACTIVE_STATUSES,
  REVENUE_STATUSES,
  isActiveStatus,
  isRevenueStatus,
  monthlyValue,
} from "../src/lib/admin/pricing.ts";
import type { SubscriptionStatus } from "../src/lib/firebase/schema.ts";

test("plan prices parse out of pricingTiers", () => {
  assert.equal(PLAN_MONTHLY_USD.free, 0);
  assert.equal(PLAN_MONTHLY_USD.pro, 25);
  assert.equal(PLAN_MONTHLY_USD.creator, 49);
});

test("every paid plan has a NON-ZERO price — a parse failure must not read as $0", () => {
  assert.ok(PLAN_MONTHLY_USD.pro > 0, "pro price failed to parse from pricingTiers");
  assert.ok(PLAN_MONTHLY_USD.creator > 0, "creator price failed to parse from pricingTiers");
});

test("access statuses include trials; revenue statuses do NOT", () => {
  assert.ok(ACTIVE_STATUSES.includes("on_trial"), "a trialing user has access");
  assert.ok(
    !REVENUE_STATUSES.includes("on_trial"),
    "a trialing user has paid nothing — counting them inflates MRR"
  );
  assert.ok(REVENUE_STATUSES.includes("active"));
  assert.ok(REVENUE_STATUSES.includes("past_due"), "still subscribed during dunning");
});

test("isActiveStatus / isRevenueStatus agree with those sets", () => {
  assert.equal(isActiveStatus("active"), true);
  assert.equal(isActiveStatus("on_trial"), true);
  assert.equal(isActiveStatus("cancelled"), false);
  assert.equal(isRevenueStatus("active"), true);
  assert.equal(isRevenueStatus("on_trial"), false);
  assert.equal(isRevenueStatus("expired"), false);
});

test("monthlyValue: only revenue-bearing statuses contribute", () => {
  assert.equal(monthlyValue("pro", "active"), 25);
  assert.equal(monthlyValue("creator", "active"), 49);
  assert.equal(monthlyValue("creator", "past_due"), 49);
  // The old MRR counted this at full price.
  assert.equal(monthlyValue("creator", "on_trial"), 0);
  assert.equal(monthlyValue("pro", "cancelled"), 0);
  assert.equal(monthlyValue("pro", "expired"), 0);
  assert.equal(monthlyValue("free", "active"), 0);
});

test("monthlyValue: an unrecognised plan contributes 0 rather than throwing", () => {
  assert.equal(monthlyValue("enterprise", "active"), 0);
  assert.equal(monthlyValue("", "active"), 0);
});

test("MRR over a mixed book excludes trials and ended subscriptions", () => {
  const book: { plan: string; status: SubscriptionStatus }[] = [
    { plan: "pro", status: "active" }, // 25
    { plan: "creator", status: "active" }, // 49
    { plan: "pro", status: "past_due" }, // 25
    { plan: "creator", status: "on_trial" }, // 0 — trial
    { plan: "pro", status: "cancelled" }, // 0
    { plan: "creator", status: "expired" }, // 0
    { plan: "free", status: "active" }, // 0
  ];
  const mrr = book.reduce((sum, s) => sum + monthlyValue(s.plan, s.status), 0);
  assert.equal(mrr, 99);

  // The old calculation (PAID_STATUSES included on_trial) would have said 148.
  const legacyPaid: SubscriptionStatus[] = ["active", "on_trial", "past_due"];
  const legacyPrice: Record<string, number> = { pro: 25, creator: 49 };
  const legacyMrr = book.reduce(
    (sum, s) => sum + (legacyPaid.includes(s.status) ? (legacyPrice[s.plan] ?? 0) : 0),
    0
  );
  assert.equal(legacyMrr, 148);
  assert.ok(mrr < legacyMrr, "the fix must reduce, not inflate, reported revenue");
});
