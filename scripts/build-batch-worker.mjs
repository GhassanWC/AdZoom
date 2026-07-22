#!/usr/bin/env node
/**
 * Builds + pushes the Framevo Google Cloud Batch export-worker image to Artifact
 * Registry under an IMMUTABLE tag (e.g. batch-v9). This is the SAME image as the
 * Cloud Run / VM worker (services/export-api-dotnet/Dockerfile) — the run mode is
 * chosen at runtime by env (EXPORT_JOB_ID / EXPORT_WORKER_MODE=single-job).
 *
 * Why a separate script (vs deploy-export-api-dotnet.mjs):
 *   • Production Batch jobs must pin an IMMUTABLE tag, NOT ":latest". A floating
 *     ":latest" silently diverged from the code once already (the Batch tasks ran
 *     an old image with no [batch-worker] shard logging), which is exactly the
 *     failure this script exists to prevent. So this script REFUSES to build
 *     ":latest" unless you opt in with ALLOW_LATEST=1.
 *   • It targets the framevo-workers/export-worker repo the Batch submitter pulls
 *     from (BATCH_IMAGE), which differs from the Cloud Run framevo/export-api repo.
 *
 * It does NOT repoint production. Building a new tag is side-effect-free until you
 * set BATCH_IMAGE to it on the Next.js runtime — do that ONLY after verifying the
 * new image enters the real Batch shard path (see the printed next steps).
 *
 * The image bundles the Node render CLI (which inlines repo-root src/), so the
 * Docker build context MUST be the repo root — this submits the build via
 * services/export-api-dotnet/cloudbuild.yaml from the repo root.
 *
 * Config from the environment (prod defaults shown):
 *   TAG            REQUIRED. Immutable tag, e.g. "batch-v9". Refuses "latest".
 *   PROJECT_ID     GCP project (build + Artifact Registry)            [adzoom-prod]
 *   REGION         Artifact Registry region                          [us-central1]
 *   ARTIFACT_REPO  Artifact Registry repo                            [framevo-workers]
 *   IMAGE_NAME     image name within the repo                        [export-worker]
 *   ALLOW_LATEST=1 allow TAG=latest (discouraged for Batch)
 *
 * PowerShell (from repo root):
 *   $env:TAG="batch-v9"; npm run batch:build
 * Bash:
 *   TAG=batch-v9 npm run batch:build
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
const CLOUDBUILD_CONFIG = "services/export-api-dotnet/cloudbuild.yaml";

const PROJECT_ID = env("PROJECT_ID", "adzoom-prod");
const REGION = env("REGION", "us-central1");
const ARTIFACT_REPO = env("ARTIFACT_REPO", "framevo-workers");
const IMAGE_NAME = env("IMAGE_NAME", "export-worker");
const TAG = (process.env.TAG || "").trim();

if (!TAG) {
  bail(
    'Set TAG to the IMMUTABLE tag to build, e.g.  TAG=batch-v9 npm run batch:build\n' +
      "    Existing tags: list with\n" +
      `    gcloud artifacts docker tags list ${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/${IMAGE_NAME}`
  );
}
if (TAG === "latest" && process.env.ALLOW_LATEST !== "1") {
  bail(
    'Refusing to build ":latest" for the Batch worker — production Batch jobs must pin an\n' +
      "    immutable tag (a floating :latest silently diverged from the code once already).\n" +
      "    Use TAG=batch-vN. To override anyway: ALLOW_LATEST=1 TAG=latest npm run batch:build"
  );
}

const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/${IMAGE_NAME}:${TAG}`;
const buildVersion = gitShortSha();

console.log("\n→ Framevo Batch export-worker image build");
console.log(`  Project:        ${PROJECT_ID}`);
console.log(`  Image:          ${IMAGE}`);
console.log(`  Build version:  ${buildVersion}`);
console.log(`  Build context:  ${root} (repo root)`);
if (buildVersion.endsWith("-dirty")) {
  console.warn("  ⚠ Working tree is DIRTY — the image will be stamped <sha>-dirty. Commit for a clean, traceable build.");
}

run(
  [
    "builds", "submit",
    `--project=${PROJECT_ID}`,
    `--config=${CLOUDBUILD_CONFIG}`,
    `--substitutions=_IMAGE=${IMAGE},_BUILD_VERSION=${buildVersion}`,
    ".",
  ],
  "Cloud Build (Batch worker image)"
);

const digest = capture(
  [
    "artifacts", "docker", "images", "describe", IMAGE,
    `--project=${PROJECT_ID}`, "--format=value(image_summary.digest)",
  ],
  { allowFail: true }
);

console.log(`\n✓ Built + pushed.\n    Image:   ${IMAGE}${digest ? `\n    Digest:  ${digest}` : ""}`);
console.log(
  "\n  Next steps (do NOT skip the verify before repointing prod):\n" +
    `    1. Submit a test export and confirm the Batch logs show the [batch-worker] shard lines:\n` +
    `         gcloud logging read 'resource.type="batch.googleapis.com/Job" AND textPayload:"[batch-worker]"' \\\n` +
    `           --project=${PROJECT_ID} --order=asc --limit=100\n` +
    `       (Temporarily point BATCH_IMAGE at ${IMAGE} in a staging runtime, or submit a one-off\n` +
    `        Batch job from this image, to verify BEFORE touching production.)\n` +
    `    2. Only after the shard logs appear, repoint production:\n` +
    `         BATCH_IMAGE=${IMAGE}\n` +
    `       (set on the Next.js runtime; keep the previous tag available for rollback).`
);

// ── helpers ──
function env(key, fallback) {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : fallback;
}

function gitShortSha() {
  const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf-8" });
  if (sha.status !== 0) return "unknown";
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" });
  const isDirty = dirty.status === 0 && (dirty.stdout || "").trim().length > 0;
  return (sha.stdout || "").trim() + (isDirty ? "-dirty" : "");
}

function run(args, label) {
  console.log(`\n→ ${label}: gcloud ${args.join(" ")}`);
  const res = spawnSync(GCLOUD, gcloudArgs(args), { cwd: root, stdio: "inherit", ...GCLOUD_SPAWN });
  if (res.error) {
    if (res.error.code === "ENOENT") bail("gcloud not found on PATH. Install the Google Cloud CLI + run `gcloud auth login`.");
    bail(`${label} failed to start: ${res.error.message}`);
  }
  if (res.status !== 0) bail(`${label} exited with code ${res.status}.`);
}

function capture(args, { allowFail = false } = {}) {
  const res = spawnSync(GCLOUD, gcloudArgs(args), { cwd: root, stdio: ["inherit", "pipe", "inherit"], encoding: "utf-8", ...GCLOUD_SPAWN });
  if (res.error || res.status !== 0) {
    if (allowFail) return "";
    bail(`gcloud ${args[0]} failed${res.error ? `: ${res.error.message}` : ` (exit ${res.status})`}.`);
  }
  return (res.stdout || "").trim();
}

function bail(msg) {
  console.error("\n✗", msg);
  process.exit(1);
}
