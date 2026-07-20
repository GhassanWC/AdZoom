/**
 * GET /api/admin/exports
 *   ?status=&pipeline=browser|cloud&search=&range=&from=&to=&page=&pageSize=
 *
 * Cross-user export list + aggregates.
 *
 * BOTH EXPORT PIPELINES, NOT JUST ONE
 * -----------------------------------
 * Framevo renders through two entirely separate collections:
 *   • `users/{uid}/exports`     — free/browser renders (MediaRecorder/WebCodecs)
 *   • `users/{uid}/exportJobs`  — PAID cloud renders (schema.ts:2293)
 * This route previously read only the first, so every revenue-generating cloud
 * export — and every cloud failure — was invisible to the admin dashboard.
 * Both are scanned here and merged into one normalized row shape with a
 * `pipeline` discriminator, so "total exports" finally means total exports.
 *
 * STATUS NORMALIZATION
 * --------------------
 * The two collections have different (and differently spelled) status unions —
 * `ExportStatus` (schema.ts:2182) vs `ExportJobStatus` (schema.ts:2270), where
 * the latter uses "canceled" with one L. Charting them raw would produce two
 * "queued" buckets and a phantom "batch_submitted" segment. Each is mapped to a
 * shared 5-value vocabulary while `rawStatus` preserves the original for the
 * table, so the operator still sees "rendering" vs "uploading" per row.
 *
 * CONSISTENCY CONTRACT
 * --------------------
 * Cards, charts and table all derive from the SAME merged array:
 *   sum(summary.byStatus) === windowTotal
 *   summary.byStatus[s]   === filteredTotal   (when status=s, no other filter)
 * Asserted in tests/admin-aggregate.test.ts. The old route mixed `.count()`
 * aggregations (cards) with a 1000-doc sample (charts), which is why a full
 * table could sit under "Total exports: 0".
 */

import { getAdmin } from "@/lib/firebase/admin";
import { adminRoute } from "@/lib/admin/handler";
import { scanWindow, paginate, uidFromSubDoc } from "@/lib/admin/scan";
import { parseListParams, matchesSearch } from "@/lib/admin/params";
import { tsToMillis } from "@/lib/admin/serialize";
import { mapSafe, str, num, numOrNull, bool } from "@/lib/admin/validate";
import { tally, toSlices, countWhere, averageOf, medianOf, bucketByDay } from "@/lib/admin/aggregate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shared vocabulary both pipelines normalize into. */
export type NormalizedExportStatus =
  | "queued"
  | "processing"
  | "ready"
  | "failed"
  | "cancelled";

const NORMALIZED_STATUSES: readonly NormalizedExportStatus[] = [
  "queued",
  "processing",
  "ready",
  "failed",
  "cancelled",
];

/** `ExportStatus` (browser) → shared vocabulary. */
function normalizeBrowserStatus(raw: string): NormalizedExportStatus {
  switch (raw) {
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    case "exporting":
      return "processing";
    // "permitted" = permit issued, render not started ⇒ still queued work.
    case "queued":
    case "permitted":
      return "queued";
    default:
      return "queued";
  }
}

/** `ExportJobStatus` (cloud) → shared vocabulary. Note "canceled", one L. */
function normalizeCloudStatus(raw: string): NormalizedExportStatus {
  switch (raw) {
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    case "canceled":
      return "cancelled";
    case "batch_submitted":
    case "rendering":
    case "uploading":
      return "processing";
    case "queued":
      return "queued";
    default:
      return "queued";
  }
}

/**
 * Height → a resolution label matching the browser pipeline's vocabulary, so
 * both pipelines land in the same chart buckets instead of "1080p" vs "1920x1080".
 */
function resolutionLabel(height: number): string {
  if (height >= 2000) return "4K";
  if (height >= 1000) return "1080p";
  if (height >= 700) return "720p";
  if (height > 0) return `${height}p`;
  return "unknown";
}

interface ExportRow {
  id: string;
  uid: string;
  pipeline: "browser" | "cloud";
  projectId: string;
  projectTitle: string;
  format: string;
  resolution: string;
  fps: number;
  status: NormalizedExportStatus;
  /** Original per-pipeline status, e.g. "rendering", "permitted". */
  rawStatus: string;
  /** Fine-grained cloud worker stage; null for browser renders. */
  stage: string | null;
  applyWatermark: boolean;
  fileSize: number | null;
  errorMessage: string | null;
  errorCode: string | null;
  /** Billed output minutes — cloud only (browser renders don't consume quota). */
  exportMinutes: number | null;
  plan: string | null;
  createdAt: number;
  completedAt: number | null;
  /** completedAt − createdAt = queue time + render time. Labelled "Turnaround". */
  turnaroundMs: number | null;
}

export const GET = adminRoute("exports", async (req) => {
  const { db } = getAdmin();
  const p = parseListParams(req.nextUrl.searchParams);
  const pipeline = req.nextUrl.searchParams.get("pipeline") ?? "";

  // Both collections write createdAt via serverTimestamp() —
  // api/billing/export-permit:170 and lib/export/create-job.ts:656.
  const wantBrowser = pipeline !== "cloud";
  const wantCloud = pipeline !== "browser";

  const [browser, cloud] = await Promise.all([
    wantBrowser
      ? scanWindow({
          query: db.collectionGroup("exports"),
          orderField: "createdAt",
          encoding: "timestamp",
          fromMs: p.fromMs,
          toMs: p.toMs,
          label: "exports:browser",
        })
      : Promise.resolve({ docs: [], truncated: false, scanned: 0 }),
    wantCloud
      ? scanWindow({
          query: db.collectionGroup("exportJobs"),
          orderField: "createdAt",
          encoding: "timestamp",
          fromMs: p.fromMs,
          toMs: p.toMs,
          label: "exports:cloud",
        })
      : Promise.resolve({ docs: [], truncated: false, scanned: 0 }),
  ]);

  const browserMapped = mapSafe(
    browser.docs,
    (d): ExportRow => {
      const data = d.data();
      const createdAt = tsToMillis(data.createdAt as never);
      const completedAt = tsToMillis(data.completedAt as never) || null;
      const rawStatus = str(data.status, "queued");
      return {
        id: d.id,
        uid: uidFromSubDoc(d.ref),
        pipeline: "browser",
        projectId: str(data.projectId),
        projectTitle: str(data.projectTitle, "Untitled"),
        format: str(data.format, "unknown"),
        // No invented defaults: a doc without a resolution is "unknown", not
        // silently charted as 1080p (which is what the old route did).
        resolution: str(data.resolution, "unknown"),
        fps: num(data.fps, 0),
        status: normalizeBrowserStatus(rawStatus),
        rawStatus,
        stage: null,
        applyWatermark: bool(data.applyWatermark),
        fileSize: numOrNull(data.fileSize),
        errorMessage: str(data.errorMessage) || null,
        errorCode: null,
        exportMinutes: null,
        plan: null,
        createdAt,
        completedAt,
        turnaroundMs:
          completedAt && createdAt && completedAt > createdAt ? completedAt - createdAt : null,
      };
    },
    "exports:browser"
  );

  const cloudMapped = mapSafe(
    cloud.docs,
    (d): ExportRow => {
      const data = d.data();
      const createdAt = tsToMillis(data.createdAt as never);
      // Cloud jobs settle on `readyAt`; fall back to updatedAt for failures.
      const completedAt =
        tsToMillis(data.readyAt as never) || tsToMillis(data.updatedAt as never) || null;
      const rawStatus = str(data.status, "queued");
      const height = num(data.outputHeight);
      return {
        id: d.id,
        uid: uidFromSubDoc(d.ref) || str(data.userId),
        pipeline: "cloud",
        projectId: str(data.projectId),
        projectTitle: str(data.projectTitle, "Untitled"),
        format: str(data.format, "mp4"),
        resolution: resolutionLabel(height),
        fps: num(data.fps, 0),
        status: normalizeCloudStatus(rawStatus),
        rawStatus,
        stage: str(data.stage) || null,
        // Cloud export is a paid-plan feature and never watermarked.
        applyWatermark: false,
        fileSize: numOrNull(data.outputSizeBytes),
        errorMessage: str(data.errorMessage) || null,
        errorCode: str(data.errorCode) || null,
        exportMinutes:
          numOrNull(data.consumedExportMinutes) ?? numOrNull(data.estimatedExportMinutes),
        plan: str(data.planAtExport) || str(data.plan) || null,
        createdAt,
        completedAt,
        turnaroundMs:
          completedAt && createdAt && completedAt > createdAt ? completedAt - createdAt : null,
      };
    },
    "exports:cloud"
  );

  const all = [...browserMapped.rows, ...cloudMapped.rows].sort(
    (a, b) => b.createdAt - a.createdAt
  );

  // ── Aggregates over the DATE WINDOW (before status/search/pipeline filters) ─
  // Filtering to status=failed must not zero the other four chart segments; the
  // table's own count is reported separately as `filteredTotal`.
  const byStatus = tally(all, (r) => r.status, NORMALIZED_STATUSES);
  const cloudRows = all.filter((r) => r.pipeline === "cloud");

  const summary = {
    byStatus,
    byPipeline: toSlices(tally(all, (r) => r.pipeline, ["browser", "cloud"])),
    byFormat: toSlices(tally(all, (r) => r.format), { topN: 8, dropZero: true }),
    byResolution: toSlices(tally(all, (r) => r.resolution), { topN: 8, dropZero: true }),
    watermarked: countWhere(all, (r) => r.applyWatermark),
    totalBytes: all.reduce((sum, r) => sum + (r.fileSize ?? 0), 0),
    avgTurnaroundMs: averageOf(all, (r) => r.turnaroundMs),
    medianTurnaroundMs: medianOf(all, (r) => r.turnaroundMs),
    /** Billed cloud minutes in the window — real usage, from consumed/estimated. */
    cloudMinutes: cloudRows.reduce((sum, r) => sum + (r.exportMinutes ?? 0), 0),
    perDay: bucketByDay(all, (r) => r.createdAt, { fromMs: p.fromMs, toMs: p.toMs }),
  };

  const filtered = all.filter(
    (r) =>
      (!p.status || r.status === p.status) &&
      (!pipeline || r.pipeline === pipeline) &&
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
    truncated: browser.truncated || cloud.truncated,
    scanned: browser.scanned + cloud.scanned,
    skipped: browserMapped.skipped + cloudMapped.skipped,
    range: { fromMs: p.fromMs, toMs: p.toMs, key: p.range },
    generatedAt: Date.now(),
  };
});
