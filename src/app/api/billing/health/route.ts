import { NextResponse } from "next/server";
import { getBillingEnvStatus } from "@/lib/lemonsqueezy/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/billing/health
 *
 * Returns whether the Lemon Squeezy env vars are wired correctly. Does NOT
 * return the values themselves — only the names of any missing keys. Safe
 * to expose publicly; useful for ops smoke tests after deploy.
 *
 * Example responses:
 *   { ok: true, missing: [], environment: "production" }
 *   { ok: false, missing: ["LEMONSQUEEZY_WEBHOOK_SECRET"], environment: "development" }
 */
export async function GET() {
  return NextResponse.json(getBillingEnvStatus());
}
