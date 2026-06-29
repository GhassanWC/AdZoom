import "server-only";
// Static, server-only import. Externalized in next.config.ts (serverExternalPackages)
// so @google-cloud/run's google-gax/gRPC dynamic proto requires resolve from
// node_modules at runtime instead of being bundled by webpack.
import { JobsClient, ExecutionsClient } from "@google-cloud/run";
import { getAdmin } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Google Cloud Run JOB dispatch for the Remotion exporter (EXPORT_BACKEND=remotion).
 *
 * Next.js already CREATED + reserved the `exportJobs/{jobId}` doc (the shared
 * createCloudExportJob transaction). This triggers ONE Cloud Run Job execution of
 * the `services/remotion-renderer` image, passing EXPORT_JOB_ID/EXPORT_JOB_UID as
 * per-execution env overrides. The container reads the doc (which already has the
 * renderRecipe + source/output paths), renders ONE MP4 with @remotion/renderer,
 * uploads it, settles minutes, and writes the terminal status — the same doc
 * schema the existing UI/reconciler understand. The job stays `queued` until the
 * worker claims it → `rendering` (there is no Batch-style intermediate status).
 *
 * Required server env:
 *   REMOTION_RUN_REGION    GCP region of the Cloud Run Job (e.g. "us-central1")
 *   REMOTION_JOB_NAME      Cloud Run Job name (e.g. "framevo-remotion-renderer")
 * Optional:
 *   REMOTION_PROJECT_ID    (falls back to BATCH_PROJECT_ID / GCLOUD_PROJECT /
 *                           GOOGLE_CLOUD_PROJECT / NEXT_PUBLIC_FIREBASE_PROJECT_ID)
 *   REMOTION_EXPORT_TIMEOUT_SECONDS  per-execution hard timeout (default 1800)
 */

export interface RunRemotionParams {
  uid: string;
  jobId: string;
  priority: "normal" | "priority";
}

function projectId(): string | undefined {
  return (
    process.env.REMOTION_PROJECT_ID ||
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

/**
 * Trigger one Cloud Run Job execution. Records `remotionExecutionName` on the doc
 * (best-effort) so a later cancel can stop the execution. Throws on misconfig /
 * RPC failure so createCloudExportJob's catch rolls back the minute reservation
 * and fails the job (same contract as submitBatchJob).
 */
export async function runRemotionJob({ uid, jobId }: RunRemotionParams): Promise<void> {
  const project = projectId();
  const region = process.env.REMOTION_RUN_REGION?.trim();
  const jobName = process.env.REMOTION_JOB_NAME?.trim();

  if (!project || !region || !jobName) {
    const missing = [
      !project && "REMOTION_PROJECT_ID (or GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT / NEXT_PUBLIC_FIREBASE_PROJECT_ID)",
      !region && "REMOTION_RUN_REGION",
      !jobName && "REMOTION_JOB_NAME",
    ].filter(Boolean);
    const msg = `Cloud Run Remotion dispatch is misconfigured — missing env: ${missing.join(", ")}.`;
    console.error(`[export-enqueue] ${msg}`, { jobId });
    throw new Error(msg);
  }

  const name = `projects/${project}/locations/${region}/jobs/${jobName}`;
  const timeoutSeconds = intEnv("REMOTION_EXPORT_TIMEOUT_SECONDS", 1800);
  const client = new JobsClient();

  let executionName: string | undefined;
  try {
    // runJob returns once the EXECUTION is created (a long-running operation). We
    // do NOT await operation.promise() — the render runs in the container; the
    // worker writes status/progress to Firestore directly.
    const [operation] = await client.runJob({
      name,
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: "EXPORT_JOB_ID", value: jobId },
              { name: "EXPORT_JOB_UID", value: uid },
            ],
          },
        ],
        taskCount: 1,
        timeout: { seconds: timeoutSeconds },
      },
    });
    // The LRO's metadata carries the created Execution (best-effort — may be
    // undefined depending on the control-plane response).
    executionName =
      (operation as { metadata?: { name?: string | null } }).metadata?.name ?? undefined;
    console.log(
      `[export-enqueue] backend=remotion started job=${jobId} execution=${executionName ?? "(name pending)"}`
    );
  } catch (err) {
    console.error(`[export-enqueue] backend=remotion runJob failed for job ${jobId}`, {
      jobId,
      project,
      region,
      jobName,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err instanceof Error ? err : new Error(`Cloud Run runJob failed: ${String(err)}`);
  }

  // Record the execution name (+ a submit marker) so cancel can stop the VM. The
  // render is already on its way, so a failed status write must NOT roll back.
  try {
    const { db } = getAdmin();
    await db.doc(`users/${uid}/exportJobs/${jobId}`).set(
      {
        ...(executionName ? { remotionExecutionName: executionName } : {}),
        remotionSubmittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.warn("[export-enqueue] backend=remotion status write failed (job still submitted)", {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Best-effort stop of a running Remotion Job execution so its VM is torn down and
 * STOPS BILLING when the user cancels. The worker's own cancelRequested poll is
 * the backstop that makes the render abort even if this call fails; this only
 * trims billing. Bounded + never throws. Returns true when Cloud Run acknowledged.
 */
export async function cancelRemotionExecution({
  executionName,
}: {
  executionName?: string | null;
}): Promise<boolean> {
  const name = executionName?.trim();
  if (!name) return false;
  try {
    const client = new ExecutionsClient();
    await client.cancelExecution({ name }, { timeout: 10_000 });
    console.log(`[export-cancel] backend=remotion cancelExecution initiated name=${name}`);
    return true;
  } catch (err) {
    console.warn(`[export-cancel] backend=remotion cancelExecution failed name=${name}`, {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
