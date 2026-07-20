/**
 * GET /api/admin/projects
 *   ?status=&search=&range=&from=&to=&page=&pageSize=
 *
 * Cross-user project list + aggregates, from `users/{uid}/projects`. The owning
 * uid is recovered from each doc's grandparent (`users/{uid}/projects/{id}`).
 *
 * This page previously had NO aggregates at all — just a table. It now reports
 * total / recently-created / analyzed / exported, all derived from the same
 * scan that feeds the table (see the consistency contract in the exports route).
 *
 * "analyzed" and "exported" come from `ProjectStatus` and the embedded
 * `analysis.status`, so no cross-collection join is needed: the project
 * lifecycle already records both (schema.ts:25-48).
 */

import { getAdmin } from "@/lib/firebase/admin";
import { adminRoute } from "@/lib/admin/handler";
import { scanWindow, paginate, uidFromSubDoc } from "@/lib/admin/scan";
import { parseListParams, matchesSearch } from "@/lib/admin/params";
import { tsToMillis } from "@/lib/admin/serialize";
import { mapSafe, str, numOrNull, oneOf, plainObject } from "@/lib/admin/validate";
import { tally, toSlices, countWhere, averageOf, bucketByDay } from "@/lib/admin/aggregate";
import type { AnalysisStatus, ProjectStatus } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROJECT_STATUSES: readonly ProjectStatus[] = [
  "uploading",
  "uploaded",
  "scanning_frames",
  "preparing",
  "uploading_to_gemini",
  "extracting_frames",
  "analyzing",
  "generating_timeline",
  "generating_presets",
  "analyzed",
  "completed",
  "exporting",
  "exported",
  "cancelled",
  "failed",
];

const ANALYSIS_STATUSES: readonly AnalysisStatus[] = [
  "idle",
  "queued",
  "analyzing",
  "complete",
  "cancelled",
  "failed",
];

/** Statuses meaning "analysis finished successfully at least once". */
const ANALYZED_STATUSES: readonly ProjectStatus[] = [
  "analyzed",
  "completed",
  "exporting",
  "exported",
];

const RECENT_WINDOW_MS = 7 * 86_400_000;

interface ProjectRow {
  id: string;
  uid: string;
  title: string;
  status: ProjectStatus;
  analysisStatus: AnalysisStatus | null;
  duration: number | null;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: number;
  updatedAt: number;
}

export const GET = adminRoute("projects", async (req) => {
  const { db } = getAdmin();
  const p = parseListParams(req.nextUrl.searchParams);
  const now = Date.now();

  // FIELD PROJECTION IS NOT OPTIONAL HERE.
  // `ProjectDoc.analysis` embeds detectedMoments, rawMoments, attentionCurve,
  // the full transcript with word-level timings, per-second loudness arrays and
  // editDiagnostics (schema.ts:1206-1313) — often megabytes per document. The
  // old route deserialized that entire map for every row just to read
  // `detectedMoments.length`. Scanning a window of up to 4000 projects that way
  // would move tens of megabytes per request. `.select()` fetches only the
  // fields below (`analysis.status` is a nested path), so the read stays small.
  //
  // The trade: per-project moment COUNT is no longer in the list payload. It
  // needs the whole moments array, and it is already available per project from
  // GET /api/admin/projects/[id], which the row click opens.
  const { docs, truncated, scanned } = await scanWindow({
    query: db
      .collectionGroup("projects")
      .select(
        "title",
        "status",
        "createdAt",
        "updatedAt",
        "duration",
        "fileSize",
        "mimeType",
        "analysis.status"
      ),
    orderField: "createdAt",
    encoding: "timestamp", // projects.ts:164 writes serverTimestamp()
    fromMs: p.fromMs,
    toMs: p.toMs,
    label: "projects",
  });

  const { rows: all, skipped } = mapSafe(
    docs,
    (d): ProjectRow => {
      const data = d.data();
      // `analysis` is a nested map older docs may omit entirely; with the
      // projection above it arrives holding only `status`.
      const analysis = plainObject(data.analysis);
      const rawAnalysisStatus = analysis.status;
      return {
        id: d.id,
        uid: uidFromSubDoc(d.ref),
        title: str(data.title, "Untitled"),
        status: oneOf<ProjectStatus>(data.status, PROJECT_STATUSES, "uploaded"),
        analysisStatus:
          typeof rawAnalysisStatus === "string"
            ? oneOf<AnalysisStatus>(rawAnalysisStatus, ANALYSIS_STATUSES, "idle")
            : null,
        duration: numOrNull(data.duration),
        fileSize: numOrNull(data.fileSize),
        mimeType: str(data.mimeType) || null,
        createdAt: tsToMillis(data.createdAt as never),
        updatedAt: tsToMillis(data.updatedAt as never),
      };
    },
    "projects"
  );

  const byStatus = tally(all, (r) => r.status, PROJECT_STATUSES);

  const summary = {
    byStatus,
    byStatusSlices: toSlices(byStatus, { topN: 8, dropZero: true }),
    byAnalysisStatus: toSlices(
      tally(all, (r) => r.analysisStatus ?? "not started"),
      { topN: 8, dropZero: true }
    ),
    recent: countWhere(all, (r) => r.createdAt > 0 && now - r.createdAt <= RECENT_WINDOW_MS),
    analyzed: countWhere(
      all,
      (r) => r.analysisStatus === "complete" || ANALYZED_STATUSES.includes(r.status)
    ),
    exported: countWhere(all, (r) => r.status === "exported"),
    failed: countWhere(all, (r) => r.status === "failed"),
    totalBytes: all.reduce((sum, r) => sum + (r.fileSize ?? 0), 0),
    avgDurationSeconds: averageOf(all, (r) => (r.duration && r.duration > 0 ? r.duration : null)),
    perDay: bucketByDay(all, (r) => r.createdAt, { fromMs: p.fromMs, toMs: p.toMs }),
  };

  const filtered = all.filter(
    (r) =>
      (!p.status || r.status === p.status) &&
      matchesSearch(p.search, r.title, r.uid, r.id)
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
