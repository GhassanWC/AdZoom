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
 *  multi-task shard job (4–6 worker VMs), so the concurrent-JOB cap is lower. */
export const DEFAULT_MAX_ACTIVE_BATCH_JOBS = 2;

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
