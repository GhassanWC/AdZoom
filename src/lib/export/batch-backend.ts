import "server-only";
// Static, server-only import (same constraint as @google-cloud/tasks in
// enqueue.ts): the Batch client pulls in google-gax + gRPC, which do dynamic
// require()s for proto/native loading that webpack can't statically resolve.
// Keep it external (next.config.ts serverExternalPackages) so it's require()d
// from node_modules at runtime, and force its proto assets into the trace for
// the routes that submit jobs (next.config.ts outputFileTracingIncludes).
import { BatchServiceClient, protos } from "@google-cloud/batch";
import { getAdmin } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import {
  BatchCapacityError,
  RESOURCE_POOL_EXHAUSTED_RE,
  batchAllowedLocations,
  classifyBatchJobStatus,
  type BatchJobInspection,
} from "@/lib/export/batch-status";
import { clampWorkersForDiskQuota } from "@/lib/export/batch-capacity";

// Re-export the pure capacity symbols so existing server-only importers can keep
// importing them from this module.
export {
  BatchCapacityError,
  BATCH_CAPACITY_ERROR_CODE,
  BATCH_CAPACITY_ERROR_MESSAGE,
} from "@/lib/export/batch-status";
export type { BatchJobInspection } from "@/lib/export/batch-status";

/**
 * Google Cloud Batch dispatch for paid cloud export (EXPORT_BACKEND=batch).
 *
 * Next.js already CREATED + reserved the `exportJobs/{jobId}` doc (the
 * /api/export/cloud transaction). This submits a one-shot Batch task running the
 * SAME container image as the VM worker, but in single-job mode: the container
 * reads EXPORT_JOB_ID/EXPORT_JOB_UID, claims that one job, renders, uploads,
 * writes the terminal Firestore status, and EXITS. No instance stays running —
 * idle compute cost is ~zero between exports.
 *
 * On success the job doc flips `queued → batch_submitted` with the Batch job
 * name/id recorded; the worker then flips it to `rendering` when it claims.
 *
 * Required server env:
 *   BATCH_REGION              GCP region (e.g. "us-central1")
 *   BATCH_IMAGE               Artifact Registry image URI for the worker
 *   BATCH_SERVICE_ACCOUNT     email of the SA the Batch task runs AS
 * Optional (sane defaults):
 *   BATCH_PROJECT_ID          (falls back to GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT
 *                              / NEXT_PUBLIC_FIREBASE_PROJECT_ID)
 *   BATCH_MACHINE_TYPE        default "e2-standard-4" (4 vCPU / 16 GB)
 *   BATCH_CPU_MILLI           default 4000
 *   BATCH_MEMORY_MIB          default 16384
 *   BATCH_BOOT_DISK_GB        default 50 (pd-balanced; counts toward SSD_TOTAL_GB)
 *   BATCH_MAX_TOTAL_DISK_GB   default 450 (cap on workers × bootDiskGb per job)
 *   BATCH_MAX_RUN_SECONDS     default 2400 (40min ceiling per single-task export)
 *   BATCH_MAX_RETRY_COUNT     default 1
 *   BATCH_PROVISIONING_MODEL  "STANDARD" (default) | "SPOT"
 *   BATCH_CHUNKED_RENDER      "1" to enable the worker's chunked render path
 *   BATCH_ALLOWED_LOCATIONS   comma-separated allocation locations. Default
 *                             "regions/$BATCH_REGION" so Batch can place VMs in
 *                             ANY zone of the region (not pinned to one zone that
 *                             can be CODE_GCE_ZONE_RESOURCE_POOL_EXHAUSTED). Set to
 *                             "zones/us-central1-a,zones/us-central1-c,..." to pin
 *                             to a specific zone subset.
 */

export interface SubmitBatchParams {
  uid: string;
  jobId: string;
  priority: "normal" | "priority";
  /** "chunked" → ONE Batch job with N parallel chunk tasks (leader-merge). Anything
   *  else (default) → the proven single-task job, untouched. */
  renderMode?: "single" | "chunked";
  /** TOTAL chunk count (NOT the task count). */
  chunkCount?: number;
  chunkSeconds?: number;
  /** SHARD WORKER count = Batch taskCount = parallelism. Each worker renders a
   *  contiguous range of chunks, so the task count is small (pro 4 / creator 6). */
  workerCount?: number;
  /** OUTPUT duration (seconds) — informational; the per-task timeout is fixed. */
  durationSeconds?: number;
}

function projectId(): string | undefined {
  return (
    process.env.BATCH_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    undefined
  );
}

function intEnv(key: string, fallback: number): number {
  const n = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function numEnv(key: string, fallback: number): number {
  const n = Number.parseFloat(process.env[key] ?? "");
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Per-task Batch timeout for a SHARD WORKER. Each worker renders a contiguous
 * range (≈ chunkCount/workerCount chunks) + the merge leader does the concat +
 * global audio pass, so a fixed, generous budget is simpler than the old per-chunk
 * estimate. Every task gets the same budget because ANY task may become the merge
 * leader. Batch bills actual runtime, so a worker that finishes early costs nothing.
 */
function chunkedTaskMaxRunSeconds(): number {
  // Cost-safety: a 4K/60fps 6-min export now finishes in ~10min, so a 30min
  // per-task ceiling is a generous backstop while keeping a wedged shard worker
  // from billing for an hour+. The 12-min stale-progress watchdog (reconcile cron)
  // is the real guarantee; this is the last-resort hard kill. Env-overridable.
  return intEnv("EXPORT_CHUNK_TASK_TIMEOUT_SECONDS", 1800);
}

/**
 * Distinct process exit code the worker uses for a DETERMINISTIC (input/validation/
 * timeline/source-missing) failure that re-running cannot fix. Batch's
 * `lifecyclePolicies` map this code to FAIL_TASK so it is NEVER retried (a fresh
 * VM would just fail the same way). Transient failures exit 1 and still retry up
 * to maxRetryCount. MUST stay in sync with ExitCodes.Fatal in the .NET worker
 * (services/export-api-dotnet/Models/ExitCodes.cs).
 */
const FATAL_EXIT_CODE = 42;

/**
 * RFC1035-safe Batch job id derived from the Firestore job id (lowercase letters,
 * digits, hyphens; starts with a letter; ≤63 chars). The Firestore id is mixed
 * case, so we lowercase it and append a short unique suffix to avoid the (rare)
 * case-collision and to keep retries from clashing with a prior submission.
 */
function batchJobId(jobId: string): string {
  const lower = jobId.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const suffix = Date.now().toString(36).slice(-6);
  const base = `export-${lower}`.slice(0, 56);
  return `${base}-${suffix}`;
}

/**
 * Lifecycle policy: a task that exits with FATAL_EXIT_CODE (deterministic worker
 * failure — bad input / unsupported codec / timeline that can't be chunked) is
 * marked FAILED immediately and NOT retried. Re-running it on a fresh VM would just
 * fail the same way and burn another VM, so we fail-fast. Any OTHER non-zero exit
 * (transient crash/preemption) falls through to the default maxRetryCount behavior.
 */
function fatalFailTaskLifecyclePolicies(): protos.google.cloud.batch.v1.ILifecyclePolicy[] {
  return [
    {
      action: protos.google.cloud.batch.v1.LifecyclePolicy.Action.FAIL_TASK,
      actionCondition: { exitCodes: [FATAL_EXIT_CODE] },
    },
  ];
}

/** Build the Batch job spec. One task, one container, the env the worker needs. */
function buildBatchJob(
  image: string,
  serviceAccount: string | undefined,
  env: Record<string, string>,
  priority: "normal" | "priority",
  allowedLocations: string[]
): protos.google.cloud.batch.v1.IJob {
  const machineType = process.env.BATCH_MACHINE_TYPE || "e2-standard-4";
  const cpuMilli = intEnv("BATCH_CPU_MILLI", 4000);
  const memoryMib = intEnv("BATCH_MEMORY_MIB", 16384);
  const bootDiskGb = intEnv("BATCH_BOOT_DISK_GB", 50);
  const maxRunSeconds = intEnv("BATCH_MAX_RUN_SECONDS", 2400);
  const maxRetryCount = intEnv("BATCH_MAX_RETRY_COUNT", 1);
  const provisioningModel = (process.env.BATCH_PROVISIONING_MODEL || "STANDARD").toUpperCase();

  return {
    priority: priority === "priority" ? 1 : 0,
    taskGroups: [
      {
        taskCount: 1,
        parallelism: 1,
        taskSpec: {
          // Per-container env (EXPORT_JOB_ID etc.) — shared by all runnables.
          environment: { variables: env },
          computeResource: { cpuMilli, memoryMib },
          // Hard ceiling so a wedged render can't run (and bill) forever.
          maxRunDuration: { seconds: maxRunSeconds },
          // Whole-task retries: a crash/preemption re-runs the container, which
          // re-claims the (still non-terminal) job via forceReclaim. A deterministic
          // failure (exit FATAL_EXIT_CODE) is exempted by the lifecycle policy below.
          maxRetryCount,
          // Never retry a deterministic worker failure (FATAL_EXIT_CODE).
          lifecyclePolicies: fatalFailTaskLifecyclePolicies(),
          runnables: [
            {
              container: {
                imageUri: image,
                // No commands/entrypoint override — the image ENTRYPOINT
                // (`dotnet ExportApi.dll`) auto-selects single-job mode from
                // EXPORT_JOB_ID.
              },
            },
          ],
        },
      },
    ],
    allocationPolicy: {
      // Whole-region (or env-overridden zone subset) placement so Batch isn't
      // pinned to one zone that can be CODE_GCE_ZONE_RESOURCE_POOL_EXHAUSTED.
      location: { allowedLocations },
      instances: [
        {
          policy: {
            machineType,
            provisioningModel:
              provisioningModel === "SPOT"
                ? protos.google.cloud.batch.v1.AllocationPolicy.ProvisioningModel.SPOT
                : protos.google.cloud.batch.v1.AllocationPolicy.ProvisioningModel.STANDARD,
            // pd-balanced (counts against the SSD_TOTAL_GB quota — see the worker-
            // count guard in submitBatchJob that keeps workers × sizeGb under it).
            bootDisk: { sizeGb: bootDiskGb, type: "pd-balanced" },
          },
        },
      ],
      ...(serviceAccount ? { serviceAccount: { email: serviceAccount } } : {}),
    },
    // Stream stdout/stderr to Cloud Logging (jobId/userId/chunk lines, ffmpeg).
    logsPolicy: { destination: protos.google.cloud.batch.v1.LogsPolicy.Destination.CLOUD_LOGGING },
    labels: { app: "framevo", kind: "export", priority },
  };
}

/**
 * Build the SHARDED chunked Batch job: ONE job, ONE task group with
 * `taskCount = parallelism = workerCount` SHARD WORKERS. Each worker reads the
 * runtime-injected BATCH_TASK_INDEX (as its workerIndex) and renders a CONTIGUOUS
 * range of chunks (chunksPerWorker = ceil(EXPORT_CHUNK_COUNT / EXPORT_WORKER_COUNT);
 * [workerIndex*chunksPerWorker, +chunksPerWorker)) — so 24 chunks run on 4–6 tasks,
 * not 24. The worker that records the LAST chunk (leader election in Firestore) merges.
 * Identical machine/SA/logging/labels to the single job — only the fan-out differs.
 */
function buildChunkedBatchJob(
  image: string,
  serviceAccount: string | undefined,
  env: Record<string, string>,
  priority: "normal" | "priority",
  workerCount: number,
  bootDiskGb: number,
  allowedLocations: string[]
): protos.google.cloud.batch.v1.IJob {
  const machineType = process.env.BATCH_MACHINE_TYPE || "e2-standard-4";
  const cpuMilli = intEnv("BATCH_CPU_MILLI", 4000);
  const memoryMib = intEnv("BATCH_MEMORY_MIB", 16384);
  const maxRetryCount = intEnv("EXPORT_CHUNK_MAX_RETRY_COUNT", 1);
  const provisioningModel = (process.env.BATCH_PROVISIONING_MODEL || "STANDARD").toUpperCase();
  const maxRunSeconds = chunkedTaskMaxRunSeconds();
  const tasks = Math.max(1, workerCount);

  return {
    priority: priority === "priority" ? 1 : 0,
    taskGroups: [
      {
        // taskCount == parallelism == workerCount: every shard worker runs at once.
        taskCount: tasks,
        parallelism: tasks,
        taskSpec: {
          // SHARED env for every task. The runtime injects BATCH_TASK_INDEX /
          // BATCH_TASK_COUNT per task; each worker derives its assigned chunk set
          // from BATCH_TASK_INDEX + EXPORT_WORKER_COUNT + EXPORT_CHUNK_COUNT.
          environment: { variables: env },
          computeResource: { cpuMilli, memoryMib },
          maxRunDuration: { seconds: maxRunSeconds },
          // Per-CHUNK Batch retry (a crashed/preempted chunk task re-runs on a fresh
          // VM; the re-run re-uploads its chunk idempotently and re-checks merge). A
          // deterministic failure (exit FATAL_EXIT_CODE) is exempted by the policy below.
          maxRetryCount,
          // Never retry a deterministic worker failure (FATAL_EXIT_CODE).
          lifecyclePolicies: fatalFailTaskLifecyclePolicies(),
          runnables: [{ container: { imageUri: image } }],
        },
      },
    ],
    allocationPolicy: {
      // Whole-region (or env-overridden zone subset) placement so the N chunk
      // tasks aren't pinned to one zone that can be exhausted.
      location: { allowedLocations },
      instances: [
        {
          policy: {
            machineType,
            provisioningModel:
              provisioningModel === "SPOT"
                ? protos.google.cloud.batch.v1.AllocationPolicy.ProvisioningModel.SPOT
                : protos.google.cloud.batch.v1.AllocationPolicy.ProvisioningModel.STANDARD,
            // pd-balanced (counts against the SSD_TOTAL_GB quota — see the worker-
            // count guard in submitBatchJob that keeps workers × sizeGb under it).
            bootDisk: { sizeGb: bootDiskGb, type: "pd-balanced" },
          },
        },
      ],
      ...(serviceAccount ? { serviceAccount: { email: serviceAccount } } : {}),
    },
    logsPolicy: { destination: protos.google.cloud.batch.v1.LogsPolicy.Destination.CLOUD_LOGGING },
    labels: { app: "framevo", kind: "export-chunked", priority },
  };
}

/**
 * Submit a Batch job for an already-created export and record the Batch ids on
 * the doc (status → batch_submitted). Throws on misconfig / submit failure so the
 * caller (createCloudExportJob) rolls back the reservation and fails the job.
 */
export async function submitBatchJob({
  uid,
  jobId,
  priority,
  renderMode,
  chunkCount,
  chunkSeconds,
  workerCount,
  durationSeconds,
}: SubmitBatchParams): Promise<void> {
  const project = projectId();
  const region = process.env.BATCH_REGION?.trim();
  const image = process.env.BATCH_IMAGE?.trim();
  const serviceAccount = process.env.BATCH_SERVICE_ACCOUNT?.trim();
  const chunked = renderMode === "chunked" && (chunkCount ?? 0) >= 2;

  if (!project || !region || !image) {
    const missing = [
      !project && "BATCH_PROJECT_ID (or GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT / NEXT_PUBLIC_FIREBASE_PROJECT_ID)",
      !region && "BATCH_REGION",
      !image && "BATCH_IMAGE",
    ].filter(Boolean);
    const msg = `Cloud Batch dispatch is misconfigured — missing env: ${missing.join(", ")}.`;
    console.error(`[export-enqueue] ${msg}`, { jobId });
    throw new Error(msg);
  }

  // ── Shard worker count + boot-disk budget (SSD_TOTAL_GB quota guard) ──────
  // Batch boot disks are pd-balanced, which count against the GCE SSD_TOTAL_GB
  // quota. If workers × bootDiskGb exceeds it, the excess tasks sit PENDING with
  // CODE_GCE_QUOTA_EXCEEDED (e.g. 8 × 100GB = 800GB > a 500GB quota → only 4 run).
  // Cap the worker count so the whole job's disk fits. This MUST run before the env
  // block below: the worker shards by EXPORT_WORKER_COUNT, so it has to equal the
  // FINAL task count.
  const bootDiskGb = intEnv("BATCH_BOOT_DISK_GB", 50);
  const maxTotalDiskGb = intEnv("BATCH_MAX_TOTAL_DISK_GB", 450);
  const requestedWorkers = chunked ? Math.max(1, Math.min(workerCount ?? 1, chunkCount ?? 1)) : 1;
  const workers = chunked
    ? clampWorkersForDiskQuota(requestedWorkers, bootDiskGb, maxTotalDiskGb)
    : 1;
  const estimatedTotalDiskGb = workers * bootDiskGb;
  if (chunked && workers < requestedWorkers) {
    console.warn(
      `[export-enqueue] backend=batch SSD-quota guard job=${jobId} ` +
        `requestedWorkers=${requestedWorkers} bootDiskGb=${bootDiskGb} ` +
        `estimatedTotalDiskGb(req)=${requestedWorkers * bootDiskGb} maxTotalDiskGb=${maxTotalDiskGb} → reducedWorkers=${workers}`
    );
  }

  const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "";
  const env: Record<string, string> = {
    EXPORT_JOB_ID: jobId,
    EXPORT_JOB_UID: uid,
    EXPORT_WORKER_MODE: "single-job",
    NODE_ENV: "production",
    // The worker reads NEXT_PUBLIC_* for project/bucket; also pass the names the
    // task spec calls out (FIREBASE_*) so either is honoured.
    FIREBASE_PROJECT_ID: project,
    GOOGLE_CLOUD_PROJECT: project,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: project,
    FIREBASE_STORAGE_BUCKET: bucket,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: bucket,
    ...(process.env.BUILD_VERSION ? { BUILD_VERSION: process.env.BUILD_VERSION } : {}),
    // CHUNKED mode is selected by EXPORT_RENDER_MODE (the new parallel path), NOT
    // the legacy EXPORT_CHUNKED_RENDER (which drove in-container sequential
    // chunking). Only pass the legacy flag for single jobs, to preserve behavior.
    ...(chunked
      ? {
          EXPORT_RENDER_MODE: "chunked",
          // EXPORT_CHUNK_COUNT = TOTAL chunks (NOT the task count). Each worker
          // renders chunks [workerIndex, +workerCount, …].
          EXPORT_CHUNK_COUNT: String(chunkCount),
          // Final worker count AFTER the SSD-quota reduction (the worker shards by
          // this, so it must match the actual Batch taskCount).
          EXPORT_WORKER_COUNT: String(workers),
          EXPORT_CHUNK_SECONDS: String(chunkSeconds ?? 15),
          EXPORT_CHUNK_BOUNDARY_PADDING_SECONDS:
            process.env.EXPORT_CHUNK_BOUNDARY_PADDING_SECONDS ?? "0",
          ...(process.env.EXPORT_CHUNK_TASK_TIMEOUT_SECONDS
            ? { EXPORT_CHUNK_TASK_TIMEOUT_SECONDS: process.env.EXPORT_CHUNK_TASK_TIMEOUT_SECONDS }
            : {}),
          ...(process.env.EXPORT_MERGE_LEASE_SECONDS
            ? { EXPORT_MERGE_LEASE_SECONDS: process.env.EXPORT_MERGE_LEASE_SECONDS }
            : {}),
          ...(process.env.EXPORT_AUDIOMUX_TIMEOUT_SECONDS
            ? { EXPORT_AUDIOMUX_TIMEOUT_SECONDS: process.env.EXPORT_AUDIOMUX_TIMEOUT_SECONDS }
            : {}),
          ...(process.env.EXPORT_CHUNK_MAX_RETRIES
            ? { EXPORT_CHUNK_MAX_RETRIES: process.env.EXPORT_CHUNK_MAX_RETRIES }
            : {}),
        }
      : process.env.BATCH_CHUNKED_RENDER
        ? { EXPORT_CHUNKED_RENDER: process.env.BATCH_CHUNKED_RENDER }
        : {}),
  };

  const id = batchJobId(jobId);
  const parent = `projects/${project}/locations/${region}`;
  const client = new BatchServiceClient();
  const allowedLocations = batchAllowedLocations(region);

  const job = chunked
    ? buildChunkedBatchJob(image, serviceAccount, env, priority, workers, bootDiskGb, allowedLocations)
    : buildBatchJob(image, serviceAccount, env, priority, allowedLocations);

  // Effective fan-out (mirrors the builders) — logged so a capacity/quota failure
  // can be correlated to the allocation/region/fan-out/disk without reading the
  // spec. With sharding, taskCount == parallelism == workerCount (NOT chunkCount).
  const machineType = process.env.BATCH_MACHINE_TYPE || "e2-standard-4";
  const taskCount = chunked ? workers : 1;
  const parallelism = chunked ? workers : 1;
  // Mirrors chunk-plan.ts's dynamic worker math (workers ≈ chunkCount / target),
  // logged so an over/under-provisioned fan-out is traceable to the target ratio.
  const targetChunksPerWorker = intEnv("EXPORT_TARGET_CHUNKS_PER_WORKER", 3);
  console.log(
    `[export-enqueue] backend=batch config job=${jobId} ` +
      `allowedLocations=${allowedLocations.join("|")} machineType=${machineType} ` +
      `chunkCount=${chunked ? chunkCount : 1} workerCount=${taskCount} ` +
      `targetChunksPerWorker=${targetChunksPerWorker} ` +
      `taskCount=${taskCount} parallelism=${parallelism} ` +
      `bootDiskGb=${bootDiskGb} estimatedTotalDiskGb=${chunked ? estimatedTotalDiskGb : bootDiskGb}`
  );

  let jobName: string;
  try {
    const [created] = await client.createJob({ parent, jobId: id, job });
    jobName = created.name ?? `${parent}/jobs/${id}`;
    console.log(
      `[export-enqueue] backend=batch submitted job=${jobId} batchJob=${jobName} (${priority}) mode=${chunked ? `chunked chunks=${chunkCount} workers=${workers}` : "single"}`
    );
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[export-enqueue] createJob failed for job ${jobId}`, {
      jobId,
      priority,
      project,
      region,
      image,
      serviceAccount,
      grpcCode: code,
      message,
    });
    // gRPC RESOURCE_EXHAUSTED (8) or a *_RESOURCE_POOL_EXHAUSTED message means the
    // region had no capacity at submit time — surface as a retryable capacity
    // failure rather than a generic dispatch error. (The common case is the ASYNC
    // cancel handled by inspectBatchJob; this is the synchronous safety net.)
    if (code === 8 || RESOURCE_POOL_EXHAUSTED_RE.test(message)) {
      throw new BatchCapacityError();
    }
    throw err instanceof Error ? err : new Error(`Cloud Batch createJob failed: ${String(err)}`);
  }

  // Record the Batch ids + flip to batch_submitted. Best-effort: the render is
  // already on its way, so a failed status write must NOT roll back the export.
  try {
    const { db } = getAdmin();
    await db.doc(`users/${uid}/exportJobs/${jobId}`).set(
      {
        status: "batch_submitted",
        progressStage: "preparing",
        batchJobId: id,
        batchJobName: jobName,
        batchSubmittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.warn("[export-enqueue] backend=batch status write failed (job still submitted)", {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Reconstruct the fully-qualified Batch job resource name when only the id was
 *  recorded (older docs / a partial write). Needs BATCH_REGION + a project id. */
function batchJobResourceName(batchJobId: string): string | null {
  const project = projectId();
  const region = process.env.BATCH_REGION?.trim();
  if (!project || !region) return null;
  return `projects/${project}/locations/${region}/jobs/${batchJobId}`;
}

/**
 * Read a Batch job's current status to detect the ASYNC failure mode the
 * reconciler can't otherwise see: createJob succeeded (doc → batch_submitted) but
 * Batch later cancels/fails the job before any container starts — most often
 * because the region ran out of capacity (CODE_GCE_ZONE_RESOURCE_POOL_EXHAUSTED),
 * which surfaces in `status.statusEvents[].description`.
 *
 * Best-effort + bounded (10s). Returns null when the job can't be resolved
 * (no name, NOT_FOUND, or any RPC error) so the caller falls back to the
 * time-based stale sweep rather than mislabeling. Never throws.
 */
export async function inspectBatchJob({
  jobName,
  batchJobId,
}: {
  jobName?: string | null;
  batchJobId?: string | null;
}): Promise<BatchJobInspection | null> {
  const name =
    jobName?.trim() || (batchJobId ? batchJobResourceName(batchJobId.trim()) : null);
  if (!name) return null;

  const client = new BatchServiceClient();
  try {
    const [job] = await client.getJob({ name }, { timeout: 10_000 });
    return classifyBatchJobStatus(job.status?.state, job.status?.statusEvents);
  } catch (err) {
    // NOT_FOUND (5) → job already gone; any other error → control-plane blip.
    // Either way, let the stale sweep handle it instead of guessing.
    if ((err as { code?: unknown })?.code !== 5) {
      console.warn("[reconcile-exports] backend=batch getJob failed", {
        name,
        grpcCode: (err as { code?: unknown })?.code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

/**
 * Stop a running Batch job so its VM is torn down and STOPS BILLING — called when
 * the user cancels an export. Without this, marking the Firestore job `canceled`
 * leaves the Batch task RUNNING (and charging) until it finishes or hits
 * BATCH_MAX_RUN_SECONDS.
 *
 * Best-effort + bounded: tries the graceful CancelJob first (leaves the job as
 * CANCELLED for inspection), falling back to DeleteJob. A NOT_FOUND (already gone
 * / finished) counts as success. Never throws — the worker's own 1s cancel-poll
 * is the backstop that makes it exit; this only ensures the VM doesn't keep
 * charging after Firestore says canceled. Returns true when Batch acknowledged
 * the stop (or the job was already gone).
 */
export async function cancelBatchJob({
  jobName,
  batchJobId,
}: {
  jobName?: string | null;
  batchJobId?: string | null;
}): Promise<boolean> {
  const name =
    jobName?.trim() || (batchJobId ? batchJobResourceName(batchJobId.trim()) : null);
  if (!name) {
    console.warn("[export-cancel] backend=batch no batchJobName/batchJobId to stop");
    return false;
  }

  const client = new BatchServiceClient();
  // Bound the initial RPC so a slow Batch control plane can't hang the cancel
  // route. We do NOT await the long-running operation to completion — initiating
  // the cancel/delete is enough for Batch to tear the VM down.
  const callOpts = { timeout: 10_000 };
  const notFound = (err: unknown) => (err as { code?: unknown })?.code === 5; // gRPC NOT_FOUND

  // 1) Graceful cancel — preferred; keeps the job record as CANCELLED.
  try {
    await client.cancelJob({ name }, callOpts);
    console.log(`[export-cancel] backend=batch cancelJob initiated name=${name}`);
    return true;
  } catch (err) {
    if (notFound(err)) {
      console.log(`[export-cancel] backend=batch job already gone name=${name}`);
      return true;
    }
    console.warn(`[export-cancel] backend=batch cancelJob failed — trying deleteJob name=${name}`, {
      grpcCode: (err as { code?: unknown })?.code,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 2) Fallback — delete the job (also tears down the VM / stops billing).
  try {
    await client.deleteJob({ name }, callOpts);
    console.log(`[export-cancel] backend=batch deleteJob initiated name=${name}`);
    return true;
  } catch (err) {
    if (notFound(err)) {
      console.log(`[export-cancel] backend=batch job already gone (delete) name=${name}`);
      return true;
    }
    console.error(`[export-cancel] backend=batch deleteJob failed name=${name}`, {
      grpcCode: (err as { code?: unknown })?.code,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
