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
 *   BATCH_BOOT_DISK_GB        default 100
 *   BATCH_MAX_RUN_SECONDS     default 7200 (2h ceiling per export)
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
  chunkCount?: number;
  chunkSeconds?: number;
  chunkParallelism?: number;
  /** OUTPUT duration (seconds) — drives the dynamic per-task Batch timeout. */
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
 * Dynamic per-task Batch timeout for chunked render (NOT the flat single-job
 * 7200s). Every chunk task gets the same budget because ANY task may become the
 * merge leader and so needs render + merge headroom; Batch bills actual runtime,
 * so non-leaders that finish early cost nothing extra. Bounded so a wedged task
 * can't bill forever.
 */
function chunkedTaskMaxRunSeconds(chunkSeconds: number, durationSeconds: number): number {
  const coldStart = intEnv("EXPORT_TASK_COLD_START_SECONDS", 180);
  const download = intEnv("EXPORT_TASK_DOWNLOAD_SECONDS", 300);
  const renderFactor = numEnv("EXPORT_CHUNK_RUNTIME_FACTOR", 8); // realtime multiple (incl. retry headroom)
  const mergeBase = intEnv("EXPORT_MERGE_BASE_SECONDS", 120);
  const mergeFactor = numEnv("EXPORT_MERGE_FACTOR", 0.5); // per output second (concat -c copy is cheap)
  const min = intEnv("EXPORT_CHUNK_TASK_MIN_SECONDS", 600);
  const max = intEnv("BATCH_MAX_RUN_SECONDS", 7200); // hard ceiling, shared with single
  const perChunkRender = Math.ceil(Math.max(1, chunkSeconds) * renderFactor);
  const mergeBudget = mergeBase + Math.ceil(Math.max(0, durationSeconds) * mergeFactor);
  return Math.min(max, Math.max(min, coldStart + download + perChunkRender + mergeBudget));
}

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
  const bootDiskGb = intEnv("BATCH_BOOT_DISK_GB", 100);
  const maxRunSeconds = intEnv("BATCH_MAX_RUN_SECONDS", 7200);
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
          // re-claims the (still non-terminal) job via forceReclaim.
          maxRetryCount,
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
            bootDisk: { sizeGb: bootDiskGb },
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
 * Build the CHUNKED Batch job: ONE job, ONE task group with `taskCount = chunkCount`
 * parallel tasks capped at `parallelism`. Each task reads the runtime-injected
 * BATCH_TASK_INDEX to render its window; the task that finishes the LAST chunk
 * (leader election in Firestore) merges. Identical machine/SA/logging/labels to the
 * single job — only the task fan-out + a dynamic, tighter per-task timeout differ.
 */
function buildChunkedBatchJob(
  image: string,
  serviceAccount: string | undefined,
  env: Record<string, string>,
  priority: "normal" | "priority",
  chunkCount: number,
  chunkParallelism: number,
  chunkSeconds: number,
  durationSeconds: number,
  allowedLocations: string[]
): protos.google.cloud.batch.v1.IJob {
  const machineType = process.env.BATCH_MACHINE_TYPE || "e2-standard-4";
  const cpuMilli = intEnv("BATCH_CPU_MILLI", 4000);
  const memoryMib = intEnv("BATCH_MEMORY_MIB", 16384);
  const bootDiskGb = intEnv("BATCH_BOOT_DISK_GB", 100);
  const maxRetryCount = intEnv("EXPORT_CHUNK_MAX_RETRY_COUNT", 1);
  const provisioningModel = (process.env.BATCH_PROVISIONING_MODEL || "STANDARD").toUpperCase();
  const maxRunSeconds = chunkedTaskMaxRunSeconds(chunkSeconds, durationSeconds);

  return {
    priority: priority === "priority" ? 1 : 0,
    taskGroups: [
      {
        taskCount: chunkCount,
        parallelism: Math.max(1, Math.min(chunkParallelism, chunkCount)),
        taskSpec: {
          // SHARED env for every task. The runtime injects BATCH_TASK_INDEX /
          // BATCH_TASK_COUNT per task, so each derives its own chunk window — no
          // per-task taskEnvironments needed.
          environment: { variables: env },
          computeResource: { cpuMilli, memoryMib },
          maxRunDuration: { seconds: maxRunSeconds },
          // Per-CHUNK Batch retry (a crashed/preempted chunk task re-runs on a fresh
          // VM; the re-run re-uploads its chunk idempotently and re-checks merge).
          maxRetryCount,
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
            bootDisk: { sizeGb: bootDiskGb },
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
  chunkParallelism,
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
          EXPORT_CHUNK_COUNT: String(chunkCount),
          EXPORT_CHUNK_SECONDS: String(chunkSeconds ?? 120),
          EXPORT_CHUNK_BOUNDARY_PADDING_SECONDS:
            process.env.EXPORT_CHUNK_BOUNDARY_PADDING_SECONDS ?? "0",
          ...(process.env.EXPORT_MERGE_LEASE_SECONDS
            ? { EXPORT_MERGE_LEASE_SECONDS: process.env.EXPORT_MERGE_LEASE_SECONDS }
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
    ? buildChunkedBatchJob(
        image,
        serviceAccount,
        env,
        priority,
        chunkCount!,
        chunkParallelism ?? 1,
        chunkSeconds ?? 120,
        durationSeconds ?? 0,
        allowedLocations
      )
    : buildBatchJob(image, serviceAccount, env, priority, allowedLocations);

  // Effective fan-out (mirrors the builders) — logged so a capacity failure can
  // be correlated to the allocation/region/fan-out without reading the spec.
  const machineType = process.env.BATCH_MACHINE_TYPE || "e2-standard-4";
  const taskCount = chunked ? chunkCount! : 1;
  const parallelism = chunked
    ? Math.max(1, Math.min(chunkParallelism ?? 1, chunkCount!))
    : 1;
  console.log(
    `[export-enqueue] backend=batch config job=${jobId} ` +
      `allowedLocations=${allowedLocations.join("|")} machineType=${machineType} ` +
      `taskCount=${taskCount} parallelism=${parallelism}`
  );

  let jobName: string;
  try {
    const [created] = await client.createJob({ parent, jobId: id, job });
    jobName = created.name ?? `${parent}/jobs/${id}`;
    console.log(
      `[export-enqueue] backend=batch submitted job=${jobId} batchJob=${jobName} (${priority}) mode=${chunked ? `chunked×${chunkCount}@${chunkParallelism}` : "single"}`
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
