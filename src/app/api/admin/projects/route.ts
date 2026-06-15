/**
 * GET /api/admin/projects?status=<ProjectStatus>&limit=50&cursor=<docPath>
 *
 * Cross-user project list via a collection-group query over
 * users/{uid}/projects. The owning uid is recovered from each doc's parent.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";
import { isIndexError, uidFromSubDoc } from "@/lib/admin/query";
import { tsToMillis } from "@/lib/admin/serialize";
import type { Analysis, ProjectStatus } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { db } = getAdmin();
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || DEFAULT_LIMIT));
  const cursor = sp.get("cursor");

  try {
    let q: FirebaseFirestore.Query = db.collectionGroup("projects");
    if (status) q = q.where("status", "==", status);
    q = q.orderBy("createdAt", "desc");

    if (cursor) {
      const curSnap = await db.doc(cursor).get();
      if (curSnap.exists) q = q.startAfter(curSnap);
    }

    const snap = await q.limit(limit).get();
    const rows = snap.docs.map((d) => {
      const data = d.data();
      const analysis = data.analysis as Analysis | undefined;
      return {
        id: d.id,
        uid: uidFromSubDoc(d.ref),
        title: (data.title as string) ?? "Untitled",
        status: (data.status as ProjectStatus) ?? "uploaded",
        duration: (data.duration as number | null) ?? null,
        fileSize: (data.fileSize as number | null) ?? null,
        mimeType: (data.mimeType as string | null) ?? null,
        interactionScope: (data.interactionScope as string | null) ?? null,
        analysisStatus: analysis?.status ?? null,
        momentCount: analysis?.detectedMoments?.length ?? 0,
        createdAt: tsToMillis(data.createdAt as never),
        updatedAt: tsToMillis(data.updatedAt as never),
      };
    });

    const nextCursor =
      snap.docs.length === limit ? snap.docs[snap.docs.length - 1].ref.path : null;

    return NextResponse.json({ rows, nextCursor });
  } catch (err) {
    if (isIndexError(err)) {
      return NextResponse.json({ rows: [], nextCursor: null, indexBuilding: true });
    }
    console.error("[admin/projects] failed", err);
    return NextResponse.json({ error: "Failed to load projects" }, { status: 500 });
  }
}
