/**
 * Per-key API key mutations.
 *
 *   PATCH  /api/settings/api-keys/[id]  — rename
 *   DELETE /api/settings/api-keys/[id]  — revoke (soft-delete metadata + hard-delete index)
 *
 * Auth: `Authorization: Bearer <firebase-id-token>`. The key must
 * belong to the calling user; the server-side helpers re-check ownership
 * by writing under `users/{uid}/apiKeys/{id}`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { renameApiKey, revokeApiKey } from "@/lib/firebase/api-keys-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function verifyOwner(req: NextRequest): Promise<{ uid: string } | NextResponse> {
  const authHeader = req.headers.get("authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) {
    return NextResponse.json(
      { error: "Missing Authorization header" },
      { status: 401 }
    );
  }
  const { auth } = getAdmin();
  try {
    const decoded = await auth.verifyIdToken(idToken);
    return { uid: decoded.uid };
  } catch (err) {
    console.error("[api-keys/[id]] token verify failed", err);
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  const { id: keyId } = await params;
  const ownerOrResp = await verifyOwner(req);
  if (ownerOrResp instanceof NextResponse) return ownerOrResp;
  const { uid } = ownerOrResp;

  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name : "";
  if (!name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    await renameApiKey(uid, keyId, name);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "rename failed";
    const status = msg === "Key not found" ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  const { id: keyId } = await params;
  const ownerOrResp = await verifyOwner(req);
  if (ownerOrResp instanceof NextResponse) return ownerOrResp;
  const { uid } = ownerOrResp;

  try {
    await revokeApiKey(uid, keyId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "revoke failed";
    const status = msg === "Key not found" ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
