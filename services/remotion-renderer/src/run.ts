/**
 * Cloud Run JOB entry point (run-to-completion; no HTTP server). The execution is
 * triggered by src/lib/export/remotion-backend.ts with EXPORT_JOB_ID/EXPORT_JOB_UID
 * injected as per-execution env overrides. Renders the one job and exits:
 * 0 = ready/canceled/terminal/leased, non-zero = failed (Cloud Run marks it failed).
 */
import { processRemotionJob } from "./worker.js";

async function main(): Promise<void> {
  const build = process.env.BUILD_VERSION ?? "unknown";
  console.info(`[remotion-worker] container started build=${build} node=${process.version}`);
  const uid = process.env.EXPORT_JOB_UID?.trim();
  const jobId = process.env.EXPORT_JOB_ID?.trim();
  console.info(
    `[remotion-worker] env EXPORT_JOB_UID=${uid ?? "(unset)"} EXPORT_JOB_ID=${jobId ?? "(unset)"}`
  );
  if (!uid || !jobId) {
    console.error("[remotion-worker] FATAL: missing EXPORT_JOB_UID/EXPORT_JOB_ID — nothing to render");
    process.exit(1);
  }
  try {
    const result = await processRemotionJob(uid, jobId);
    console.info(`[remotion-worker] finished result=${result}`);
    process.exit(result === "failed" ? 1 : 0);
  } catch (err) {
    console.error("[remotion-worker] FATAL unhandled error", err);
    process.exit(1);
  }
}

void main();
