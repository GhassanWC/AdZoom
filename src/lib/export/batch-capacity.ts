/**
 * Pure (no `server-only`, no gRPC) config for the GLOBAL active-Batch-export cap.
 * Shared by the submit path (create-job.ts) and the queue-promotion path
 * (reconcile-exports cron) so both agree on what a "slot" is and how many exist.
 * Dependency-free so it imports cleanly under `node --test`.
 */
import type { ExportJobStatus } from "@/lib/firebase/schema";

/**
 * Statuses where a job has been SUBMITTED to Google Cloud Batch and is occupying
 * a slot (holding/consuming a VM). `queued` is deliberately NOT here — a queued
 * job is WAITING for a slot, not occupying one — so the queue can drain
 * (promotion can run when a running job finishes). A chunked job's chunk-render
 * AND merge phases are both `status: "rendering"` (only `stage` differs), so they
 * are already covered by "rendering".
 */
export const BATCH_SLOT_STATUSES: readonly ExportJobStatus[] = [
  "batch_submitted",
  "rendering",
  "uploading",
];

/** Default global cap when no env var is set. Each chunked export now uses a
 *  multi-task shard job (up to 6–8 worker VMs × bootDiskGb), so one job at a time
 *  keeps total SSD usage under the GCE SSD_TOTAL_GB quota. */
export const DEFAULT_MAX_ACTIVE_BATCH_JOBS = 1;

/**
 * Cost-safety watchdog window: a `rendering`/`uploading` export whose `lastProgressAt`
 * (last chunk recorded, or last real progress write — NOT the bare 30s heartbeat,
 * which keeps `updatedAt` fresh even when nothing is happening) is older than this is
 * cancelled in Google Batch and failed `stale_progress_timeout`. 12 min comfortably
 * clears a healthy 4K/60 render (chunks complete every few seconds) and merge (~1–2
 * min), but kills an alive-but-stuck worker fast. From EXPORT_STALE_PROGRESS_SECONDS.
 */
export const DEFAULT_STALE_PROGRESS_SECONDS = 720;

/** Per-worker Batch boot disk (GB) + per-job total-disk cap. Batch boot disks are
 *  pd-balanced, which count toward the GCE SSD_TOTAL_GB quota, so a multi-worker
 *  shard job must keep workers × bootDiskGb under the cap or excess tasks sit
 *  PENDING with CODE_GCE_QUOTA_EXCEEDED. */
export const DEFAULT_BATCH_BOOT_DISK_GB = 50;
export const DEFAULT_BATCH_MAX_TOTAL_DISK_GB = 450;

/**
 * Largest shard-worker count whose total boot disk (workers × bootDiskGb) fits the
 * per-job disk budget. Returns the input when it already fits, else the largest
 * count that does (>= 1). Pure — unit-tested.
 */
export function clampWorkersForDiskQuota(
  workers: number,
  bootDiskGb: number,
  maxTotalDiskGb: number
): number {
  const w = Math.max(1, Math.floor(workers));
  const disk = Math.max(1, Math.floor(bootDiskGb));
  if (w * disk <= maxTotalDiskGb) return w;
  return Math.max(1, Math.min(w, Math.floor(maxTotalDiskGb / disk)));
}

/** Doc marker (status `queued`) for a job deferred because the cap was hit. */
export const QUEUE_REASON_WAITING_FOR_SLOT = "waiting_for_slot";

/** Message shown to the user while a job is deferred waiting for a slot. */
export const WAITING_FOR_SLOT_MESSAGE = "Waiting for cloud export slot";

/**
 * Global cap on concurrently SUBMITTED Batch export jobs across the whole
 * platform. Reads `EXPORT_MAX_ACTIVE_BATCH_JOBS` (the supported var), falling back
 * to the legacy `EXPORT_MAX_ACTIVE_BATCH_EXPORTS` for back-compat, then to the
 * default (3). A missing/invalid/non-positive value uses the default.
 */
export function maxActiveBatchJobs(env: NodeJS.ProcessEnv = process.env): number {
  for (const key of ["EXPORT_MAX_ACTIVE_BATCH_JOBS", "EXPORT_MAX_ACTIVE_BATCH_EXPORTS"]) {
    const n = Number.parseInt(env[key] ?? "", 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_ACTIVE_BATCH_JOBS;
}

/**
 * Seconds of no real render progress after which the stale-progress watchdog
 * (reconcile-exports cron) cancels the Batch job + fails the export. Reads
 * `EXPORT_STALE_PROGRESS_SECONDS`; a missing/invalid/non-positive value uses the
 * default (720). Pure — unit-tested.
 */
export function exportStaleProgressSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.EXPORT_STALE_PROGRESS_SECONDS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_PROGRESS_SECONDS;
}
