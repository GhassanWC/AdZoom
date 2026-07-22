#!/usr/bin/env node
/**
 * Builds + deploys the Framevo export worker (services/export-worker) to
 * Cloud Run.
 *
 * The image bundles the app's SHARED render core from the repo-root src/
 * (for pixel parity with the browser exporter), so the Docker build context
 * MUST be the repo root. This script therefore submits the build from the
 * repo root using services/export-worker/cloudbuild.yaml — NOT
 * `gcloud run deploy --source services/export-worker` (which would scope the
 * context to the worker dir and lose ../../src).
 *
 * Nothing here is hard-coded — every project-specific value comes from the
 * environment. Required env vars:
 *
 *   PROJECT_ID              GCP project id (e.g. adzoom-prod)
 *   REGION                  Cloud Run + Artifact Registry region (e.g. us-central1)
 *   ARTIFACT_REPO           Artifact Registry repo name (e.g. framevo)
 *   BUCKET                  Firebase/GCS bucket for source + export objects
 *   WORKER_SERVICE_ACCOUNT  runtime SA email for the Cloud Run service
 *   EXPORT_INVOKER_SA       SA email allowed to invoke the worker (token `email`)
 *
 * Optional env vars:
 *   IMAGE_TAG               image tag (default: "latest")
 *   WORKER_SERVICE_NAME     Cloud Run service name (default: "framevo-export-worker")
 *
 * This script deliberately does NOT set CLOUD_EXPORT_ENABLED — cloud export
 * stays gated until the render-parity test is green. Enable it on the MAIN
 * app, not here.
 *
 * Windows CMD usage (run from the repo root):
 *
 *   set PROJECT_ID=adzoom-prod
 *   set REGION=us-central1
 *   set ARTIFACT_REPO=framevo
 *   set BUCKET=adzoom-prod.appspot.com
 *   set WORKER_SERVICE_ACCOUNT=export-worker@adzoom-prod.iam.gserviceaccount.com
 *   set EXPORT_INVOKER_SA=export-invoker@adzoom-prod.iam.gserviceaccount.com
 *   npm run worker:deploy
 *
 * Or inline for a single run (Windows CMD, no persistence):
 *
 *   set "PROJECT_ID=adzoom-prod" && set "REGION=us-central1" && set "ARTIFACT_REPO=framevo" && set "BUCKET=adzoom-prod.appspot.com" && set "WORKER_SERVICE_ACCOUNT=export-worker@adzoom-prod.iam.gserviceaccount.com" && set "EXPORT_INVOKER_SA=export-invoker@adzoom-prod.iam.gserviceaccount.com" && npm run worker:deploy
 *
 * PowerShell equivalent:
 *
 *   $env:PROJECT_ID="adzoom-prod"; $env:REGION="us-central1"; $env:ARTIFACT_REPO="framevo"; $env:BUCKET="adzoom-prod.appspot.com"; $env:WORKER_SERVICE_ACCOUNT="export-worker@adzoom-prod.iam.gserviceaccount.com"; $env:EXPORT_INVOKER_SA="export-invoker@adzoom-prod.iam.gserviceaccount.com"; npm run worker:deploy
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

const CLOUDBUILD_CONFIG = "services/export-worker/cloudbuild.yaml";

// ── Read + validate config from the environment (no secrets hard-coded). ──
const REQUIRED = [
  "PROJECT_ID",
  "REGION",
  "ARTIFACT_REPO",
  "BUCKET",
  "WORKER_SERVICE_ACCOUNT",
  "EXPORT_INVOKER_SA",
];

const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
if (missing.length) {
  console.error("\n✗ Missing required environment variable(s):");
  for (const k of missing) console.error(`    ${k}`);
  console.error(
    "\nSet them before running. Windows CMD example (run from repo root):\n" +
      "    set PROJECT_ID=adzoom-prod\n" +
      "    set REGION=us-central1\n" +
      "    set ARTIFACT_REPO=framevo\n" +
      "    set BUCKET=adzoom-prod.appspot.com\n" +
      "    set WORKER_SERVICE_ACCOUNT=export-worker@adzoom-prod.iam.gserviceaccount.com\n" +
      "    set EXPORT_INVOKER_SA=export-invoker@adzoom-prod.iam.gserviceaccount.com\n" +
      "    npm run worker:deploy\n"
  );
  process.exit(1);
}

const {
  PROJECT_ID,
  REGION,
  ARTIFACT_REPO,
  BUCKET,
  WORKER_SERVICE_ACCOUNT,
  EXPORT_INVOKER_SA,
} = process.env;
const IMAGE_TAG = process.env.IMAGE_TAG?.trim() || "latest";
const SERVICE = process.env.WORKER_SERVICE_NAME?.trim() || "framevo-export-worker";

const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/export-worker:${IMAGE_TAG}`;

console.log("\n→ Framevo export worker deploy");
console.log(`  Project:          ${PROJECT_ID}`);
console.log(`  Region:           ${REGION}`);
console.log(`  Service:          ${SERVICE}`);
console.log(`  Image:            ${IMAGE}`);
console.log(`  Bucket:           gs://${BUCKET}`);
console.log(`  Runtime SA:       ${WORKER_SERVICE_ACCOUNT}`);
console.log(`  Invoker SA:       ${EXPORT_INVOKER_SA}`);
console.log(`  Build context:    ${root} (repo root — bundles shared src/)`);

// ── 1. Build the image (repo-root context via cloudbuild.yaml). ──
run(
  [
    "builds",
    "submit",
    `--project=${PROJECT_ID}`,
    `--config=${CLOUDBUILD_CONFIG}`,
    `--substitutions=_IMAGE=${IMAGE}`,
    ".",
  ],
  "Cloud Build (image)"
);

// ── 2. Deploy to Cloud Run. Note: WORKER_OIDC_AUDIENCE is the worker's own
// URL, which doesn't exist until after the first deploy — so we set the rest
// of the env here, then resolve the URL and set the audience in step 4. ──
run(
  [
    "run",
    "deploy",
    SERVICE,
    `--project=${PROJECT_ID}`,
    `--image=${IMAGE}`,
    `--region=${REGION}`,
    "--no-allow-unauthenticated",
    "--memory=4Gi",
    "--cpu=4",
    "--timeout=3600",
    "--concurrency=1",
    "--min-instances=0",
    "--max-instances=10",
    `--service-account=${WORKER_SERVICE_ACCOUNT}`,
    // CLOUD_EXPORT_ENABLED is intentionally NOT set — keep cloud export gated.
    `--set-env-vars=NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=${BUCKET},EXPORT_INVOKER_SA=${EXPORT_INVOKER_SA}`,
  ],
  "Cloud Run deploy"
);

// ── 3. Resolve the live service URL. ──
const serviceUrl = capture([
  "run",
  "services",
  "describe",
  SERVICE,
  `--project=${PROJECT_ID}`,
  `--region=${REGION}`,
  "--format=value(status.url)",
]);

if (!serviceUrl) {
  console.error(
    "\n✗ Deployed, but could not read the service URL back. " +
      "Run:\n" +
      `    gcloud run services describe ${SERVICE} --project=${PROJECT_ID} --region=${REGION} --format="value(status.url)"`
  );
  process.exit(1);
}

// ── 4. Set WORKER_OIDC_AUDIENCE to the worker's own URL (the worker verifies
// the OIDC token `aud` against this). --update-env-vars preserves the env set
// in step 2. ──
run(
  [
    "run",
    "services",
    "update",
    SERVICE,
    `--project=${PROJECT_ID}`,
    `--region=${REGION}`,
    `--update-env-vars=WORKER_OIDC_AUDIENCE=${serviceUrl}`,
  ],
  "Set WORKER_OIDC_AUDIENCE"
);

console.log("\n✓ Export worker deployed.");
console.log(`    Image URL:    ${IMAGE}`);
console.log(`    Service URL:  ${serviceUrl}`);
console.log(
  "\nNext: point the main app at this worker (e.g. EXPORT_WORKER_URL / " +
    "EXPORT_DISPATCH=cloudtasks) and keep CLOUD_EXPORT_ENABLED off until the " +
    "render-parity test is green."
);

// ── helpers ──────────────────────────────────────────────────────────────

/** Run gcloud with live output; abort the script on failure. */
function run(args, label) {
  console.log(`\n→ ${label}: gcloud ${args.join(" ")}`);
  const res = spawnSync(GCLOUD, gcloudArgs(args), { cwd: root, stdio: "inherit", ...GCLOUD_SPAWN });
  if (res.error) {
    if (res.error.code === "ENOENT") {
      bail(
        "gcloud not found on PATH. Install the Google Cloud CLI and run " +
          "`gcloud auth login` first."
      );
    }
    bail(`${label} failed to start: ${res.error.message}`);
  }
  if (res.status !== 0) bail(`${label} exited with code ${res.status}.`);
}

/** Run gcloud and return trimmed stdout (stderr/progress still shown). */
function capture(args) {
  const res = spawnSync(GCLOUD, gcloudArgs(args), {
    ...GCLOUD_SPAWN,
    cwd: root,
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf-8",
  });
  if (res.error) {
    if (res.error.code === "ENOENT") {
      bail("gcloud not found on PATH.");
    }
    bail(`gcloud ${args[0]} failed to start: ${res.error.message}`);
  }
  if (res.status !== 0) bail(`gcloud ${args.join(" ")} exited with code ${res.status}.`);
  return (res.stdout || "").trim();
}

function bail(msg) {
  console.error("\n✗", msg);
  process.exit(1);
}
