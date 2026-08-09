import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { fetchSubscriptionUrls, type LsSubscriptionUrls } from "@/lib/lemonsqueezy/client";
import type { Subscription } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which hosted Lemon Squeezy page the caller wants. */
type PortalTarget = "portal" | "update" | "change-plan";

function parseTarget(raw: unknown): PortalTarget {
  return raw === "update" || raw === "change-plan" ? raw : "portal";
}

/**
 * Pick the URL for `target`, degrading gracefully:
 *   update      → update_payment_method → customer_portal
 *   change-plan → plan switcher         → customer_portal
 *   portal      → customer_portal
 *
 * Every hosted page is reachable from the customer portal, so falling back to
 * it always lands the user somewhere they can finish the job — one extra click
 * beats an error toast.
 */
function pickUrl(target: PortalTarget, urls: LsSubscriptionUrls): string | undefined {
  if (target === "update") return urls.updatePaymentMethod ?? urls.customerPortal;
  if (target === "change-plan") return urls.changePlan ?? urls.customerPortal;
  return urls.customerPortal;
}

/**
 * POST /api/billing/portal
 *
 * Auth: `Authorization: Bearer <firebase-id-token>`
 * Body (optional): `{ "target": "portal" | "update" | "change-plan" }`
 *
 * Returns a Lemon Squeezy hosted-page URL for the calling user. The caller
 * opens it in the system browser (never inside the app window — the user has
 * to be able to see the real address bar on a payment page).
 *
 * **Freshness matters here.** LS signs these URLs and they expire ~24h after
 * issue, so the copies our webhook stored are usually stale. We ask LS for
 * current ones at request time and only fall back to the stored values when
 * that call fails — which keeps the buttons working on a plan bought months
 * ago. Fresh URLs are written back to `subscriptions/{uid}` so the fallback
 * itself keeps improving.
 *
 * 404s with a clear message if the user has no subscription record (free).
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

    // Older callers POST with no body at all; that means "portal".
    const target = parseTarget(
      ((await req.json().catch(() => null)) as { target?: unknown } | null)?.target
    );

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

    // The stored URLs are the safety net, not the answer.
    const stored: LsSubscriptionUrls = {
      customerPortal: sub.customerPortalUrl,
      updatePaymentMethod: sub.updateUrl,
    };

    let urls = stored;
    if (sub.lemonSubscriptionId) {
      try {
        const fresh = await fetchSubscriptionUrls(sub.lemonSubscriptionId);
        // Merge rather than replace: if LS omits a field, the stored one
        // is still better than nothing.
        urls = {
          customerPortal: fresh.customerPortal ?? stored.customerPortal,
          updatePaymentMethod: fresh.updatePaymentMethod ?? stored.updatePaymentMethod,
          changePlan: fresh.changePlan,
        };
        // Best-effort cache refresh — never block the redirect on this write.
        const patch: Partial<Subscription> = {};
        if (fresh.customerPortal && fresh.customerPortal !== sub.customerPortalUrl) {
          patch.customerPortalUrl = fresh.customerPortal;
        }
        if (fresh.updatePaymentMethod && fresh.updatePaymentMethod !== sub.updateUrl) {
          patch.updateUrl = fresh.updatePaymentMethod;
        }
        if (Object.keys(patch).length > 0) {
          void db
            .doc(`subscriptions/${uid}`)
            .set(patch, { merge: true })
            .catch((err) => console.warn("[billing/portal] url cache refresh failed", err));
        }
      } catch (err) {
        // Degraded, not broken: fall through to the stored URLs.
        console.warn("[billing/portal] live URL fetch failed, using stored", err);
      }
    }

    const url = pickUrl(target, urls);
    if (!url) {
      return NextResponse.json(
        { error: "Billing portal isn't ready yet — try again in a moment." },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, url, target });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Portal lookup failed.";
    console.error("[billing/portal] failed", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
