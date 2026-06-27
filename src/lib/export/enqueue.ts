import "server-only";
// Static, server-only import. Must NOT be a dynamic `import()`/`require()` —
// and the package is externalized in next.config.ts (serverExternalPackages) so
// its google-gax/gRPC dynamic proto requires are resolved from node_modules at
// runtime rather than bundled by webpack.
import { CloudTasksClient } from "@google-cloud/tasks";
import { exportBackend, dotnetEnqueueSignal } from "./dotnet-backend";
import { submitBatchJob } from "./batch-backend";

/**
 * Export-job dispatch — hands a created `exportJobs/{jobId}` doc to the Cloud
 * Run worker. Two modes, selected by `EXPORT_DISPATCH`:
 *
 *   • "local" (default)  — fire a plain POST at a locally-running worker
 *     (`EXPORT_WORKER_LOCAL_URL`). No GCP needed; the whole pipeline runs on a
 *     Windows dev box with `npm run dev` + `npm run worker:dev`.
 *   • "cloudtasks"       — enqueue a Cloud Tasks task (normal/priority queue by
 *     plan) targeting the private Cloud Run worker with an OIDC token. Cloud
 *     Tasks owns retries/backoff and dispatch ordering.
 *
 * The worker reads the job + project, renders, uploads, and writes status back
 * to Firestore directly (Admin SDK) — there is no callback route. The task body
 * is just `{ uid, jobId }`; everything else lives on the job doc.
 */

export type ExportPriority = "normal" | "priority";

export interface EnqueueParams {
  uid: string;
  jobId: string;
  priority: ExportPriority;
  /** Render strategy decided at creation. Only "chunked" changes Batch dispatch
   *  (one job, N parallel tasks); "single"/undefined keeps the proven one-task job. */
  renderMode?: "single" | "chunked";
  /** Chunked-only: TOTAL chunk count, output seconds per chunk, the SHARD WORKER
   *  count (Batch taskCount = parallelism; each worker renders many chunks), and the
   *  OUTPUT duration (for the Batch timeout). */
  chunkCount?: number;
  chunkSeconds?: number;
  workerCount?: number;
  durationSeconds?: number;
}

/** Dispatch a created export job to the worker. Throws on failure so the caller
 *  can fail the job + release its minute reservation. */
export async function enqueueExportJob(params: EnqueueParams): Promise<void> {
  const backend = exportBackend();

  // EXPORT_BACKEND=batch → submit a one-shot Google Cloud Batch task running the
  // .NET worker in single-job mode (claim one job, render, exit). This is the
  // production path: near-zero idle cost. Throws on failure so the caller rolls
  // back the reservation + fails the job (same contract as the other backends).
  if (backend === "batch") {
    await submitBatchJob(params);
    return;
  }

  // EXPORT_BACKEND=vm → rendering runs on the long-lived GCE VM worker, which
  // POLLS Firestore for queued jobs. Next.js already CREATED + reserved the job
  // (the /api/export/cloud transaction); there is NOTHING to dispatch — no Cloud
  // Tasks, no HTTP call to Cloud Run. The poller picks it up within its interval.
  if (backend === "vm") {
    console.log(`[export-enqueue] backend=vm job=${params.jobId} (${params.priority}) — VM poller will deliver`);
    return;
  }

  // EXPORT_BACKEND selects the render backend. "dotnet" → the C# export API runs
  // the job (Next.js already created + reserved it; this only signals the runner,
  // which also polls). Anything else keeps the old Node worker path below.
  if (backend === "dotnet") {
    console.log(`[export-enqueue] backend=dotnet job=${params.jobId} (${params.priority})`);
    await dotnetEnqueueSignal(params.uid, params.jobId);
    return;
  }

  const mode = (process.env.EXPORT_DISPATCH ?? "local").toLowerCase();
  console.log(`[export-enqueue] backend=cloudtasks dispatch=${mode} job=${params.jobId} (${params.priority})`);
  if (mode === "cloudtasks") {
    await enqueueCloudTask(params);
  } else {
    await enqueueLocal(params);
  }
}

/** Local dev: POST the job straight at a worker on localhost. The dev worker
 *  responds 2xx immediately and renders in the background. */
async function enqueueLocal({ uid, jobId }: EnqueueParams): Promise<void> {
  const url = process.env.EXPORT_WORKER_LOCAL_URL ?? "http://127.0.0.1:8787/";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The dev worker skips OIDC when DEV_DISABLE_OIDC=1; this shared secret is
      // an optional second guard so a stray localhost process can't trigger it.
      ...(process.env.EXPORT_WORKER_DEV_SECRET
        ? { "x-export-dev-secret": process.env.EXPORT_WORKER_DEV_SECRET }
        : {}),
    },
    body: JSON.stringify({ uid, jobId }),
  });
  if (!res.ok) {
    throw new Error(
      `Local export worker rejected the job (${res.status}). Is \`npm run worker:dev\` running at ${url}?`
    );
  }
}

/** Production: enqueue a Cloud Tasks task targeting the private Cloud Run worker. */
async function enqueueCloudTask({ uid, jobId, priority }: EnqueueParams): Promise<void> {
  const project =
    process.env.CLOUD_TASKS_PROJECT_ID ??
    process.env.GCLOUD_PROJECT ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const location = process.env.EXPORT_QUEUE_LOCATION;
  const workerUrl = process.env.EXPORT_WORKER_URL;
  const invokerSa = process.env.EXPORT_INVOKER_SA;
  const queueEnv =
    priority === "priority" ? "EXPORT_QUEUE_PRIORITY" : "EXPORT_QUEUE_NORMAL";
  const queue =
    priority === "priority"
      ? process.env.EXPORT_QUEUE_PRIORITY
      : process.env.EXPORT_QUEUE_NORMAL;

  if (!project || !location || !workerUrl || !invokerSa || !queue) {
    const missing = [
      !project &&
        "CLOUD_TASKS_PROJECT_ID (or GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT / NEXT_PUBLIC_FIREBASE_PROJECT_ID)",
      !location && "EXPORT_QUEUE_LOCATION",
      !workerUrl && "EXPORT_WORKER_URL",
      !invokerSa && "EXPORT_INVOKER_SA",
      !queue && queueEnv,
    ].filter(Boolean);
    const msg = `Cloud Tasks dispatch is misconfigured — missing env: ${missing.join(", ")}.`;
    console.error(`[export-enqueue] ${msg}`, { jobId, priority });
    throw new Error(msg);
  }

  const client = new CloudTasksClient();
  const parent = client.queuePath(project, location, queue);
  try {
    const [task] = await client.createTask({
      parent,
      task: {
        httpRequest: {
          httpMethod: "POST",
          url: workerUrl,
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify({ uid, jobId })).toString("base64"),
          oidcToken: {
            serviceAccountEmail: invokerSa,
            // Audience must equal the worker URL so the worker can verify `aud`.
            audience: workerUrl,
          },
        },
      },
    });
    console.log(
      `[export-enqueue] queued Cloud Task for job ${jobId} (${priority}) on ${queue} → ${task.name ?? "(unnamed)"}`
    );
  } catch (err) {
    // Surface the REAL reason (gRPC status code + message + non-secret target
    // config) so production logs explain why dispatch failed, instead of only
    // the generic 502 the client sees.
    const code = (err as { code?: unknown })?.code;
    console.error(`[export-enqueue] createTask failed for job ${jobId}`, {
      jobId,
      priority,
      project,
      location,
      queue,
      workerUrl,
      invokerSa,
      grpcCode: code,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err instanceof Error
      ? err
      : new Error(`Cloud Tasks createTask failed: ${String(err)}`);
  }
}
