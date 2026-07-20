/**
 * Plan pricing + subscription-status semantics for billing metrics.
 *
 * SINGLE SOURCE OF TRUTH
 * ----------------------
 * The monthly price per tier was previously hardcoded as `{ pro: 25, creator: 49 }`
 * in BOTH `api/admin/overview/route.ts` and `api/admin/billing/route.ts`, with a
 * comment asking the next person to keep them in sync with the pricing page. Here
 * the numbers are derived from `pricingTiers` — the same array the public pricing
 * page and the dashboard billing page render — so a price change propagates
 * everywhere at once and cannot drift. `tests/admin-pricing.test.ts` pins the
 * parsed result so a reformat of the display strings fails loudly instead of
 * silently zeroing revenue.
 *
 * WHAT FIRESTORE DOES NOT STORE
 * -----------------------------
 * `Subscription` (src/lib/firebase/schema.ts) records `plan` and `status` but NO
 * monetary amount — no charged price, currency, discount, coupon or proration.
 * So "revenue" here is necessarily *list-price MRR*: plan tier × list price. It
 * cannot reflect discounts, annual billing or partial periods. Every consumer
 * must label it as such; do not present it as booked revenue.
 */

import { pricingTiers } from "@/lib/mockData";
import type { SubscriptionStatus } from "@/lib/firebase/schema";

/** Internal plan ids, as stored on `subscriptions/{uid}.plan` and `users/{uid}.plan`. */
export type PlanId = "free" | "pro" | "creator";

export const PLAN_IDS: readonly PlanId[] = ["free", "pro", "creator"];

/** Parse a display price ("$25", "$0") into a number. Returns 0 if unparseable. */
function parsePrice(display: string): number {
  const n = Number(String(display).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Monthly list price in USD per plan id, derived from `pricingTiers`.
 * Tier names are title-case on the pricing page ("Pro"); plan ids are lowercase.
 */
export const PLAN_MONTHLY_USD: Record<PlanId, number> = (() => {
  const out: Record<PlanId, number> = { free: 0, pro: 0, creator: 0 };
  for (const tier of pricingTiers) {
    const id = tier.name.toLowerCase() as PlanId;
    if ((PLAN_IDS as readonly string[]).includes(id)) {
      out[id] = parsePrice(tier.price);
    }
  }
  return out;
})();

/**
 * Statuses where the user currently HAS paid access. Used for "active
 * subscriptions" and the paid/free split. Includes `on_trial` (access granted)
 * and `past_due` (access retained during dunning).
 */
export const ACTIVE_STATUSES: readonly SubscriptionStatus[] = [
  "active",
  "on_trial",
  "past_due",
];

/**
 * Statuses that actually generate revenue this month. Deliberately EXCLUDES
 * `on_trial`: a trialing subscription has access but has not paid, and counting
 * it inflates MRR. `past_due` is included — the charge was attempted and the
 * subscription is still live — which is the conventional SaaS treatment.
 */
export const REVENUE_STATUSES: readonly SubscriptionStatus[] = ["active", "past_due"];

/** Statuses representing a subscription that has ended or lapsed. */
export const ENDED_STATUSES: readonly SubscriptionStatus[] = [
  "cancelled",
  "expired",
  "unpaid",
  "paused",
];

export function isActiveStatus(status: SubscriptionStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isRevenueStatus(status: SubscriptionStatus): boolean {
  return REVENUE_STATUSES.includes(status);
}

/** Monthly list-price contribution of one subscription. */
export function monthlyValue(plan: string, status: SubscriptionStatus): number {
  if (!isRevenueStatus(status)) return 0;
  return PLAN_MONTHLY_USD[plan as PlanId] ?? 0;
}
