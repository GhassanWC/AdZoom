/**
 * GET /api/admin/analysis
 *   ?status=&search=&range=&from=&to=&page=&pageSize=
 *
 * Cross-user analysis-job list + aggregates, from `users/{uid}/analysisJobs`.
 *
 * TWO SCHEMA TRAPS THIS ROUTE HANDLES
 * -----------------------------------
 * 1. `startedAt` is written as `Date.now()` — a plain NUMBER — because the
 *    orchestrator runs client-side (src/lib/firebase/analysis-jobs.ts:36).
 *    Every other admin collection uses `serverTimestamp()`. Firestore sorts all
 *    numbers before all timestamps, so a `Timestamp` range bound here matches
 *    ZERO documents and the page silently renders empty. Hence
 *    `encoding: "number"`.
 *
 * 2. `AnalysisJob.duration` is the WHOLE-VIDEO LENGTH in seconds
 *    (schema.ts:1341), not processing time. The previous route averaged it and
 *    labelled the result "Avg time", so the dashboard reported how long users'
 *    videos were and called it analysis throughput. Real processing time is
 *    `completedAt − startedAt`, computed below as `processingMs` and only for
 *    jobs that actually completed.
 *
 * Cards, charts and table all derive from one `scanWindow` — see the
 * consistency contract documented in the exports route.
 */

import { getAdmin } from "@/lib/firebase/admin";
import { adminRoute } from "@/lib/admin/handler";
import { scanWindow, paginate, uidFromSubDoc } from "@/lib/admin/scan";
import { parseListParams, matchesSearch } from "@/lib/admin/params";
import { tsToMillis } from "@/lib/admin/serialize";
import { mapSafe, str, num, oneOf } from "@/lib/admin/validate";
import { tally, toSlices, averageOf, medianOf, bucketByDay } from "@/lib/admin/aggregate";
import type { AnalysisJobStatus } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JOB_STATUSES: readonly AnalysisJobStatus[] = [
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
];

interface AnalysisRow {
  id: string;
  uid: string;
  projectId: string;
  projectTitle: string;
  status: AnalysisJobStatus;
  engine: string;
  chunkMode: string;
  chunkCount: number;
  completedCount: number;
  failedCount: number;
  progress: number;
  /** Whole-video length in seconds — NOT processing time. */
  videoSeconds: number;
  momentsSoFar: number;
  startedAt: number;
  completedAt: number | null;
  /** Wall-clock processing time. Null while the job is still running. */
  processingMs: number | null;
}

export const GET = adminRoute("analysis", async (req) => {
  const { db } = getAdmin();
  const p = parseListParams(req.nextUrl.searchParams);

  const { docs, truncated, scanned } = await scanWindow({
    query: db.collectionGroup("analysisJobs"),
    orderField: "startedAt",
    encoding: "number", // see the header note — this is not a Timestamp field
    fromMs: p.fromMs,
    toMs: p.toMs,
    label: "analysis",
  });

  const { rows: all, skipped } = mapSafe(
    docs,
    (d): AnalysisRow => {
      const data = d.data();
      const startedAt = tsToMillis(data.startedAt as never);
      const completedAt = tsToMillis(data.completedAt as never) || null;
      return {
        id: d.id,
        uid: uidFromSubDoc(d.ref),
        projectId: str(data.projectId),
        projectTitle: str(data.projectTitle, "Untitled"),
        status: oneOf<AnalysisJobStatus>(data.status, JOB_STATUSES, "queued"),
        engine: str(data.engine, "unknown"),
        chunkMode: str(data.chunkMode, "unknown"),
        chunkCount: num(data.chunkCount),
        completedCount: num(data.completedCount),
        failedCount: num(data.failedCount),
        progress: num(data.progress),
        videoSeconds: num(data.duration),
        momentsSoFar: num(data.momentsSoFar),
        startedAt,
        completedAt,
        processingMs:
          completedAt && startedAt && completedAt > startedAt
            ? completedAt - startedAt
            : null,
      };
    },
    "analysis"
  );

  const byStatus = tally(all, (r) => r.status, JOB_STATUSES);

  // Throughput stats over COMPLETED jobs only — a queued job has no processing
  // time, and including running jobs would report a growing partial elapsed.
  const completed = all.filter((r) => r.status === "complete" && r.processingMs != null);

  const summary = {
    byStatus,
    byEngine: toSlices(tally(all, (r) => r.engine), { topN: 6 }),
    byChunkMode: toSlices(tally(all, (r) => r.chunkMode), { topN: 6 }),
    avgProcessingMs: averageOf(completed, (r) => r.processingMs),
    medianProcessingMs: medianOf(completed, (r) => r.processingMs),
    /** Average source-video length — reported separately, NOT as "avg time". */
    avgVideoSeconds: averageOf(all, (r) => (r.videoSeconds > 0 ? r.videoSeconds : null)),
    avgChunksPerJob: averageOf(all, (r) => (r.chunkCount > 0 ? r.chunkCount : null)),
    completedSample: completed.length,
    perDay: bucketByDay(all, (r) => r.startedAt, { fromMs: p.fromMs, toMs: p.toMs }),
  };

  const filtered = all.filter(
    (r) =>
      (!p.status || r.status === p.status) &&
      matchesSearch(p.search, r.projectTitle, r.uid, r.projectId, r.id)
  );

  const page = paginate(filtered, p.page, p.pageSize);

  return {
    rows: page.rows,
    page: page.page,
    pageCount: page.pageCount,
    pageSize: p.pageSize,
    filteredTotal: page.total,
    windowTotal: all.length,
    summary,
    truncated,
    scanned,
    skipped,
    range: { fromMs: p.fromMs, toMs: p.toMs, key: p.range },
    generatedAt: Date.now(),
  };
});
