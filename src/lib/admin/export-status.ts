/**
 * Status/resolution normalization shared by everything that reads BOTH export
 * pipelines — the Exports page route and the PDF report.
 *
 * `users/{uid}/exports` (browser) and `users/{uid}/exportJobs` (paid cloud)
 * have different, differently-spelled status unions (`ExportJobStatus` uses
 * "canceled", one L). Charting them raw produces two "queued" buckets and a
 * phantom "batch_submitted" segment, so each maps into one 5-value vocabulary.
 * Pure — no Firestore import.
 */

export type NormalizedExportStatus = "queued" | "processing" | "ready" | "failed" | "cancelled";

export const NORMALIZED_EXPORT_STATUSES: readonly NormalizedExportStatus[] = [
  "queued",
  "processing",
  "ready",
  "failed",
  "cancelled",
];

/** `ExportStatus` (browser) → shared vocabulary. */
export function normalizeBrowserStatus(raw: string): NormalizedExportStatus {
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
export function normalizeCloudStatus(raw: string): NormalizedExportStatus {
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
export function resolutionLabel(height: number): string {
  if (height >= 2000) return "4K";
  if (height >= 1000) return "1080p";
  if (height >= 700) return "720p";
  if (height > 0) return `${height}p`;
  return "unknown";
}
