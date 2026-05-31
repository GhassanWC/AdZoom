/**
 * API key issuance endpoint.
 *
 *   POST /api/settings/api-keys
 *   Authorization: Bearer <firebase-id-token>
 *   Body: { name: string, type: "test" | "live" }
 *
 * Returns the newly minted plaintext key ONCE — the client is
 * responsible for showing it to the user and warning them it won't be
 * shown again. Server only stores a SHA-256 hash. Lost keys can't be
 * recovered; create a new one.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { createApiKey, type ApiKeyType } from "@/lib/firebase/api-keys-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) {
    return NextResponse.json(
      { error: "Missing Authorization header" },
      { status: 401 }
    );
  }
  const { auth } = getAdmin();
  let uid: string;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    console.error("[api-keys/create] token verify failed", err);
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    name?: unknown;
    type?: unknown;
  };
  const name = typeof body.name === "string" ? body.name : "";
  const typeRaw = typeof body.type === "string" ? body.type : "";
  if (typeRaw !== "test" && typeRaw !== "live") {
    return NextResponse.json(
      { error: "type must be 'test' or 'live'" },
      { status: 400 }
    );
  }
  if (!name.trim()) {
    return NextResponse.json(
      { error: "name is required" },
      { status: 400 }
    );
  }

  try {
    const { plaintext, meta } = await createApiKey(uid, {
      name,
      type: typeRaw as ApiKeyType,
    });
    return NextResponse.json({ plaintext, key: meta }, { status: 201 });
  } catch (err) {
    console.error("[api-keys/create] failed", err);
    return NextResponse.json(
      { error: "Failed to create API key" },
      { status: 500 }
    );
  }
}
