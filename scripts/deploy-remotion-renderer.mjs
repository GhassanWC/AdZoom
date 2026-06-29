#!/usr/bin/env node
/**
 * Builds + deploys the Framevo Remotion renderer as a Cloud Run JOB (run-to-
 * completion). The Next.js server triggers ONE execution per export via
 * src/lib/export/remotion-backend.ts (EXPORT_BACKEND=remotion).
 *
 * The image bundles the composition + shared render math from the repo-root src/,
 * so the Docker build context MUST be the repo root — this submits the build via
 * services/remotion-renderer/cloudbuild.yaml from the repo root.
 *
 * Required env:
 *   PROJECT_ID        GCP project (build + Artifact Registry + Cloud Run)  [adzoom-prod]
 *   REGION            Cloud Run + Artifact Registry region                 [us-central1]
 *   ARTIFACT_REPO     Artifact Registry repo                               [framevo]
 *   RENDERER_SA       Job runtime SA (datastore.user + storage.objectAdmin + AR reader)
 *   BUCKET            Firebase/GCS bucket for source + export objects
 * Optional:
 *   JOB_NAME          Cloud Run Job name        [framevo-remotion-renderer]
 *   IMAGE_TAG         image tag                 [<git sha>]
 *   APP_PROJECT_ID    Firestore project         [PROJECT_ID]
 *   REMOTION_CRF / REMOTION_X264_PRESET / REMOTION_EXPORT_TIMEOUT_SECONDS / REMOTION_CONCURRENCY
 *
 * This deploys the JOB only. It does NOT flip EXPORT_BACKEND — set that to
 * "remotion" on the Next.js (App Hosting) runtime when you're ready (Phase 3).
 *
 * PowerShell (from repo root):
 *   $env:PROJECT_ID="adzoom-prod"; $env:REGION="us-central1"; $env:ARTIFACT_REPO="framevo";
 *   $env:RENDERER_SA="framevo-remotion@adzoom-prod.iam.gserviceaccount.com";
 *   $env:BUCKET="adzoom-prod.firebasestorage.app"; npm run remotion:deploy
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const GCLOUD = process.platform === "win32" ? "gcloud.cmd" : "gcloud";
const CLOUDBUILD_CONFIG = "services/remotion-renderer/cloudbuild.yaml";

const REQUIRED = ["PROJECT_ID", "REGION", "ARTIFACT_REPO", "RENDERER_SA", "BUCKET"];
const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
if (missing.length) {
  bail(`Missing required env: ${missing.join(", ")}`);
}

const PROJECT_ID = env("PROJECT_ID");
const REGION = env("REGION");
const ARTIFACT_REPO = env("ARTIFACT_REPO");
const RENDERER_SA = env("RENDERER_SA");
const BUCKET = env("BUCKET");
const JOB_NAME = env("JOB_NAME", "framevo-remotion-renderer");
const APP_PROJECT_ID = env("APP_PROJECT_ID", PROJECT_ID);
const BUILD_VERSION = gitShortSha();
const IMAGE_TAG = env("IMAGE_TAG", BUILD_VERSION);
const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/remotion-renderer:${IMAGE_TAG}`;

const REMOTION_CRF = env("REMOTION_CRF", "18");
const REMOTION_X264_PRESET = env("REMOTION_X264_PRESET", "medium");
const REMOTION_EXPORT_TIMEOUT_SECONDS = env("REMOTION_EXPORT_TIMEOUT_SECONDS", "1800");

console.log("\n→ Framevo Remotion renderer (Cloud Run Job) deploy");
console.log(`  Project:     ${PROJECT_ID}`);
console.log(`  Region:      ${REGION}`);
console.log(`  Job:         ${JOB_NAME}`);
console.log(`  Image:       ${IMAGE}`);
console.log(`  Runtime SA:  ${RENDERER_SA}`);
console.log(`  Bucket:      gs://${BUCKET}`);
console.log(`  Build:       ${BUILD_VERSION}`);

// ── 1. Build the image (repo-root context via cloudbuild.yaml) ──
run(
  [
    "builds", "submit",
    `--project=${PROJECT_ID}`,
    `--config=${CLOUDBUILD_CONFIG}`,
    `--substitutions=_IMAGE=${IMAGE},_BUILD_VERSION=${BUILD_VERSION}`,
    ".",
  ],
  "Cloud Build (image)"
);

// ── 2. Create-or-update the Cloud Run Job ──
const envVars = [
  "NODE_ENV=production",
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID=${APP_PROJECT_ID}`,
  `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=${BUCKET}`,
  `BUILD_VERSION=${BUILD_VERSION}`,
  `REMOTION_CRF=${REMOTION_CRF}`,
  `REMOTION_X264_PRESET=${REMOTION_X264_PRESET}`,
  `REMOTION_EXPORT_TIMEOUT_SECONDS=${REMOTION_EXPORT_TIMEOUT_SECONDS}`,
];
run(
  [
    "run", "jobs", "deploy", JOB_NAME,
    `--project=${PROJECT_ID}`,
    `--image=${IMAGE}`,
    `--region=${REGION}`,
    `--service-account=${RENDERER_SA}`,
    "--cpu=4",
    "--memory=8Gi",
    "--task-timeout=1800",
    "--max-retries=0",
    `--set-env-vars=${envVars.join(",")}`,
  ],
  "Cloud Run Job deploy"
);

console.log(`\n✓ Deployed Cloud Run Job ${JOB_NAME} (${IMAGE}).`);
console.log("  Next: set EXPORT_BACKEND=remotion + REMOTION_RUN_REGION + REMOTION_JOB_NAME on the Next.js runtime (Phase 3),");
console.log("        and grant the App Hosting SA run.jobs.run + actAs on the renderer SA.");

// ── helpers ──
function env(key, fallback) {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : fallback;
}
function gitShortSha() {
  const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf-8" });
  if (sha.status !== 0) return "dev";
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" });
  const isDirty = dirty.status === 0 && (dirty.stdout || "").trim().length > 0;
  return (sha.stdout || "").trim() + (isDirty ? "-dirty" : "");
}
function run(args, label) {
  console.log(`\n→ ${label}: gcloud ${args.join(" ")}`);
  const res = spawnSync(GCLOUD, args, { cwd: root, stdio: "inherit" });
  if (res.error) {
    if (res.error.code === "ENOENT") bail("gcloud not found on PATH. Install the Google Cloud CLI + run `gcloud auth login`.");
    bail(`${label} failed to start: ${res.error.message}`);
  }
  if (res.status !== 0) bail(`${label} exited with code ${res.status}.`);
}
function bail(msg) {
  console.error("\n✗", msg);
  process.exit(1);
}
