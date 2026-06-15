/**
 * GET /api/admin/overview?range=today|7d|30d|all
 *
 * High-level metric aggregates for the admin Overview page. Uses cheap
 * `count()` aggregations where possible and small bounded reads for the
 * day-bucketed timeseries. Each metric degrades to `null` on error so a
 * single still-building index can't blank the whole page.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";
import { parseRange, rangeSince } from "@/lib/admin/range";
import { safeCount, tsComparand } from "@/lib/admin/query";
import { tsToMillis, dayKey } from "@/lib/admin/serialize";
import type { SubscriptionStatus } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMESERIES_CAP = 5000;
const PAID_STATUSES: SubscriptionStatus[] = ["active", "on_trial", "past_due"];

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { db } = getAdmin();
  const range = parseRange(req.nextUrl.searchParams.get("range"));
  const since = rangeSince(range);
  const sinceTs = tsComparand(since);

  const users = db.collection("users");
  const subscriptions = db.collection("subscriptions");
  const projects = db.collectionGroup("projects");
  const exports = db.collectionGroup("exports");
  const analysisJobs = db.collectionGroup("analysisJobs");
  const events = db.collection("analyticsEvents");

  // Counts run concurrently. `range === "all"` skips the range-scoped where.
  const inRange = range !== "all";
  const [
    totalUsers,
    newUsers,
    creatorUsers,
    proUsers,
    totalProjects,
    newProjects,
    totalExports,
    readyExports,
    failedExports,
    totalAnalysis,
    completeAnalysis,
    failedAnalysis,
    runningAnalysis,
    totalEvents,
    rangeEvents,
  ] = await Promise.all([
    safeCount(users),
    inRange ? safeCount(users.where("createdAt", ">=", sinceTs)) : safeCount(users),
    safeCount(users.where("plan", "==", "creator")),
    safeCount(users.where("plan", "==", "pro")),
    safeCount(projects),
    inRange
      ? safeCount(projects.where("createdAt", ">=", sinceTs))
      : safeCount(projects),
    safeCount(exports),
    safeCount(exports.where("status", "==", "ready")),
    safeCount(exports.where("status", "==", "failed")),
    safeCount(analysisJobs),
    safeCount(analysisJobs.where("status", "==", "complete")),
    safeCount(analysisJobs.where("status", "==", "failed")),
    safeCount(analysisJobs.where("status", "==", "running")),
    safeCount(events),
    inRange ? safeCount(events.where("timestamp", ">=", sinceTs)) : safeCount(events),
  ]);

  // Subscriptions: small collection (only paid users), read fully + tally.
  const subs = { active: 0, cancelled: 0, creator: 0, pro: 0 };
  let mrr = 0;
  // Monthly price per paid tier (USD) — see pricing tiers in mockData.ts.
  const PLAN_PRICE: Record<string, number> = { pro: 19, creator: 49 };
  try {
    const subSnap = await subscriptions.get();
    for (const d of subSnap.docs) {
      const data = d.data() as { plan?: string; status?: SubscriptionStatus };
      const status = data.status ?? "expired";
      const paid = PAID_STATUSES.includes(status);
      if (paid) {
        subs.active += 1;
        if (data.plan === "creator") subs.creator += 1;
        if (data.plan === "pro") subs.pro += 1;
        mrr += PLAN_PRICE[data.plan ?? ""] ?? 0;
      } else {
        subs.cancelled += 1;
      }
    }
  } catch (err) {
    console.error("[admin/overview] subscriptions read failed", err);
  }

  // Timeseries — bounded day buckets for the charts.
  const eventsByDay = await bucketByDay(
    events,
    "timestamp",
    sinceTs,
    inRange,
    (data) => tsToMillis(data.timestamp as never)
  );
  const exportsByDay = await bucketByDay(
    exports,
    "createdAt",
    sinceTs,
    inRange,
    (data) => tsToMillis(data.createdAt as never)
  );

  const freeUsers =
    totalUsers != null
      ? Math.max(0, totalUsers - (creatorUsers ?? 0) - (proUsers ?? 0))
      : null;

  const conversionRate =
    totalUsers && totalUsers > 0
      ? Number((((creatorUsers ?? 0) + (proUsers ?? 0)) / totalUsers).toFixed(4))
      : 0;

  return NextResponse.json({
    range,
    generatedAt: Date.now(),
    users: {
      total: totalUsers,
      new: newUsers,
      free: freeUsers,
      creator: creatorUsers,
      pro: proUsers,
      conversionRate,
    },
    projects: { total: totalProjects, new: newProjects },
    exports: { total: totalExports, ready: readyExports, failed: failedExports },
    analysis: {
      total: totalAnalysis,
      complete: completeAnalysis,
      failed: failedAnalysis,
      running: runningAnalysis,
    },
    events: { total: totalEvents, inRange: rangeEvents },
    subscriptions: subs,
    mrr,
    timeseries: { events: eventsByDay, exports: exportsByDay },
  });
}

/**
 * Fetch up to TIMESERIES_CAP docs in range, ordered newest-first, and bucket
 * them into `{ day, count }[]` ascending. Returns `[]` on error.
 */
async function bucketByDay(
  base: FirebaseFirestore.Query,
  orderField: string,
  sinceTs: FirebaseFirestore.Timestamp,
  inRange: boolean,
  toMs: (data: FirebaseFirestore.DocumentData) => number
): Promise<{ day: string; count: number }[]> {
  try {
    let q = base.orderBy(orderField, "desc").limit(TIMESERIES_CAP);
    if (inRange) q = base.where(orderField, ">=", sinceTs).orderBy(orderField, "desc").limit(TIMESERIES_CAP);
    const snap = await q.get();
    const counts = new Map<string, number>();
    for (const d of snap.docs) {
      const ms = toMs(d.data());
      if (!ms) continue;
      const key = dayKey(ms);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));
  } catch (err) {
    console.error("[admin/overview] timeseries failed", orderField, err);
    return [];
  }
}
