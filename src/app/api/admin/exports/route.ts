/**
 * GET /api/admin/exports?status=<ExportStatus>&limit=50&cursor=<docPath>
 *
 * Cross-user export list + aggregates (status breakdown, format distribution,
 * watermark usage). Collection-group query over users/{uid}/exports.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";
import { isIndexError, safeCount, uidFromSubDoc } from "@/lib/admin/query";
import { tsToMillis } from "@/lib/admin/serialize";
import type { ExportStatus } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SUMMARY_SAMPLE = 1000;

const EXPORT_STATUSES: ExportStatus[] = [
  "queued",
  "permitted",
  "exporting",
  "ready",
  "failed",
];

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { db } = getAdmin();
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || DEFAULT_LIMIT));
  const cursor = sp.get("cursor");

  try {
    const group = db.collectionGroup("exports");

    const statusCounts = await Promise.all(
      EXPORT_STATUSES.map((s) => safeCount(group.where("status", "==", s)))
    );
    const byStatus = Object.fromEntries(
      EXPORT_STATUSES.map((s, i) => [s, statusCounts[i] ?? 0])
    ) as Record<ExportStatus, number>;

    // Format + watermark distribution from a bounded recent sample.
    const byFormat: Record<string, number> = {};
    const byResolution: Record<string, number> = {};
    let watermarked = 0;
    try {
      const sample = await group.orderBy("createdAt", "desc").limit(SUMMARY_SAMPLE).get();
      for (const d of sample.docs) {
        const data = d.data();
        const fmt = (data.format as string) ?? "unknown";
        byFormat[fmt] = (byFormat[fmt] ?? 0) + 1;
        const res = (data.resolution as string) ?? "unknown";
        byResolution[res] = (byResolution[res] ?? 0) + 1;
        if (data.applyWatermark === true) watermarked += 1;
      }
    } catch (err) {
      console.error("[admin/exports] summary sample failed", err);
    }

    let q: FirebaseFirestore.Query = group;
    if (status) q = q.where("status", "==", status);
    q = q.orderBy("createdAt", "desc");
    if (cursor) {
      const curSnap = await db.doc(cursor).get();
      if (curSnap.exists) q = q.startAfter(curSnap);
    }
    const snap = await q.limit(limit).get();
    const rows = snap.docs.map((d) => {
      const data = d.data();
      const createdAt = tsToMillis(data.createdAt as never);
      const completedAt = tsToMillis(data.completedAt as never);
      return {
        id: d.id,
        uid: uidFromSubDoc(d.ref),
        projectId: (data.projectId as string) ?? "",
        projectTitle: (data.projectTitle as string) ?? "Untitled",
        format: (data.format as string) ?? "unknown",
        resolution: (data.resolution as string) ?? "1080p",
        fps: (data.fps as number) ?? 30,
        status: (data.status as ExportStatus) ?? "queued",
        applyWatermark: data.applyWatermark === true,
        fileSize: (data.fileSize as number | null) ?? null,
        monthlyBucket: (data.monthlyBucket as string | null) ?? null,
        errorMessage: (data.errorMessage as string | null) ?? null,
        createdAt,
        completedAt,
        durationMs: completedAt && createdAt ? completedAt - createdAt : null,
      };
    });

    const nextCursor =
      snap.docs.length === limit ? snap.docs[snap.docs.length - 1].ref.path : null;

    return NextResponse.json({
      rows,
      nextCursor,
      byStatus,
      byFormat,
      byResolution,
      watermarked,
    });
  } catch (err) {
    if (isIndexError(err)) {
      return NextResponse.json({
        rows: [],
        nextCursor: null,
        byStatus: {},
        byFormat: {},
        byResolution: {},
        watermarked: 0,
        indexBuilding: true,
      });
    }
    console.error("[admin/exports] failed", err);
    return NextResponse.json({ error: "Failed to load exports" }, { status: 500 });
  }
}
