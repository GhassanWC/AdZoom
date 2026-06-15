/**
 * GET /api/admin/users?search=<emailPrefix>&limit=50&cursor=<docPath>
 *
 * Paginated user list. Per-user project/export counts are intentionally NOT
 * computed here (one count() per row across all users is expensive) — the
 * detail route `/api/admin/users/[uid]` computes them for a single user.
 *
 * Search is an email PREFIX match (Firestore has no substring search).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";
import { isIndexError } from "@/lib/admin/query";
import { tsToMillis } from "@/lib/admin/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { db } = getAdmin();
  const sp = req.nextUrl.searchParams;
  const search = (sp.get("search") || "").trim().toLowerCase();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || DEFAULT_LIMIT));
  const cursor = sp.get("cursor");

  try {
    const col = db.collection("users");
    // Email prefix search: [search, search+highSentinel) covers all strings
    // starting with `search`.  is a very high code point, so it sits
    // after any realistic email char.
    const PREFIX_END = "";
    let q: FirebaseFirestore.Query = search
      ? col
          .where("email", ">=", search)
          .where("email", "<", search + PREFIX_END)
          .orderBy("email", "asc")
      : col.orderBy("createdAt", "desc");

    if (cursor) {
      const curSnap = await db.doc(cursor).get();
      if (curSnap.exists) q = q.startAfter(curSnap);
    }

    const snap = await q.limit(limit).get();
    const rows = snap.docs.map((d) => {
      const data = d.data();
      return {
        uid: d.id,
        email: (data.email as string | null) ?? null,
        displayName: (data.displayName as string | null) ?? null,
        photoURL: (data.photoURL as string | null) ?? null,
        plan: (data.plan as string | undefined) ?? "free",
        createdAt: tsToMillis(data.createdAt as never),
        updatedAt: tsToMillis(data.updatedAt as never),
      };
    });

    const nextCursor =
      snap.docs.length === limit
        ? snap.docs[snap.docs.length - 1].ref.path
        : null;

    return NextResponse.json({ rows, nextCursor });
  } catch (err) {
    if (isIndexError(err)) {
      return NextResponse.json({ rows: [], nextCursor: null, indexBuilding: true });
    }
    console.error("[admin/users] failed", err);
    return NextResponse.json({ error: "Failed to load users" }, { status: 500 });
  }
}
