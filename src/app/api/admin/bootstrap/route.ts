/**
 * POST /api/admin/bootstrap
 *
 * Self-service custom-claim bootstrap. When called by a user whose email is on
 * the `ADMIN_EMAILS` allow-list (verified by `requireAdmin`), sets the
 * `admin: true` custom claim on their account. This is OPTIONAL defense-in-
 * depth — the email check alone already gates everything, so there's no
 * lockout risk if it's never called. After bootstrapping, the user must
 * refresh their ID token (`getIdToken(true)`) for the claim to take effect.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  try {
    const { auth } = getAdmin();
    const user = await auth.getUser(admin.uid);
    await auth.setCustomUserClaims(admin.uid, {
      ...(user.customClaims ?? {}),
      admin: true,
    });
    return NextResponse.json({
      ok: true,
      uid: admin.uid,
      message: "admin claim set — refresh your session to pick it up",
    });
  } catch (err) {
    console.error("[admin/bootstrap] failed", err);
    return NextResponse.json({ error: "Failed to set admin claim" }, { status: 500 });
  }
}
