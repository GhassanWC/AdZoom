/**
 * Pure (no `server-only`, no gRPC) helpers for the Google Cloud Batch export
 * path: allocation-location selection + classification of a Batch job's status.
 * Kept dependency-free so it imports cleanly under `node --test` and doesn't drag
 * google-gax into bundles that only need the decision logic. The actual Batch RPC
 * calls live in batch-backend.ts (which is `server-only`).
 */

/** Stable error code + user-facing message for "the region had no capacity". */
export const BATCH_CAPACITY_ERROR_CODE = "batch_capacity_unavailable";
export const BATCH_CAPACITY_ERROR_MESSAGE =
  "Cloud capacity was temporarily unavailable. Please retry export.";

/**
 * Thrown when Batch rejects the submission for capacity reasons (gRPC
 * RESOURCE_EXHAUSTED / a *_RESOURCE_POOL_EXHAUSTED message). The caller
 * (createCloudExportJob) maps this to BATCH_CAPACITY_ERROR_CODE so the user gets a
 * clean "retry" message instead of a generic dispatch failure. NOTE: the common
 * exhaustion path is ASYNC — createJob succeeds and Batch cancels the job before
 * any container starts — which is detected separately via the job's status.
 */
export class BatchCapacityError extends Error {
  readonly code = BATCH_CAPACITY_ERROR_CODE;
  constructor(message = BATCH_CAPACITY_ERROR_MESSAGE) {
    super(message);
    this.name = "BatchCapacityError";
  }
}

/** Match the various GCE/Batch "no capacity in this zone/region" descriptions
 *  (e.g. CODE_GCE_ZONE_RESOURCE_POOL_EXHAUSTED, GCE stockout). */
export const RESOURCE_POOL_EXHAUSTED_RE = /RESOURCE_POOL_EXHAUSTED|stockout/i;

/**
 * Allocation locations for the Batch job. By default the WHOLE region
 * ("regions/$region") so Batch spreads provisioning across every zone — one
 * exhausted zone (e.g. us-central1-b) no longer kills the job. Overridable via
 * BATCH_ALLOWED_LOCATIONS (comma-separated "regions/..." or "zones/..." entries).
 */
export function batchAllowedLocations(
  region: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const raw = env.BATCH_ALLOWED_LOCATIONS?.trim();
  if (raw) {
    const list = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  return [`regions/${region}`];
}

/**
 * Batch JobStatus.State values that mean the job will never render. Hardcoded
 * (mirrors protos.google.cloud.batch.v1.JobStatus.State — a stable proto
 * contract) and listed as BOTH the enum number and its string name because gax
 * may return either depending on its fallback mode. FAILED=5,
 * DELETION_IN_PROGRESS=6, CANCELLATION_IN_PROGRESS=7, CANCELLED=8.
 */
export const TERMINAL_BAD_STATES = new Set<string | number>([
  5,
  6,
  7,
  8,
  "FAILED",
  "DELETION_IN_PROGRESS",
  "CANCELLATION_IN_PROGRESS",
  "CANCELLED",
]);

/**
 * States in which a Batch job is genuinely going to render: QUEUED=1, SCHEDULED=2,
 * RUNNING=3 (gax may return the enum number or its string name). SUCCEEDED is NOT
 * here — a job whose Batch is already SUCCEEDED but whose export doc is still
 * "rendering" means the worker never settled (crashed merge), i.e. stale — so the
 * create path must NOT reuse it.
 */
export const ACTIVE_BATCH_STATES = new Set<string | number>([
  1,
  2,
  3,
  "QUEUED",
  "SCHEDULED",
  "RUNNING",
]);

/** True iff the Batch job is actively queued/scheduled/running (will produce output). */
export function isActiveBatchState(state: string | number | null | undefined): boolean {
  return state != null && ACTIVE_BATCH_STATES.has(state);
}

export interface BatchJobInspection {
  /** Raw state as returned (string name or number). */
  state: string | number | null | undefined;
  /** The job will never render (FAILED / CANCELLED / *_IN_PROGRESS). */
  terminalBad: boolean;
  /** A status event blames zone/region capacity exhaustion. */
  capacityExhausted: boolean;
  /** The job is QUEUED / SCHEDULED / RUNNING (genuinely going to render). */
  active: boolean;
}

/** Classify a Batch job's status into the terminal-bad / capacity-exhausted flags
 *  the reconciler acts on. Pure — given the state + status events. */
export function classifyBatchJobStatus(
  state: string | number | null | undefined,
  statusEvents: ReadonlyArray<{ description?: string | null } | null | undefined> | null | undefined
): BatchJobInspection {
  const terminalBad = state != null && TERMINAL_BAD_STATES.has(state);
  const capacityExhausted = (statusEvents ?? []).some((e) =>
    RESOURCE_POOL_EXHAUSTED_RE.test(e?.description ?? "")
  );
  return { state, terminalBad, capacityExhausted, active: isActiveBatchState(state) };
}
