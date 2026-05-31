/**
 * GET /api/v1/me — public API "whoami" endpoint.
 *
 * Reference implementation of API key auth — the same `validateApiKey`
 * helper backs every other `/api/v1/*` route that will follow. Intended
 * uses:
 *   - Smoke-test a freshly created key during onboarding.
 *   - Health-check a long-lived integration ("is my staging key still
 *     valid?").
 *   - Worked example for users writing their own clients.
 *
 * Usage:
 *
 *   curl -H "Authorization: Bearer ak_test_<your-key>" \
 *        https://your-app.example.com/api/v1/me
 *
 *   { "uid": "8EqH...", "keyId": "f7a2…", "type": "test" }
 *
 * Rejects missing / malformed / unknown / revoked keys with 401.
 * Never returns the plaintext; the response surface is the minimum
 * needed to confirm "the server recognises this key as yours".
 */

import { NextResponse, type NextRequest } from "next/server";
import { validateApiKey } from "@/lib/firebase/api-keys-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await validateApiKey(req.headers.get("authorization"));
  if (!auth) {
    return NextResponse.json(
      {
        error: "Invalid or revoked API key.",
        hint: "Send `Authorization: Bearer ak_test_…` (or `ak_live_…`).",
      },
      { status: 401 }
    );
  }
  return NextResponse.json({
    uid: auth.uid,
    keyId: auth.keyId,
    type: auth.type,
  });
}
