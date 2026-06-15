/**
 * GET /api/admin/events?eventName=&userId=&limit=100&cursor=<docPath>
 *
 * Raw analytics event stream + a "top events" tally from a recent sample.
 * Supports filtering by a single field server-side (eventName OR userId, via
 * the composite indexes); if both are given, eventName drives the query and
 * userId is applied in-memory for the returned page.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";
import { isIndexError } from "@/lib/admin/query";
import { tsToMillis } from "@/lib/admin/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;
const TOP_SAMPLE = 1000;

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { db } = getAdmin();
  const sp = req.nextUrl.searchParams;
  const eventName = sp.get("eventName") || "";
  const userId = sp.get("userId") || "";
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || DEFAULT_LIMIT));
  const cursor = sp.get("cursor");

  try {
    const col = db.collection("analyticsEvents");

    // Top events tally from a recent sample (best-effort).
    const topEvents: { eventName: string; count: number }[] = [];
    try {
      const sample = await col.orderBy("timestamp", "desc").limit(TOP_SAMPLE).get();
      const tally = new Map<string, number>();
      for (const d of sample.docs) {
        const name = (d.data().eventName as string) ?? "unknown";
        tally.set(name, (tally.get(name) ?? 0) + 1);
      }
      topEvents.push(
        ...[...tally.entries()]
          .map(([name, count]) => ({ eventName: name, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20)
      );
    } catch (err) {
      console.error("[admin/events] top sample failed", err);
    }

    // Server-side filter: prefer eventName, else userId.
    let q: FirebaseFirestore.Query = col;
    const serverFilter = eventName ? "eventName" : userId ? "userId" : null;
    if (serverFilter === "eventName") q = q.where("eventName", "==", eventName);
    else if (serverFilter === "userId") q = q.where("userId", "==", userId);
    q = q.orderBy("timestamp", "desc");

    if (cursor) {
      const curSnap = await db.doc(cursor).get();
      if (curSnap.exists) q = q.startAfter(curSnap);
    }

    const snap = await q.limit(limit).get();
    let rows = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        eventName: (data.eventName as string) ?? "unknown",
        userId: (data.userId as string) ?? "",
        userEmail: (data.userEmail as string | null) ?? null,
        projectId: (data.projectId as string | null) ?? null,
        plan: (data.plan as string | null) ?? null,
        environment: (data.environment as string) ?? "production",
        metadata: (data.metadata as Record<string, unknown>) ?? {},
        timestamp: tsToMillis(data.timestamp as never),
      };
    });

    // If both filters were given, narrow the page by userId in-memory.
    if (eventName && userId) rows = rows.filter((r) => r.userId === userId);

    const nextCursor =
      snap.docs.length === limit ? snap.docs[snap.docs.length - 1].ref.path : null;

    return NextResponse.json({ rows, nextCursor, topEvents });
  } catch (err) {
    if (isIndexError(err)) {
      return NextResponse.json({ rows: [], nextCursor: null, topEvents: [], indexBuilding: true });
    }
    console.error("[admin/events] failed", err);
    return NextResponse.json({ error: "Failed to load events" }, { status: 500 });
  }
}
