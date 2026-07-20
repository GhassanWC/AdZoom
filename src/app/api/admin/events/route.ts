/**
 * GET /api/admin/events
 *   ?eventName=&userId=&environment=&search=&range=&from=&to=&page=&pageSize=
 *
 * Analytics event stream + activity aggregates from the root `analyticsEvents`
 * collection (written by trackEvent.ts / recordEvent.ts).
 *
 * FIXED — "top events" was a recency-biased sample. It used to come from a
 * separate `orderBy(timestamp desc).limit(1000)` read, unaffected by the
 * page's own filters and unlabelled, so "top events" actually meant "top events
 * among the most recent 1000". It is now tallied from the same scanned window
 * that produces the table, so the chart and the table always describe the same
 * set of events.
 *
 * FIXED — combined filters broke pagination. When both `eventName` and `userId`
 * were supplied, only one became a Firestore `where` and the other was applied
 * in memory to the already-fetched page — so a page could return zero rows
 * while still advertising a next cursor, and the "N shown" counter drifted.
 * All filtering now happens over the scanned window, so any combination works
 * and the counts stay exact.
 *
 * ADDED — environment filter. `trackEvent` stamps `environment`
 * (src/lib/analytics/events.ts), but no admin route ever filtered on it, so
 * events emitted from development machines were being counted in production
 * totals. The filter defaults to "production" for exactly that reason; pass
 * `environment=all` to see everything.
 *
 * NOTE — `analyticsEvents` has no interface in schema.ts. Its shape is defined
 * implicitly by the two writers and the firestore.rules allow-list, so every
 * field is read defensively here.
 */

import { getAdmin } from "@/lib/firebase/admin";
import { adminRoute } from "@/lib/admin/handler";
import { scanWindow, paginate } from "@/lib/admin/scan";
import { parseListParams, matchesSearch } from "@/lib/admin/params";
import { tsToMillis } from "@/lib/admin/serialize";
import { mapSafe, str, strOrNull, plainObject } from "@/lib/admin/validate";
import { tally, toSlices, bucketByDay } from "@/lib/admin/aggregate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EventRow {
  id: string;
  eventName: string;
  userId: string;
  userEmail: string | null;
  projectId: string | null;
  plan: string | null;
  environment: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export const GET = adminRoute("events", async (req) => {
  const { db } = getAdmin();
  const sp = req.nextUrl.searchParams;
  const p = parseListParams(sp, { defaultPageSize: 50 });
  const eventName = sp.get("eventName") ?? "";
  const userId = sp.get("userId") ?? "";
  // Default to production: dev-machine events must not inflate admin metrics.
  const environment = sp.get("environment") ?? "production";

  const { docs, truncated, scanned } = await scanWindow({
    query: db.collection("analyticsEvents"),
    orderField: "timestamp",
    encoding: "timestamp", // trackEvent.ts:82 / recordEvent.ts:42
    fromMs: p.fromMs,
    toMs: p.toMs,
    label: "events",
  });

  const { rows: scannedRows, skipped } = mapSafe(
    docs,
    (d): EventRow => {
      const data = d.data();
      return {
        id: d.id,
        eventName: str(data.eventName, "unknown"),
        userId: str(data.userId),
        userEmail: strOrNull(data.userEmail),
        projectId: strOrNull(data.projectId),
        plan: strOrNull(data.plan),
        // No default to "production" here — an absent environment is genuinely
        // unknown, and defaulting it into production is how dev noise gets
        // counted as real traffic.
        environment: str(data.environment, "unknown"),
        metadata: plainObject(data.metadata),
        timestamp: tsToMillis(data.timestamp as never),
      };
    },
    "events"
  );

  // The environment filter applies BEFORE aggregation — it defines the
  // population, unlike eventName/userId which narrow the table view.
  const all =
    environment === "all"
      ? scannedRows
      : scannedRows.filter((r) => r.environment === environment);

  const summary = {
    total: all.length,
    /** Tallied from the SAME window as the table — not a separate sample. */
    topEvents: toSlices(tally(all, (r) => r.eventName), { topN: 12, dropZero: true }),
    byPlan: toSlices(tally(all, (r) => r.plan ?? "unknown"), { topN: 6, dropZero: true }),
    byEnvironment: toSlices(tally(scannedRows, (r) => r.environment), { dropZero: true }),
    uniqueUsers: new Set(all.map((r) => r.userId).filter(Boolean)).size,
    perDay: bucketByDay(all, (r) => r.timestamp, { fromMs: p.fromMs, toMs: p.toMs }),
  };

  const filtered = all.filter(
    (r) =>
      (!eventName || r.eventName === eventName) &&
      (!userId || r.userId === userId) &&
      matchesSearch(p.search, r.eventName, r.userEmail, r.userId, r.projectId)
  );

  const page = paginate(filtered, p.page, p.pageSize);

  return {
    rows: page.rows,
    page: page.page,
    pageCount: page.pageCount,
    pageSize: p.pageSize,
    filteredTotal: page.total,
    windowTotal: all.length,
    summary,
    /** Every distinct event name in the window — populates the filter dropdown
     *  from real data instead of a hardcoded list that drifts from EVENTS. */
    eventNames: [...new Set(all.map((r) => r.eventName))].sort(),
    truncated,
    scanned,
    skipped,
    range: { fromMs: p.fromMs, toMs: p.toMs, key: p.range },
    generatedAt: Date.now(),
  };
});
