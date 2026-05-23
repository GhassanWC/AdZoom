import "server-only";

import type { PlanTier } from "@/lib/usage/plan";

/**
 * Thin server-only Lemon Squeezy REST wrapper.
 *
 * Why hand-rolled instead of `@lemonsqueezy/lemonsqueezy.js`?
 *   • We only need two endpoints (checkouts + customer portal lookup).
 *   • Zero additional runtime dependency.
 *   • Easier to audit for the security-sensitive paths.
 *
 * All functions read their credentials from `process.env`; throwing at call
 * time (not module load) means a missing env var fails the request cleanly
 * rather than crashing the server boot.
 */

const LS_API = "https://api.lemonsqueezy.com/v1";

function headers(): HeadersInit {
  const key = process.env.LEMONSQUEEZY_API_KEY;
  if (!key) throw new Error("LEMONSQUEEZY_API_KEY is not set");
  return {
    Accept: "application/vnd.api+json",
    "Content-Type": "application/vnd.api+json",
    Authorization: `Bearer ${key}`,
  };
}

export interface CreateCheckoutOpts {
  variantId: string;
  /** Firebase uid — embedded as `custom_data.user_id` so the webhook can map back. */
  userId: string;
  /** Pre-fill the checkout's email field when known. */
  email?: string | null;
  /** Where LS sends the buyer after a successful purchase. */
  redirectUrl: string;
}

/**
 * Create a Lemon Squeezy checkout and return its hosted URL. The client
 * should `window.location = url` to send the user to LS's payment page.
 *
 * `custom_data.user_id` is the single source of truth that ties an LS
 * customer back to a Firebase uid — the webhook reads it from
 * `event.meta.custom_data.user_id`. If a checkout link is hit without it,
 * the webhook returns 400 (orphaned subscription).
 */
export async function createCheckout(
  opts: CreateCheckoutOpts
): Promise<{ url: string }> {
  const storeId = process.env.LEMONSQUEEZY_STORE_ID;
  if (!storeId) throw new Error("LEMONSQUEEZY_STORE_ID is not set");

  const body = {
    data: {
      type: "checkouts",
      attributes: {
        checkout_data: {
          email: opts.email ?? undefined,
          custom: { user_id: opts.userId },
        },
        product_options: { redirect_url: opts.redirectUrl },
      },
      relationships: {
        store: { data: { type: "stores", id: storeId } },
        variant: { data: { type: "variants", id: opts.variantId } },
      },
    },
  };

  const res = await fetch(`${LS_API}/checkouts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lemon Squeezy checkout failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as {
    data: { attributes: { url: string } };
  };
  return { url: json.data.attributes.url };
}

/**
 * Map an LS variant id back to our internal plan tier. Driven entirely by
 * env so the prod variant ids stay out of the codebase. Unknown variants
 * collapse to `"free"` — defensive: an orphaned webhook shouldn't elevate
 * a user.
 */
export function variantIdToPlan(variantId: string | number): PlanTier {
  const v = String(variantId);
  if (v === process.env.LEMONSQUEEZY_PRO_VARIANT_ID) return "pro";
  if (v === process.env.LEMONSQUEEZY_CREATOR_VARIANT_ID) return "creator";
  return "free";
}

/** Map our internal plan tier to its variant id. Throws for "free". */
export function planToVariantId(plan: "creator" | "pro"): string {
  const id =
    plan === "pro"
      ? process.env.LEMONSQUEEZY_PRO_VARIANT_ID
      : process.env.LEMONSQUEEZY_CREATOR_VARIANT_ID;
  if (!id) {
    throw new Error(
      `LEMONSQUEEZY_${plan.toUpperCase()}_VARIANT_ID is not set`
    );
  }
  return id;
}
