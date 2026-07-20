/**
 * GET /api/admin/overview?range=today|7d|30d|all&from=&to=
 *
 * Cross-cutting snapshot for the Overview page.
 *
 * SCOPE IS NOW EXPLICIT, WHICH IT WAS NOT
 * ---------------------------------------
 * The old payload silently mixed scopes: `users.new`/`projects.new`/
 * `events.inRange` honoured the range, while `exports.*`, `analysis.*`,
 * `subscriptions.*` and the plan split were all-time `count()`s that ignored it
 * entirely. The page then rendered the ALL-TIME `exports.total` as the header
 * figure above a RANGE-SCOPED, 5000-capped "Exports per day" chart — two
 * different populations under one number, which could never agree.
 *
 * Now every field lives under one of two clearly-named keys:
 *   • `inRange`  — derived from a scan of the selected window; the charts are
 *                  bucketed from that SAME scan, so header totals always equal
 *                  the sum of their chart.
 *   • `allTime`  — cumulative `count()` aggregations, labelled "All time" in the
 *                  UI. A failed count returns null (rendered "—"), never 0:
 *                  a silent zero next to a populated chart is the exact bug
 *                  this rebuild set out to remove.
 *
 * COVERAGE CAVEATS THE UI SURFACES
 * --------------------------------
 * • Exports span TWO collections — `exports` (browser) and `exportJobs` (paid
 *   cloud). The old route counted only the first, so every paid render was
 *   missing from the totals. Both are scanned here.
 * • `analysisJobs` docs exist ONLY for videos longer than the chunking
 *   threshold (90s, lib/analysis/chunk-config.ts). Shorter videos are analyzed
 *   in-place on the project doc and create no job. So this is a count of
 *   chunked analysis runs, not of all analyses — `analysis.note` says so and
 *   the card carries the caveat.
 */

import { getAdmin } from "@/lib/firebase/admin";
import { adminRoute } from "@/lib/admin/handler";
import { scanWindow } from "@/lib/admin/scan";
import { safeCount } from "@/lib/admin/query";
import { parseListParams } from "@/lib/admin/params";
import { tsToMillis } from "@/lib/admin/serialize";
import { str, oneOf } from "@/lib/admin/validate";
import { tally, toSlices, bucketByDay, percent, countWhere } from "@/lib/admin/aggregate";
import { PLAN_IDS, monthlyValue, isActiveStatus, type PlanId } from "@/lib/admin/pricing";
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

/** Cloud statuses that mean "finished successfully". */
const READY = new Set(["ready"]);
const FAILED = new Set(["failed"]);

export const GET = adminRoute("overview", async (req) => {
  const { db } = getAdmin();
  const p = parseListParams(req.nextUrl.searchParams);
  const window = { fromMs: p.fromMs, toMs: p.toMs };

  const [
    userScan,
    projectScan,
    browserExportScan,
    cloudExportScan,
    analysisScan,
    eventScan,
    subscriptionScan,
    allTimeUsers,
    allTimeProjects,
    allTimeBrowserExports,
    allTimeCloudExports,
  ] = await Promise.all([
    // Users are scanned unbounded (not range-filtered) because the plan mix and
    // the total describe the whole account base; `newInRange` is derived below.
    scanWindow({
      query: db.collection("users").select("plan", "createdAt"),
      orderField: "createdAt",
      encoding: "timestamp",
      label: "overview:users",
    }),
    scanWindow({
      query: db.collectionGroup("projects").select("status", "createdAt"),
      orderField: "createdAt",
      encoding: "timestamp",
      ...window,
      label: "overview:projects",
    }),
    scanWindow({
      query: db.collectionGroup("exports").select("status", "createdAt", "applyWatermark"),
      orderField: "createdAt",
      encoding: "timestamp",
      ...window,
      label: "overview:exports",
    }),
    scanWindow({
      query: db.collectionGroup("exportJobs").select("status", "createdAt"),
      orderField: "createdAt",
      encoding: "timestamp",
      ...window,
      label: "overview:exportJobs",
    }),
    scanWindow({
      query: db.collectionGroup("analysisJobs").select("status", "startedAt"),
      orderField: "startedAt",
      encoding: "number", // Date.now(), not a Timestamp — see scan.ts
      ...window,
      label: "overview:analysis",
    }),
    scanWindow({
      query: db.collection("analyticsEvents").select("eventName", "userId", "environment", "timestamp"),
      orderField: "timestamp",
      encoding: "timestamp",
      ...window,
      label: "overview:events",
    }),
    scanWindow({
      query: db.collection("subscriptions").select("plan", "status", "createdAt"),
      orderField: "updatedAt",
      encoding: "number",
      label: "overview:subscriptions",
    }),
    safeCount(db.collection("users")),
    safeCount(db.collectionGroup("projects")),
    safeCount(db.collectionGroup("exports")),
    safeCount(db.collectionGroup("exportJobs")),
  ]);

  // ── Users ────────────────────────────────────────────────────────────────
  const users = userScan.docs.map((d) => ({
    plan: oneOf<PlanId>(d.data().plan, PLAN_IDS, "free"),
    createdAt: tsToMillis(d.data().createdAt as never),
  }));
  const byPlan = tally(users, (u) => u.plan, PLAN_IDS);
  const paidUsers = byPlan.pro + byPlan.creator;
  const newUsers = countWhere(
    users,
    (u) => u.createdAt > 0 && u.createdAt >= p.fromMs && (!p.toMs || u.createdAt <= p.toMs)
  );

  // ── Exports: both pipelines, one number ──────────────────────────────────
  const exportRows = [
    ...browserExportScan.docs.map((d) => ({
      status: str(d.data().status, "queued"),
      createdAt: tsToMillis(d.data().createdAt as never),
      watermarked: d.data().applyWatermark === true,
      pipeline: "browser" as const,
    })),
    ...cloudExportScan.docs.map((d) => ({
      status: str(d.data().status, "queued"),
      createdAt: tsToMillis(d.data().createdAt as never),
      watermarked: false, // paid plans never watermark
      pipeline: "cloud" as const,
    })),
  ];

  // ── Analysis ─────────────────────────────────────────────────────────────
  const analysisRows = analysisScan.docs.map((d) => ({
    status: str(d.data().status, "queued"),
    startedAt: tsToMillis(d.data().startedAt as never),
  }));

  // ── Events (production only — dev events must not inflate the dashboard) ──
  const eventRows = eventScan.docs
    .map((d) => ({
      eventName: str(d.data().eventName, "unknown"),
      userId: str(d.data().userId),
      environment: str(d.data().environment, "unknown"),
      timestamp: tsToMillis(d.data().timestamp as never),
    }))
    .filter((e) => e.environment === "production");

  // ── Subscriptions / revenue ──────────────────────────────────────────────
  const subs = subscriptionScan.docs.map((d) => {
    const plan = oneOf<PlanId>(d.data().plan, PLAN_IDS, "free");
    const status = oneOf<SubscriptionStatus>(
      d.data().status,
      SUBSCRIPTION_STATUSES,
      "expired"
    );
    return { plan, status, monthlyUsd: monthlyValue(plan, status) };
  });

  const projectRows = projectScan.docs.map((d) => ({
    status: str(d.data().status, "uploaded"),
    createdAt: tsToMillis(d.data().createdAt as never),
  }));

  return {
    range: { fromMs: p.fromMs, toMs: p.toMs, key: p.range },
    generatedAt: Date.now(),

    users: {
      total: users.length,
      paid: paidUsers,
      free: byPlan.free,
      newInRange: newUsers,
      byPlan: toSlices(byPlan),
      conversionPct: percent(paidUsers, users.length),
      truncated: userScan.truncated,
    },

    projects: {
      inRange: projectRows.length,
      exported: countWhere(projectRows, (r) => r.status === "exported"),
      failed: countWhere(projectRows, (r) => r.status === "failed"),
      perDay: bucketByDay(projectRows, (r) => r.createdAt, window),
      truncated: projectScan.truncated,
    },

    exports: {
      inRange: exportRows.length,
      browser: countWhere(exportRows, (r) => r.pipeline === "browser"),
      cloud: countWhere(exportRows, (r) => r.pipeline === "cloud"),
      ready: countWhere(exportRows, (r) => READY.has(r.status)),
      failed: countWhere(exportRows, (r) => FAILED.has(r.status)),
      watermarked: countWhere(exportRows, (r) => r.watermarked),
      // Bucketed from the same array as `inRange` — the chart's header total
      // and the sum of its bars are guaranteed equal.
      perDay: bucketByDay(exportRows, (r) => r.createdAt, window),
      truncated: browserExportScan.truncated || cloudExportScan.truncated,
    },

    analysis: {
      inRange: analysisRows.length,
      complete: countWhere(analysisRows, (r) => r.status === "complete"),
      failed: countWhere(analysisRows, (r) => r.status === "failed"),
      running: countWhere(analysisRows, (r) => r.status === "running"),
      queued: countWhere(analysisRows, (r) => r.status === "queued"),
      note: "Chunked analysis jobs only — videos under 90s analyze in-place and create no job document.",
      truncated: analysisScan.truncated,
    },

    events: {
      inRange: eventRows.length,
      uniqueUsers: new Set(eventRows.map((e) => e.userId).filter(Boolean)).size,
      topEvents: toSlices(tally(eventRows, (e) => e.eventName), { topN: 8, dropZero: true }),
      perDay: bucketByDay(eventRows, (e) => e.timestamp, window),
      truncated: eventScan.truncated,
    },

    billing: {
      activeSubscriptions: countWhere(subs, (s) => isActiveStatus(s.status)),
      trialing: countWhere(subs, (s) => s.status === "on_trial"),
      pastDue: countWhere(subs, (s) => s.status === "past_due"),
      cancelled: countWhere(subs, (s) => s.status === "cancelled"),
      /** List price only — `subscriptions` stores no amount. See pricing.ts. */
      listPriceMrr: subs.reduce((sum, s) => sum + s.monthlyUsd, 0),
      truncated: subscriptionScan.truncated,
    },

    // Cumulative counts, labelled "All time" in the UI. `null` when the count
    // aggregation failed — the UI renders "—", never a misleading 0.
    allTime: {
      users: allTimeUsers,
      projects: allTimeProjects,
      exports:
        allTimeBrowserExports == null && allTimeCloudExports == null
          ? null
          : (allTimeBrowserExports ?? 0) + (allTimeCloudExports ?? 0),
    },
  };
});
