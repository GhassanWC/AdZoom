import "server-only";

/**
 * Centralised Lemon Squeezy env-var management.
 *
 * Why centralise: each of the LS routes (checkout, portal, webhook) needs
 * the same secret set. If one is missing, every route should fail with the
 * same, clear message rather than each rolling its own "ENV_X not set"
 * throw. The `assertBillingEnv()` helper is called at the top of each route
 * so the error surfaces immediately, not after the route does work.
 *
 * `getBillingEnvStatus()` is exposed read-only via `/api/billing/health` so
 * ops can verify deployment without exposing the values themselves.
 */

export const BILLING_ENV_KEYS = [
  "LEMONSQUEEZY_API_KEY",
  "LEMONSQUEEZY_STORE_ID",
  "LEMONSQUEEZY_CREATOR_VARIANT_ID",
  "LEMONSQUEEZY_PRO_VARIANT_ID",
  "LEMONSQUEEZY_WEBHOOK_SECRET",
] as const;

export type BillingEnvKey = (typeof BILLING_ENV_KEYS)[number];

export interface BillingEnvStatus {
  ok: boolean;
  missing: BillingEnvKey[];
  /** Non-prod env name for context; never includes the actual values. */
  environment: string;
}

export function getBillingEnvStatus(): BillingEnvStatus {
  const missing: BillingEnvKey[] = [];
  for (const key of BILLING_ENV_KEYS) {
    const v = process.env[key];
    if (!v || v.trim().length === 0) missing.push(key);
  }
  return {
    ok: missing.length === 0,
    missing,
    environment: process.env.NODE_ENV ?? "unknown",
  };
}

/**
 * Throws an `Error` listing every missing key. Caller (each LS route)
 * catches and converts to a 500 with the same message in dev; in prod the
 * caller can opt to log + return a generic 500.
 *
 * One throw = one log line in observability tooling, easy to alert on.
 */
export function assertBillingEnv(): void {
  const { ok, missing } = getBillingEnvStatus();
  if (!ok) {
    throw new Error(
      `Lemon Squeezy env not configured. Missing: ${missing.join(", ")}`
    );
  }
}
