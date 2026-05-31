import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  Subscription,
  SubscriptionStatus,
} from "@/lib/firebase/schema";
import { variantIdToPlan } from "./client";

/**
 * Verify a Lemon Squeezy webhook signature.
 *
 * LS sends an `X-Signature` header containing an HMAC-SHA256 hex digest of
 * the raw request body, keyed with the webhook's signing secret. We MUST
 * compute the HMAC against the raw bytes — JSON-parse-and-re-stringify
 * mangles whitespace and breaks verification.
 *
 * Comparison uses `timingSafeEqual` to avoid leaking secret-bit timing.
 */
export function verifyLemonSqueezySignature(
  rawBody: string,
  signature: string | null
): boolean {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[ls/webhook] LEMONSQUEEZY_WEBHOOK_SECRET is not set");
    return false;
  }
  if (!signature) return false;

  let expected: Buffer;
  let received: Buffer;
  try {
    expected = Buffer.from(
      createHmac("sha256", secret).update(rawBody).digest("hex"),
      "hex"
    );
    received = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

/** Events we react to. Anything else is logged and acked. */
export type LsEvent =
  | "subscription_created"
  | "subscription_updated"
  | "subscription_cancelled"
  | "subscription_resumed"
  | "subscription_expired"
  | "subscription_paused"
  | "subscription_unpaused"
  | "subscription_payment_success";

/** LS webhook payload — only the fields we read. Other fields are ignored. */
export interface LsWebhookPayload {
  meta: {
    event_name: string;
    webhook_id?: string;
    custom_data?: { user_id?: string } | null;
  };
  data: {
    id: string;
    type: string;
    attributes: {
      status?: string;
      status_formatted?: string;
      customer_id?: number | string;
      variant_id?: number | string;
      renews_at?: string | null;
      ends_at?: string | null;
      trial_ends_at?: string | null;
      urls?: {
        customer_portal?: string;
        update_payment_method?: string;
      };
    };
  };
}

const LS_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: "active",
  on_trial: "on_trial",
  paused: "paused",
  past_due: "past_due",
  unpaid: "unpaid",
  cancelled: "cancelled",
  expired: "expired",
};

/**
 * Map an LS `attributes.status` string to our enum.
 *
 * Defaults are *conservative*: an undefined or unknown status flags as
 * `"past_due"` rather than `"active"`. The previous default of `"active"`
 * would silently promote a malformed payload — that's the wrong direction
 * for a billing surface. Genuine "still paying" deliveries always carry a
 * known status, so this default only fires on garbled input where
 * pessimism is safer.
 */
export function mapStatus(lsStatus: string | undefined): SubscriptionStatus {
  if (!lsStatus) return "past_due";
  const mapped = LS_STATUS_MAP[lsStatus];
  if (!mapped) {
    console.warn(
      `[ls/webhook] unknown LS status "${lsStatus}" — defaulting to past_due`
    );
    return "past_due";
  }
  return mapped;
}

/** Parse an ISO timestamp into epoch ms, returning undefined for null/garbage. */
function toEpochMs(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Stable composite idempotency key — unique per webhook *delivery*. */
export function eventIdFor(payload: LsWebhookPayload): string {
  const name = payload.meta.event_name ?? "unknown";
  const id = payload.data.id ?? "noid";
  const hook = payload.meta.webhook_id ?? "global";
  return `${name}:${id}:${hook}`;
}

export interface ReducedSubscription {
  /** Patch to merge into `subscriptions/{uid}`. */
  patch: Partial<Subscription>;
  /**
   * The plan the user *currently* has access to. Mirrored to
   * `users/{uid}.plan`. May be the paid tier (still within paid period) or
   * `"free"` (subscription has fully lapsed).
   */
  effectivePlan: "free" | "creator" | "pro";
}

/**
 * Pure state reducer: take an LS event + payload, return the patch we
 * should write to `subscriptions/{uid}` and the current effective plan.
 *
 * Plan downgrade policy (conservative — when in doubt, downgrade):
 *   • `subscription_expired` event OR `expired` status     → free
 *   • `unpaid` status (LS dunning exhausted)               → free
 *   • `paused` status (customer paused, not paying)        → free
 *   • `cancelled` event with `endsAt` already in the past  → free
 *   • `cancelled` with future `endsAt`                     → keep paid plan
 *   • `past_due` (grace period — LS still retrying)        → keep paid plan
 *   • `active` / `on_trial`                                → variant plan
 *   • Any unmapped state                                   → keep PREVIOUS
 *     plan (return `effectivePlan` from the variant lookup but log a warn).
 */
export function reduceSubscription(
  event: LsEvent,
  payload: LsWebhookPayload,
  now = Date.now()
): ReducedSubscription {
  const attrs = payload.data.attributes;
  const variantId = String(attrs.variant_id ?? "");
  const planFromVariant = variantId ? variantIdToPlan(variantId) : "free";
  const status = mapStatus(attrs.status);
  const endsAt = toEpochMs(attrs.ends_at);

  // Determine the access-effective plan.
  let effectivePlan: "free" | "creator" | "pro" = planFromVariant;
  const downgradeStatuses: SubscriptionStatus[] = ["expired", "unpaid", "paused"];
  if (event === "subscription_expired" || downgradeStatuses.includes(status)) {
    effectivePlan = "free";
  } else if (event === "subscription_cancelled") {
    // Cancel keeps the paid plan until endsAt; defensive downgrade if endsAt
    // is already in the past.
    if (endsAt && endsAt <= now) effectivePlan = "free";
  }
  // active / on_trial / past_due / cancelled-with-future-endsAt all keep
  // `planFromVariant` set above.

  const patch: Partial<Subscription> = {
    plan: effectivePlan,
    status,
    variantId,
    lemonSubscriptionId: payload.data.id,
    lemonCustomerId: String(attrs.customer_id ?? ""),
    renewsAt: toEpochMs(attrs.renews_at),
    endsAt,
    trialEndsAt: toEpochMs(attrs.trial_ends_at),
    customerPortalUrl: attrs.urls?.customer_portal,
    updateUrl: attrs.urls?.update_payment_method,
    updatedAt: now,
  };

  return { patch, effectivePlan };
}

/** Type guard — narrows an arbitrary event name string to LsEvent. */
export function isHandledEvent(name: string): name is LsEvent {
  return (
    name === "subscription_created" ||
    name === "subscription_updated" ||
    name === "subscription_cancelled" ||
    name === "subscription_resumed" ||
    name === "subscription_expired" ||
    name === "subscription_paused" ||
    name === "subscription_unpaused" ||
    name === "subscription_payment_success"
  );
}
