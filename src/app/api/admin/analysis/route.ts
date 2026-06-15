/**
 * GET /api/admin/analysis?status=<AnalysisJobStatus>&limit=50&cursor=<docPath>
 *
 * Cross-user analysis-job list + aggregate summary (status breakdown, engine
 * usage, chunk-mode distribution, average duration). Collection-group query
 * over users/{uid}/analysisJobs. Note: AnalysisJob orders by `startedAt`
 * (it has no `createdAt`).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";
import { isIndexError, safeCount, uidFromSubDoc } from "@/lib/admin/query";
import { tsToMillis } from "@/lib/admin/serialize";
import type { AnalysisJobStatus, CvEngineKind } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SUMMARY_SAMPLE = 1000;

const JOB_STATUSES: AnalysisJobStatus[] = [
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
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
    const group = db.collectionGroup("analysisJobs");

    // Status breakdown via cheap counts (composite [status, startedAt] index).
    const statusCounts = await Promise.all(
      JOB_STATUSES.map((s) => safeCount(group.where("status", "==", s)))
    );
    const statusBreakdown = Object.fromEntries(
      JOB_STATUSES.map((s, i) => [s, statusCounts[i] ?? 0])
    ) as Record<AnalysisJobStatus, number>;

    // Engine + chunk-mode distribution + avg duration from a bounded sample.
    const engineUsage: Record<string, number> = {};
    const chunkModes: Record<string, number> = {};
    let durSum = 0;
    let durN = 0;
    let chunkSum = 0;
    let chunkN = 0;
    try {
      const sample = await group.orderBy("startedAt", "desc").limit(SUMMARY_SAMPLE).get();
      for (const d of sample.docs) {
        const data = d.data();
        const engine = (data.engine as CvEngineKind) ?? "unknown";
        engineUsage[engine] = (engineUsage[engine] ?? 0) + 1;
        const mode = (data.chunkMode as string) ?? "unknown";
        chunkModes[mode] = (chunkModes[mode] ?? 0) + 1;
        const dur = data.duration as number | undefined;
        if (typeof dur === "number" && dur > 0) {
          durSum += dur;
          durN += 1;
        }
        const cc = data.chunkCount as number | undefined;
        if (typeof cc === "number" && cc > 0) {
          chunkSum += cc;
          chunkN += 1;
        }
      }
    } catch (err) {
      console.error("[admin/analysis] summary sample failed", err);
    }

    // Paginated rows.
    let q: FirebaseFirestore.Query = group;
    if (status) q = q.where("status", "==", status);
    q = q.orderBy("startedAt", "desc");
    if (cursor) {
      const curSnap = await db.doc(cursor).get();
      if (curSnap.exists) q = q.startAfter(curSnap);
    }
    const snap = await q.limit(limit).get();
    const rows = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        uid: uidFromSubDoc(d.ref),
        projectId: (data.projectId as string) ?? "",
        projectTitle: (data.projectTitle as string) ?? "Untitled",
        status: (data.status as AnalysisJobStatus) ?? "queued",
        engine: (data.engine as CvEngineKind) ?? null,
        chunkMode: (data.chunkMode as string | null) ?? null,
        chunkCount: (data.chunkCount as number) ?? 0,
        completedCount: (data.completedCount as number) ?? 0,
        failedCount: (data.failedCount as number) ?? 0,
        progress: (data.progress as number) ?? 0,
        duration: (data.duration as number) ?? 0,
        startedAt: tsToMillis(data.startedAt as never),
        completedAt: tsToMillis(data.completedAt as never),
      };
    });

    const nextCursor =
      snap.docs.length === limit ? snap.docs[snap.docs.length - 1].ref.path : null;

    return NextResponse.json({
      rows,
      nextCursor,
      statusBreakdown,
      engineUsage,
      chunkModes,
      avgDurationSeconds: durN ? Math.round(durSum / durN) : 0,
      avgChunksPerVideo: chunkN ? Number((chunkSum / chunkN).toFixed(1)) : 0,
    });
  } catch (err) {
    if (isIndexError(err)) {
      return NextResponse.json({
        rows: [],
        nextCursor: null,
        statusBreakdown: {},
        engineUsage: {},
        chunkModes: {},
        avgDurationSeconds: 0,
        avgChunksPerVideo: 0,
        indexBuilding: true,
      });
    }
    console.error("[admin/analysis] failed", err);
    return NextResponse.json({ error: "Failed to load analysis jobs" }, { status: 500 });
  }
}
