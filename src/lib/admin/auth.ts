import "server-only";

/**
 * Server-side admin gate for `/api/admin/*` routes.
 *
 * Verifies the Firebase ID token (401 if missing/invalid) and confirms the
 * caller is an admin — either by email allow-list OR a custom `admin: true`
 * claim (403 otherwise). The email check is the primary path so the dashboard
 * works without ever bootstrapping a claim; the claim is a defense-in-depth
 * accelerant set by `/api/admin/bootstrap`.
 *
 * Mirrors the token-verification pattern used across the app, e.g.
 * `src/app/api/settings/api-keys/route.ts`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { isAdminEmail } from "./constants";

export interface AdminIdentity {
  uid: string;
  email: string;
}

/**
 * Returns the decoded admin identity, or a ready-to-return `NextResponse`
 * (401 / 403). Call site:
 *
 *   const admin = await requireAdmin(req);
 *   if (admin instanceof NextResponse) return admin;
 *   // ...admin.uid / admin.email are now trusted
 */
export async function requireAdmin(
  req: NextRequest
): Promise<AdminIdentity | NextResponse> {
  const authHeader = req.headers.get("authorization") || "";
  const idToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;
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
    console.error("[admin/auth] token verify failed", err);
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const email = decoded.email ?? null;
  const hasAdminClaim = decoded.admin === true;
  if (!isAdminEmail(email) && !hasAdminClaim) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return { uid: decoded.uid, email: email ?? "" };
}
