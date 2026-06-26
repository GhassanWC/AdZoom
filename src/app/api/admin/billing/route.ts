/**
 * GET /api/admin/billing
 *
 * Subscription / revenue snapshot. The `subscriptions` collection only has
 * docs for users who have ever subscribed, so a full read is cheap. Free
 * users = total users minus paid subscribers.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";
import { safeCount } from "@/lib/admin/query";
import { tsToMillis } from "@/lib/admin/serialize";
import type { SubscriptionStatus } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Monthly price per paid tier (USD) — keep in sync with pricing tiers.
const PLAN_PRICE: Record<string, number> = { pro: 25, creator: 49 };
const PAID_STATUSES: SubscriptionStatus[] = ["active", "on_trial", "past_due"];

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { db } = getAdmin();

  try {
    const [totalUsers, subSnap] = await Promise.all([
      safeCount(db.collection("users")),
      db.collection("subscriptions").get(),
    ]);

    const planDistribution: Record<string, number> = { free: 0, creator: 0, pro: 0 };
    const statusDistribution: Record<string, number> = {};
    let activeCount = 0;
    let cancelledCount = 0;
    let mrr = 0;
    const recent: {
      uid: string;
      plan: string;
      status: SubscriptionStatus;
      lastPaymentAt: number;
      updatedAt: number;
    }[] = [];

    for (const d of subSnap.docs) {
      const data = d.data() as {
        plan?: string;
        status?: SubscriptionStatus;
        lastPaymentAt?: unknown;
        updatedAt?: unknown;
      };
      const plan = data.plan ?? "free";
      const status = data.status ?? "expired";
      statusDistribution[status] = (statusDistribution[status] ?? 0) + 1;
      const paid = PAID_STATUSES.includes(status);
      if (paid) {
        activeCount += 1;
        if (plan in planDistribution) planDistribution[plan] += 1;
        mrr += PLAN_PRICE[plan] ?? 0;
      } else {
        cancelledCount += 1;
      }
      recent.push({
        uid: d.id,
        plan,
        status,
        lastPaymentAt: tsToMillis(data.lastPaymentAt as never),
        updatedAt: tsToMillis(data.updatedAt as never),
      });
    }

    recent.sort((a, b) => b.updatedAt - a.updatedAt);

    const paidUsers = activeCount;
    const freeUsers = totalUsers != null ? Math.max(0, totalUsers - paidUsers) : null;
    if (freeUsers != null) planDistribution.free = freeUsers;
    const conversionRate =
      totalUsers && totalUsers > 0 ? Number((paidUsers / totalUsers).toFixed(4)) : 0;

    return NextResponse.json({
      totalUsers,
      freeUsers,
      paidUsers,
      activeSubscriptions: activeCount,
      cancelledSubscriptions: cancelledCount,
      mrr,
      conversionRate,
      planDistribution,
      statusDistribution,
      recent: recent.slice(0, 25),
    });
  } catch (err) {
    console.error("[admin/billing] failed", err);
    return NextResponse.json({ error: "Failed to load billing" }, { status: 500 });
  }
}
