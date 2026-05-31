import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { createCheckout, planToVariantId } from "@/lib/lemonsqueezy/client";
import { assertBillingEnv } from "@/lib/lemonsqueezy/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/billing/checkout
 *
 * Body: { plan: "creator" | "pro" }
 * Auth: `Authorization: Bearer <firebase-id-token>`
 *
 * Creates a Lemon Squeezy checkout for the requested plan, embedding the
 * Firebase uid in `custom_data.user_id` so the webhook can map back. The
 * caller is expected to redirect the browser to the returned URL.
 *
 * Why server-side: the LS API key never leaves the server, and the
 * uid-to-checkout binding can't be forged by the client.
 */
export async function POST(req: NextRequest) {
  try {
    // Fail fast with one consistent message if any LS env var is missing —
    // avoids a half-configured deploy returning a confusing variant-id error.
    assertBillingEnv();

    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json(
        { error: "Missing Authorization header" },
        { status: 401 }
      );
    }

    const { auth } = getAdmin();
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch (err) {
      console.error("[billing/checkout] token verify failed", err);
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }
    const uid = decoded.uid;
    const email = decoded.email ?? null;

    const body = (await req.json().catch(() => ({}))) as { plan?: string };
    const plan = body.plan;
    if (plan !== "creator" && plan !== "pro") {
      return NextResponse.json(
        { error: "Body must include { plan: 'creator' | 'pro' }" },
        { status: 400 }
      );
    }

    const variantId = planToVariantId(plan);
    const origin = req.nextUrl.origin;
    const redirectUrl = `${origin}/dashboard/billing?checkout=success&plan=${plan}`;

    const { url } = await createCheckout({
      variantId,
      userId: uid,
      email,
      redirectUrl,
    });

    return NextResponse.json({ ok: true, url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Checkout failed.";
    console.error("[billing/checkout] failed", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
