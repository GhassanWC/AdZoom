import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import type { Subscription } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/billing/portal
 *
 * Auth: `Authorization: Bearer <firebase-id-token>`
 *
 * Returns the Lemon Squeezy customer-portal URL for the calling user. The
 * URL is stored on every `subscription_*` webhook delivery, so it's always
 * the freshest one LS gave us. Caller redirects the browser to it.
 *
 * No body. No params. 404s with a clear message if the user has no
 * subscription record (i.e. they're still on free).
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json(
        { error: "Missing Authorization header" },
        { status: 401 }
      );
    }

    const { auth, db } = getAdmin();
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch (err) {
      console.error("[billing/portal] token verify failed", err);
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }
    const uid = decoded.uid;

    const snap = await db.doc(`subscriptions/${uid}`).get();
    if (!snap.exists) {
      return NextResponse.json(
        { error: "No active subscription" },
        { status: 404 }
      );
    }
    const sub = snap.data() as Subscription;
    if (!sub.customerPortalUrl) {
      return NextResponse.json(
        { error: "Customer portal URL not available yet — try again shortly." },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, url: sub.customerPortalUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Portal lookup failed.";
    console.error("[billing/portal] failed", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
