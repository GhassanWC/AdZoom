import "server-only";

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
}

/** Dispatch a created export job to the worker. Throws on failure so the caller
 *  can fail the job + release its minute reservation. */
export async function enqueueExportJob(params: EnqueueParams): Promise<void> {
  const mode = (process.env.EXPORT_DISPATCH ?? "local").toLowerCase();
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
  const { CloudTasksClient } = await import("@google-cloud/tasks");

  const project =
    process.env.GCLOUD_PROJECT ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const location = process.env.EXPORT_QUEUE_LOCATION;
  const workerUrl = process.env.EXPORT_WORKER_URL;
  const invokerSa = process.env.EXPORT_INVOKER_SA;
  const queue =
    priority === "priority"
      ? process.env.EXPORT_QUEUE_PRIORITY
      : process.env.EXPORT_QUEUE_NORMAL;

  if (!project || !location || !workerUrl || !invokerSa || !queue) {
    throw new Error(
      "Cloud Tasks dispatch is misconfigured. Required env: GCLOUD_PROJECT (or NEXT_PUBLIC_FIREBASE_PROJECT_ID), EXPORT_QUEUE_LOCATION, EXPORT_WORKER_URL, EXPORT_INVOKER_SA, EXPORT_QUEUE_NORMAL, EXPORT_QUEUE_PRIORITY."
    );
  }

  const client = new CloudTasksClient();
  const parent = client.queuePath(project, location, queue);
  await client.createTask({
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
}
