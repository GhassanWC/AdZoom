/**
 * GET /api/admin/users/[uid]
 *
 * Detail for one user: profile, subscription, and per-user counts
 * (projects / exports / analyses). Counts here are scoped to a single user's
 * subcollections, so they're cheap — unlike doing them per-row in the list.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";
import { safeCount } from "@/lib/admin/query";
import { tsToMillis } from "@/lib/admin/serialize";
import type { SubscriptionStatus } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { uid } = await params;
  const { db } = getAdmin();

  try {
    const userRef = db.collection("users").doc(uid);
    const [userSnap, subSnap, projectCount, exportCount, analysisCount] =
      await Promise.all([
        userRef.get(),
        db.collection("subscriptions").doc(uid).get(),
        safeCount(userRef.collection("projects")),
        safeCount(userRef.collection("exports")),
        safeCount(userRef.collection("analysisJobs")),
      ]);

    if (!userSnap.exists) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const u = userSnap.data() ?? {};
    const sub = subSnap.exists ? subSnap.data() ?? {} : null;

    return NextResponse.json({
      user: {
        uid,
        email: (u.email as string | null) ?? null,
        displayName: (u.displayName as string | null) ?? null,
        photoURL: (u.photoURL as string | null) ?? null,
        plan: (u.plan as string | undefined) ?? "free",
        createdAt: tsToMillis(u.createdAt as never),
        updatedAt: tsToMillis(u.updatedAt as never),
      },
      subscription: sub
        ? {
            plan: (sub.plan as string) ?? "free",
            status: (sub.status as SubscriptionStatus) ?? "expired",
            renewsAt: tsToMillis(sub.renewsAt as never),
            endsAt: tsToMillis(sub.endsAt as never),
            lastPaymentAt: tsToMillis(sub.lastPaymentAt as never),
          }
        : null,
      counts: {
        projects: projectCount,
        exports: exportCount,
        analyses: analysisCount,
      },
    });
  } catch (err) {
    console.error("[admin/users/:uid] failed", err);
    return NextResponse.json({ error: "Failed to load user" }, { status: 500 });
  }
}
