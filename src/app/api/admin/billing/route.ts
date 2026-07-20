/**
 * GET /api/admin/billing
 *   ?status=&plan=&search=&range=&from=&to=&page=&pageSize=
 *
 * Subscription + revenue snapshot from the root `subscriptions` collection
 * (one doc per user who has ever subscribed; written by the Lemon Squeezy
 * webhook) plus the `users` collection for the paid/free split.
 *
 * WHAT "REVENUE" CAN AND CANNOT MEAN HERE
 * ---------------------------------------
 * `Subscription` (schema.ts:2145) stores `plan` and `status` but NO monetary
 * amount — no charged price, currency, discount, coupon or proration. So MRR is
 * necessarily LIST-PRICE MRR: plan tier × the public price, summed. It cannot
 * reflect discounts or annual billing. The response names it `listPriceMrr`
 * (not `mrr`) and the UI labels it "Est. MRR (list price)" so it is never read
 * as booked revenue. Prices come from `lib/admin/pricing.ts`, which derives them
 * from the same `pricingTiers` the public pricing page renders — they used to be
 * hardcoded as `{pro:25, creator:49}` in two separate route files.
 *
 * MRR NO LONGER COUNTS TRIALS. The old `PAID_STATUSES` included `on_trial`, so
 * every trialing subscription was billed into MRR at full price despite having
 * paid nothing. `REVENUE_STATUSES` (active + past_due) is used for money;
 * `ACTIVE_STATUSES` (which does include trials) is used for access counts.
 *
 * CHURN IS NO LONGER CONFLATED. The old route incremented one `cancelledCount`
 * for every non-paid status, so `paused`, `unpaid` and `expired` subscribers
 * were all reported as "cancelled". Each status is now reported distinctly.
 *
 * CONVERSION MATCHES THE USERS PAGE. Both compute paid ÷ total from `users.plan`,
 * so the two pages cannot show different conversion rates for the same data —
 * they previously used different collections and provably disagreed for a
 * cancelled-with-future-`endsAt` subscriber.
 */

import { getAdmin } from "@/lib/firebase/admin";
import { adminRoute } from "@/lib/admin/handler";
import { scanWindow, paginate } from "@/lib/admin/scan";
import { parseListParams, matchesSearch } from "@/lib/admin/params";
import { tsToMillis, tsToMillisOpt } from "@/lib/admin/serialize";
import { mapSafe, str, oneOf } from "@/lib/admin/validate";
import { tally, toSlices, countWhere, percent, bucketByDay } from "@/lib/admin/aggregate";
import {
  PLAN_IDS,
  PLAN_MONTHLY_USD,
  ACTIVE_STATUSES,
  REVENUE_STATUSES,
  isActiveStatus,
  monthlyValue,
  type PlanId,
} from "@/lib/admin/pricing";
import type { SubscriptionStatus } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "active",
  "on_trial",
  "paused",
  "past_due",
  "unpaid",
  "cancelled",
  "expired",
];

interface SubscriptionRow {
  uid: string;
  plan: PlanId;
  status: SubscriptionStatus;
  /** Monthly list-price contribution — 0 unless the status generates revenue. */
  monthlyUsd: number;
  renewsAt: number | null;
  endsAt: number | null;
  lastPaymentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export const GET = adminRoute("billing", async (req) => {
  const { db } = getAdmin();
  const sp = req.nextUrl.searchParams;
  const p = parseListParams(sp);
  const planFilter = sp.get("plan") ?? "";

  const [subs, users] = await Promise.all([
    scanWindow({
      query: db.collection("subscriptions"),
      orderField: "updatedAt",
      // Subscription timestamps ARE plain numbers — billing/webhook writes
      // Date.now() (schema.ts:2168-2170 is honest for this collection).
      encoding: "number",
      // Not range-filtered: the current subscription book is the whole point of
      // this page. The range scopes the "new in range" metric below instead.
      label: "billing:subscriptions",
    }),
    // Only the plan column is needed for the paid/free split.
    scanWindow({
      query: db.collection("users").select("plan"),
      orderField: "createdAt",
      encoding: "timestamp",
      label: "billing:users",
    }),
  ]);

  const { rows: all, skipped } = mapSafe(
    subs.docs,
    (d): SubscriptionRow => {
      const data = d.data();
      const plan = oneOf<PlanId>(data.plan, PLAN_IDS, "free");
      const status = oneOf<SubscriptionStatus>(
        data.status,
        SUBSCRIPTION_STATUSES,
        "expired"
      );
      return {
        uid: d.id,
        plan,
        status,
        monthlyUsd: monthlyValue(plan, status),
        // tsToMillisOpt returns undefined (→ null) rather than 0 for absent
        // dates, so the UI renders "—" instead of 1 Jan 1970.
        renewsAt: tsToMillisOpt(data.renewsAt as never) ?? null,
        endsAt: tsToMillisOpt(data.endsAt as never) ?? null,
        lastPaymentAt: tsToMillisOpt(data.lastPaymentAt as never) ?? null,
        createdAt: tsToMillis(data.createdAt as never),
        updatedAt: tsToMillis(data.updatedAt as never),
      };
    },
    "billing"
  );

  // Paid/free split from `users.plan` — the same source the Users page uses.
  let totalUsers = 0;
  let paidUsers = 0;
  for (const d of users.docs) {
    totalUsers += 1;
    const plan = str(d.data().plan, "free");
    if (plan === "pro" || plan === "creator") paidUsers += 1;
  }

  const byStatus = tally(all, (r) => r.status, SUBSCRIPTION_STATUSES);
  const activeSubs = all.filter((r) => isActiveStatus(r.status));

  const summary = {
    byStatus,
    byStatusSlices: toSlices(byStatus, { dropZero: true }),
    /** Plan mix among subscriptions that currently grant access. */
    byPlan: toSlices(tally(activeSubs, (r) => r.plan), { dropZero: true }),
    /** Access-granting subscriptions: active + on_trial + past_due. */
    activeSubscriptions: activeSubs.length,
    trialing: countWhere(all, (r) => r.status === "on_trial"),
    pastDue: countWhere(all, (r) => r.status === "past_due"),
    // Reported separately rather than lumped into one "cancelled" number.
    cancelled: countWhere(all, (r) => r.status === "cancelled"),
    paused: countWhere(all, (r) => r.status === "paused"),
    expired: countWhere(all, (r) => r.status === "expired"),
    unpaid: countWhere(all, (r) => r.status === "unpaid"),
    /** List-price MRR — see the header note. Excludes trials. */
    listPriceMrr: all.reduce((sum, r) => sum + r.monthlyUsd, 0),
    /** Annualized run rate from the same list-price basis. */
    listPriceArr: all.reduce((sum, r) => sum + r.monthlyUsd, 0) * 12,
    totalUsers,
    paidUsers,
    freeUsers: Math.max(0, totalUsers - paidUsers),
    conversionPct: percent(paidUsers, totalUsers),
    /** New subscriptions created inside the selected range. */
    newInRange: countWhere(
      all,
      (r) => r.createdAt > 0 && r.createdAt >= p.fromMs && (!p.toMs || r.createdAt <= p.toMs)
    ),
    /** Which statuses/prices fed the money numbers — shown in the UI footnote. */
    revenueBasis: {
      planMonthlyUsd: PLAN_MONTHLY_USD,
      revenueStatuses: REVENUE_STATUSES,
      activeStatuses: ACTIVE_STATUSES,
    },
    perDay: bucketByDay(all, (r) => r.createdAt, { fromMs: p.fromMs, toMs: p.toMs }),
  };

  const filtered = all
    .filter(
      (r) =>
        (!p.status || r.status === p.status) &&
        (!planFilter || r.plan === planFilter) &&
        matchesSearch(p.search, r.uid, r.plan, r.status)
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const page = paginate(filtered, p.page, p.pageSize);

  return {
    rows: page.rows,
    page: page.page,
    pageCount: page.pageCount,
    pageSize: p.pageSize,
    filteredTotal: page.total,
    windowTotal: all.length,
    summary,
    truncated: subs.truncated || users.truncated,
    scanned: subs.scanned,
    skipped,
    range: { fromMs: p.fromMs, toMs: p.toMs, key: p.range },
    generatedAt: Date.now(),
  };
});
