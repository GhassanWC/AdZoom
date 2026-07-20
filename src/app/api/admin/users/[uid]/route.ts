/**
 * GET /api/admin/users/[uid]
 *
 * Detail for one user: profile, subscription, and per-user counts. Counts are
 * scoped to a single user's subcollections, so they're cheap here — unlike
 * running them per-row across the whole user list.
 *
 * Two fixes carried from the audit:
 *  • Optional dates use `tsToMillisOpt`, so an absent `renewsAt`/`endsAt`/
 *    `lastPaymentAt` serializes as `null` instead of 0 — the UI was otherwise
 *    obliged to special-case 0 or render "1 Jan 1970".
 *  • Cloud exports (`exportJobs`) are counted alongside browser exports. The
 *    old response counted only `exports`, so a paying user's cloud renders were
 *    invisible in their own detail view.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";
import { safeCount } from "@/lib/admin/query";
import { tsToMillis, tsToMillisOpt } from "@/lib/admin/serialize";
import { oneOf, str, strOrNull } from "@/lib/admin/validate";
import { PLAN_IDS, type PlanId } from "@/lib/admin/pricing";
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  // The gate runs before `params` is resolved and before any Firestore access.
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { uid } = await params;
  const { db } = getAdmin();

  try {
    const userRef = db.collection("users").doc(uid);
    const [userSnap, subSnap, projectCount, exportCount, cloudExportCount, analysisCount] =
      await Promise.all([
        userRef.get(),
        db.collection("subscriptions").doc(uid).get(),
        safeCount(userRef.collection("projects")),
        safeCount(userRef.collection("exports")),
        safeCount(userRef.collection("exportJobs")),
        safeCount(userRef.collection("analysisJobs")),
      ]);

    if (!userSnap.exists) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const u = userSnap.data() ?? {};
    const sub = subSnap.exists ? (subSnap.data() ?? {}) : null;

    return NextResponse.json({
      user: {
        uid,
        email: strOrNull(u.email),
        displayName: strOrNull(u.displayName),
        photoURL: strOrNull(u.photoURL),
        plan: oneOf<PlanId>(u.plan, PLAN_IDS, "free"),
        createdAt: tsToMillis(u.createdAt as never),
        updatedAt: tsToMillis(u.updatedAt as never),
      },
      subscription: sub
        ? {
            plan: oneOf<PlanId>(sub.plan, PLAN_IDS, "free"),
            status: oneOf<SubscriptionStatus>(sub.status, SUBSCRIPTION_STATUSES, "expired"),
            lemonSubscriptionId: str(sub.lemonSubscriptionId) || null,
            // null, not 0 — see the header note.
            renewsAt: tsToMillisOpt(sub.renewsAt as never) ?? null,
            endsAt: tsToMillisOpt(sub.endsAt as never) ?? null,
            trialEndsAt: tsToMillisOpt(sub.trialEndsAt as never) ?? null,
            lastPaymentAt: tsToMillisOpt(sub.lastPaymentAt as never) ?? null,
          }
        : null,
      counts: {
        projects: projectCount,
        /** Browser renders. */
        exports: exportCount,
        /** Paid cloud renders — previously missing entirely. */
        cloudExports: cloudExportCount,
        /**
         * Chunked analysis jobs only: videos under the 90s threshold analyze
         * in-place on the project document and create no job.
         */
        analyses: analysisCount,
      },
    });
  } catch (err) {
    console.error(
      "[admin/users/:uid] failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json({ error: "Failed to load user" }, { status: 500 });
  }
}
