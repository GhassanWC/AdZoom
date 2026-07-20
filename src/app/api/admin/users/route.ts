/**
 * GET /api/admin/users
 *   ?plan=&search=&range=&from=&to=&page=&pageSize=
 *
 * User list + aggregates from the root `users` collection.
 *
 * "ACTIVE USERS" IS A DERIVED METRIC — READ THIS BEFORE CHANGING IT
 * ----------------------------------------------------------------
 * `UserDoc` (schema.ts:1977) stores `createdAt` and `updatedAt` but NO
 * last-seen / last-active field. `updatedAt` only moves when the profile doc
 * itself is rewritten (sign-in refresh, plan change), so it is NOT a usable
 * activity signal. The only real activity record this app keeps is
 * `analyticsEvents`, so "active" here means **distinct userIds that emitted at
 * least one tracked event inside the selected window** — genuine data, but it
 * undercounts users whose sessions produce no tracked event, and it is bounded
 * by the scan cap. The response labels it `activeWithEvents` rather than
 * `active` so no caller mistakes it for a true session count. Adding
 * `UserDoc.lastSeenAt` on auth refresh would make this exact.
 *
 * SEARCH IS IN-MEMORY, AND THAT IS AN UPGRADE
 * -------------------------------------------
 * The old route did a Firestore email PREFIX range query, so "acme" could not
 * find "team-acme@x.com" and display names were unsearchable. Searching the
 * scanned window instead matches substrings across email, display name and uid.
 */

import { getAdmin } from "@/lib/firebase/admin";
import { adminRoute } from "@/lib/admin/handler";
import { scanWindow, paginate } from "@/lib/admin/scan";
import { parseListParams, matchesSearch } from "@/lib/admin/params";
import { tsToMillis } from "@/lib/admin/serialize";
import { mapSafe, str, strOrNull, oneOf } from "@/lib/admin/validate";
import { tally, toSlices, countWhere, bucketByDay, percent } from "@/lib/admin/aggregate";
import { PLAN_IDS, type PlanId } from "@/lib/admin/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NEW_WINDOW_MS = 7 * 86_400_000;

interface UserRow {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  plan: PlanId;
  createdAt: number;
  updatedAt: number;
  /** True when this user emitted a tracked event inside the window. */
  activeInWindow: boolean;
}

export const GET = adminRoute("users", async (req) => {
  const { db } = getAdmin();
  const p = parseListParams(req.nextUrl.searchParams);
  const planFilter = req.nextUrl.searchParams.get("plan") ?? "";
  const now = Date.now();

  // Two scans in parallel: the user records, and just the `userId` column of
  // the events in the window (projected, so this stays cheap even at the cap).
  const [users, events] = await Promise.all([
    scanWindow({
      query: db.collection("users"),
      orderField: "createdAt",
      encoding: "timestamp", // AuthProvider.tsx:98 writes serverTimestamp()
      // Users are listed in full regardless of range: a date window here would
      // hide every existing account whenever the operator picks "today". The
      // range scopes the "new users" metric instead (computed below).
      label: "users",
    }),
    scanWindow({
      query: db.collection("analyticsEvents").select("userId"),
      orderField: "timestamp",
      encoding: "timestamp", // trackEvent.ts:82 writes serverTimestamp()
      fromMs: p.fromMs,
      toMs: p.toMs,
      label: "users:activity",
    }),
  ]);

  const activeUids = new Set<string>();
  for (const d of events.docs) {
    const uid = str(d.data().userId);
    if (uid) activeUids.add(uid);
  }

  const { rows: all, skipped } = mapSafe(
    users.docs,
    (d): UserRow => {
      const data = d.data();
      return {
        uid: d.id,
        email: strOrNull(data.email),
        displayName: strOrNull(data.displayName),
        photoURL: strOrNull(data.photoURL),
        // An absent `plan` is genuinely free — AuthProvider never writes the
        // field for free accounts (AuthProvider.tsx:96-99).
        plan: oneOf<PlanId>(data.plan, PLAN_IDS, "free"),
        createdAt: tsToMillis(data.createdAt as never),
        updatedAt: tsToMillis(data.updatedAt as never),
        activeInWindow: activeUids.has(d.id),
      };
    },
    "users"
  );

  const byPlan = tally(all, (r) => r.plan, PLAN_IDS);
  const paidUsers = byPlan.pro + byPlan.creator;

  const summary = {
    byPlan,
    byPlanSlices: toSlices(byPlan),
    total: all.length,
    paid: paidUsers,
    free: byPlan.free,
    /** Signed up inside the selected range. */
    newInRange: countWhere(
      all,
      (r) => r.createdAt > 0 && r.createdAt >= p.fromMs && (!p.toMs || r.createdAt <= p.toMs)
    ),
    /** Signed up in the last 7 days, independent of the range selector. */
    newLast7d: countWhere(all, (r) => r.createdAt > 0 && now - r.createdAt <= NEW_WINDOW_MS),
    /** See the header note — event-derived, not a session count. */
    activeWithEvents: countWhere(all, (r) => r.activeInWindow),
    /** Paid share of all accounts, from `users.plan`. Billing reports the same
     *  ratio from the same source so the two pages cannot disagree. */
    conversionPct: percent(paidUsers, all.length),
    /** True when the activity scan hit its cap ⇒ activeWithEvents is a floor. */
    activityTruncated: events.truncated,
    perDay: bucketByDay(all, (r) => r.createdAt, { fromMs: p.fromMs, toMs: p.toMs }),
  };

  const filtered = all.filter(
    (r) =>
      (!planFilter || r.plan === planFilter) &&
      matchesSearch(p.search, r.email, r.displayName, r.uid)
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
    truncated: users.truncated,
    scanned: users.scanned,
    skipped,
    range: { fromMs: p.fromMs, toMs: p.toMs, key: p.range },
    generatedAt: Date.now(),
  };
});
