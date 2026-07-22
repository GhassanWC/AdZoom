#!/usr/bin/env node
/**
 * Builds + deploys the Framevo ASR worker (services/asr-worker) to Cloud Run.
 *
 * The image bundles the app's SHARED transcript pipeline from the repo-root
 * src/ (provider, Google Speech, caption quota verification, caption
 * generator, Firestore updates), so the Docker build context MUST be the repo
 * root. This script therefore submits the build from the repo root using
 * services/asr-worker/cloudbuild.yaml — NOT
 * `gcloud run deploy --source services/asr-worker` (which would scope the
 * context to the worker dir and lose ../../src), and NOT
 * `gcloud run deploy --source .` (no root Dockerfile ⇒ Buildpacks scan the
 * whole monorepo and fail on the nested .NET projects).
 *
 * Nothing here is hard-coded — every project-specific value comes from the
 * environment. Required env vars:
 *
 *   PROJECT_ID                 GCP project id (e.g. adzoom-prod)
 *   REGION                     Cloud Run region (e.g. us-central1)
 *   BUCKET                     Firebase/GCS bucket (long-audio ASR uploads)
 *   TRANSCRIPT_WORKER_SECRET   shared secret the app sends as x-internal-secret
 *
 * Optional env vars:
 *   ARTIFACT_REPO              Artifact Registry repo (default: gcr.io path)
 *   IMAGE_TAG                  image tag (default: "latest")
 *   ASR_SERVICE_NAME           Cloud Run service name (default: "framevo-asr-worker")
 *   ASR_SERVICE_ACCOUNT        runtime SA email (needs Firestore + Storage + Speech)
 *   TRANSCRIPT_MODEL           Speech model (default: "latest_long")
 *
 * Windows CMD usage (run from the repo root):
 *
 *   set PROJECT_ID=adzoom-prod
 *   set REGION=us-central1
 *   set BUCKET=adzoom-prod.appspot.com
 *   set TRANSCRIPT_WORKER_SECRET=your-long-random-secret
 *   npm run asr:deploy
 *
 * After deploy, point the APP at the worker (App Hosting env / .env):
 *   TRANSCRIPT_EXECUTION=worker
 *   TRANSCRIPT_WORKER_URL=<service URL printed below>
 *   TRANSCRIPT_WORKER_SECRET=<same secret>
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const IS_WIN = process.platform === "win32";
const GCLOUD = IS_WIN ? "gcloud.cmd" : "gcloud";
/**
 * Windows gcloud is a .cmd shim, and since the CVE-2024-27980 fix Node refuses
 * to spawn .cmd/.bat directly — it throws EINVAL unless the call goes through a
 * shell. `shell: true` does NOT quote for you and cmd.exe would split
 * `--substitutions=A=1,B=2` at the comma, so quote every arg here.
 */
const gcloudArgs = (args) => (IS_WIN ? args.map((a) => `"${a}"`) : args);
const GCLOUD_SPAWN = { shell: IS_WIN };

function need(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const PROJECT_ID = need("PROJECT_ID");
const REGION = need("REGION");
const BUCKET = need("BUCKET");
const SECRET = need("TRANSCRIPT_WORKER_SECRET");
const TAG = process.env.IMAGE_TAG?.trim() || "latest";
const SERVICE = process.env.ASR_SERVICE_NAME?.trim() || "framevo-asr-worker";
const ARTIFACT_REPO = process.env.ARTIFACT_REPO?.trim();
const SERVICE_ACCOUNT = process.env.ASR_SERVICE_ACCOUNT?.trim();
const MODEL = process.env.TRANSCRIPT_MODEL?.trim() || "latest_long";

const image = ARTIFACT_REPO
  ? `${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/${SERVICE}:${TAG}`
  : `gcr.io/${PROJECT_ID}/${SERVICE}:${TAG}`;

function run(args) {
  console.log(`\n$ gcloud ${args.join(" ")}`);
  const r = spawnSync(GCLOUD, gcloudArgs(args), { cwd: root, stdio: "inherit", ...GCLOUD_SPAWN });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 1. Build the image with the REPO ROOT as context (shared src/ included).
run([
  "builds",
  "submit",
  "--project",
  PROJECT_ID,
  "--config",
  "services/asr-worker/cloudbuild.yaml",
  "--substitutions",
  `_IMAGE=${image}`,
  ".",
]);

// 2. Deploy. --no-cpu-throttling keeps CPU allocated after the dispatcher's
//    fetch aborts (~10s) while the held-open request finishes ASR + writes;
//    --timeout bounds the longest job.
const envVars = [
  `TRANSCRIPT_PROVIDER=google_speech`,
  `TRANSCRIPT_WORKER_SECRET=${SECRET}`,
  `TRANSCRIPT_MODEL=${MODEL}`,
  `GOOGLE_CLOUD_PROJECT_ID=${PROJECT_ID}`,
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID=${PROJECT_ID}`,
  `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=${BUCKET}`,
].join(",");

run([
  "run",
  "deploy",
  SERVICE,
  "--project",
  PROJECT_ID,
  "--region",
  REGION,
  "--image",
  image,
  "--platform",
  "managed",
  "--allow-unauthenticated",
  "--no-cpu-throttling",
  "--memory",
  "1Gi",
  "--cpu",
  "1",
  "--concurrency",
  "4",
  "--timeout",
  "900",
  ...(SERVICE_ACCOUNT ? ["--service-account", SERVICE_ACCOUNT] : []),
  "--set-env-vars",
  envVars,
]);

console.log(`
Deployed ${SERVICE}. Now point the APP at it (App Hosting env / .env):
  TRANSCRIPT_EXECUTION=worker
  TRANSCRIPT_WORKER_URL=<the service URL printed above>
  TRANSCRIPT_WORKER_SECRET=<the same secret>
`);
