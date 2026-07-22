#!/usr/bin/env node
/**
 * Builds + deploys the Framevo C# export API (services/export-api-dotnet) to
 * Cloud Run, then verifies it: GET /health + a side-effect-free enqueue smoke.
 *
 * The image bundles the Node render CLI (which inlines repo-root src/), so the
 * Docker build context MUST be the repo root — this submits the build via
 * services/export-api-dotnet/cloudbuild.yaml from the repo root.
 *
 * Config from the environment (prod defaults shown; override for other envs):
 *
 *   PROJECT_ID                 GCP project (build + Cloud Run + Artifact Registry)  [adzoom-prod]
 *   REGION                     Cloud Run + Artifact Registry region                 [us-central1]
 *   ARTIFACT_REPO              Artifact Registry repo                               [framevo]
 *   SERVICE_NAME               Cloud Run service name                               [export-api]
 *   SERVICE_ACCOUNT            runtime SA (needs datastore.user + storage.objectAdmin)
 *                                                              [export-api@PROJECT.iam.gserviceaccount.com]
 *   IMAGE_TAG                  image tag                                            [latest]
 *   MAX_INSTANCES              Cloud Run max instances                              [5]
 *   NEXT_PUBLIC_FIREBASE_PROJECT_ID        app Firestore project   [adzoom-prod]
 *   NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET    source/output bucket    [adzoom-prod.firebasestorage.app]
 *
 *   EXPORT_API_INTERNAL_SECRET             shared secret (REQUIRED unless *_NAME set)
 *   EXPORT_API_INTERNAL_SECRET_NAME        Secret Manager resource (e.g. "export-api-secret:latest")
 *                                          — RECOMMENDED; used via --set-secrets instead of a plain env var.
 *
 *   SMOKE_UID                  uid for the enqueue smoke (default "smoke-test-uid" → 402, no side effect)
 *   SKIP_VERIFY=1              skip the post-deploy /health + smoke checks
 *
 * Windows CMD (run from repo root):
 *   set PROJECT_ID=adzoom-prod && set REGION=us-central1 && set ARTIFACT_REPO=framevo ^
 *     && set SERVICE_ACCOUNT=export-api@adzoom-prod.iam.gserviceaccount.com ^
 *     && set EXPORT_API_INTERNAL_SECRET=<secret> && npm run deploy:export-api
 *
 * PowerShell:
 *   $env:EXPORT_API_INTERNAL_SECRET="<secret>"; npm run deploy:export-api
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

// ── Config (prod defaults, all overridable from the environment) ──
const PROJECT_ID = env("PROJECT_ID", "adzoom-prod");
const REGION = env("REGION", "us-central1");
const ARTIFACT_REPO = env("ARTIFACT_REPO", "framevo");
const SERVICE_NAME = env("SERVICE_NAME", "export-api");
const SERVICE_ACCOUNT = env("SERVICE_ACCOUNT", `export-api@${PROJECT_ID}.iam.gserviceaccount.com`);
const IMAGE_TAG = env("IMAGE_TAG", "latest");
const MAX_INSTANCES = env("MAX_INSTANCES", "5");
const APP_PROJECT_ID = env("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "adzoom-prod");
const BUCKET = env("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "adzoom-prod.firebasestorage.app");
const SECRET = (process.env.EXPORT_API_INTERNAL_SECRET || "").trim();
const SECRET_NAME = (process.env.EXPORT_API_INTERNAL_SECRET_NAME || "").trim();
const SMOKE_UID = env("SMOKE_UID", "smoke-test-uid");

const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/export-api:${IMAGE_TAG}`;

if (!SECRET && !SECRET_NAME) {
  bail(
    "Set EXPORT_API_INTERNAL_SECRET (the shared secret value) OR\n" +
      "    EXPORT_API_INTERNAL_SECRET_NAME (a Secret Manager resource like 'export-api-secret:latest', recommended)."
  );
}
if (SECRET && SECRET.includes("~")) {
  bail("EXPORT_API_INTERNAL_SECRET contains '~', which conflicts with the env delimiter. Use EXPORT_API_INTERNAL_SECRET_NAME (Secret Manager) instead.");
}

console.log("\n→ Framevo C# export API deploy");
console.log(`  Project:        ${PROJECT_ID}`);
console.log(`  Region:         ${REGION}`);
console.log(`  Service:        ${SERVICE_NAME}`);
console.log(`  Image:          ${IMAGE}`);
console.log(`  Runtime SA:     ${SERVICE_ACCOUNT}`);
console.log(`  App project:    ${APP_PROJECT_ID}`);
console.log(`  Bucket:         gs://${BUCKET}`);
console.log(`  Secret:         ${SECRET_NAME ? `Secret Manager (${SECRET_NAME})` : "inline env (set)"}`);
console.log(`  Build context:  ${root} (repo root)`);

await main();

async function main() {
  // ── 1. Build the image (repo-root context via cloudbuild.yaml) ──
  // Stamp the git sha into the image (BUILD_VERSION) so a stale VM/Cloud Run
  // image is obvious in the [*:startup]/[*:cli-version] logs.
  const buildVersion = gitShortSha();
  console.log(`  Build version:  ${buildVersion}`);
  run(
    [
      "builds", "submit",
      `--project=${PROJECT_ID}`,
      `--config=${CLOUDBUILD_CONFIG}`,
      `--substitutions=_IMAGE=${IMAGE},_BUILD_VERSION=${buildVersion}`,
      ".",
    ],
    "Cloud Build (image)"
  );

  // ── 2. Deploy to Cloud Run with the required flags + env ──
  const envEntries = [
    "NODE_ENV=production",
    `NEXT_PUBLIC_FIREBASE_PROJECT_ID=${APP_PROJECT_ID}`,
    `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=${BUCKET}`,
    "WORKER_CONCURRENCY=1",
    "WORKER_NORMALIZE_ENABLED=1",
  ];
  const deployArgs = [
    "run", "deploy", SERVICE_NAME,
    `--project=${PROJECT_ID}`,
    `--image=${IMAGE}`,
    `--region=${REGION}`,
    "--no-allow-unauthenticated",
    "--no-cpu-throttling",   // CPU always allocated — the render runs in a BackgroundService
    "--min-instances=1",     // keep the poll/claim loop alive (no scale-to-zero)
    `--max-instances=${MAX_INSTANCES}`,
    "--cpu=4",
    "--memory=8Gi",
    "--timeout=3600",
    "--concurrency=1",
    `--service-account=${SERVICE_ACCOUNT}`,
  ];
  if (SECRET_NAME) {
    deployArgs.push(`--set-env-vars=${envEntries.join(",")}`);
    deployArgs.push(`--set-secrets=EXPORT_API_INTERNAL_SECRET=${SECRET_NAME}`);
  } else {
    // Custom delimiter '~' so a secret containing commas can't split the list.
    envEntries.push(`EXPORT_API_INTERNAL_SECRET=${SECRET}`);
    deployArgs.push(`--set-env-vars=^~^${envEntries.join("~")}`);
  }
  run(deployArgs, "Cloud Run deploy");

  // ── 3. Resolve the live URL ──
  const url = capture([
    "run", "services", "describe", SERVICE_NAME,
    `--project=${PROJECT_ID}`, `--region=${REGION}`,
    "--format=value(status.url)",
  ]);
  if (!url) bail("Deployed, but could not read the service URL back.");
  console.log(`\n✓ Deployed.\n    Image:   ${IMAGE}\n    URL:     ${url}`);

  if (process.env.SKIP_VERIFY === "1") {
    printManualChecks(url);
    return;
  }

  // ── 4. Verify: /health + a side-effect-free enqueue smoke ──
  await verify(url);
}

async function verify(url) {
  console.log("\n→ Verifying deployment…");
  // The service is private (--no-allow-unauthenticated) → every request (incl.
  // /health) needs a Cloud Run identity token whose audience is the service URL.
  const token = capture(["auth", "print-identity-token", `--audiences=${url}`], { allowFail: true });
  if (!token) {
    console.warn(
      "\n⚠ Couldn't mint an identity token (need run.invoker on the service +\n" +
        "  an account that can issue audience-scoped ID tokens). Deploy SUCCEEDED;\n" +
        "  run the manual checks below once IAM is set."
    );
    printManualChecks(url);
    return;
  }
  const authH = { Authorization: `Bearer ${token}` };

  // 4a. Health — must be 200 "ok".
  let healthOk = false;
  try {
    const r = await fetch(`${url}/health`, { headers: authH });
    const body = (await r.text()).trim();
    healthOk = r.status === 200 && body === "ok";
    console.log(`  ${healthOk ? "✔" : "✗"} GET /health → ${r.status} ${JSON.stringify(body)}`);
  } catch (e) {
    console.log(`  ✗ GET /health → ${e.message}`);
  }

  // 4b. Auth middleware — enqueue WITHOUT the secret must be 401.
  let authRejects = false;
  try {
    const r = await fetch(`${url}/exports/enqueue`, {
      method: "POST",
      headers: { ...authH, "Content-Type": "application/json" },
      body: JSON.stringify({ uid: SMOKE_UID }),
    });
    authRejects = r.status === 401;
    console.log(`  ${authRejects ? "✔" : "✗"} POST /exports/enqueue (no secret) → ${r.status} (expect 401)`);
  } catch (e) {
    console.log(`  ✗ POST /exports/enqueue (no secret) → ${e.message}`);
  }

  // 4c. Enqueue smoke WITH the secret — a free/nonexistent uid is gated at the
  // plan check (402) BEFORE any job is created or minutes reserved → no side
  // effect, but it exercises auth + Firestore read + the gate end to end.
  let smokeOk = false;
  if (SECRET) {
    try {
      const r = await fetch(`${url}/exports/enqueue`, {
        method: "POST",
        headers: { ...authH, "Content-Type": "application/json", "X-Internal-Secret": SECRET },
        body: JSON.stringify({
          uid: SMOKE_UID, projectId: "smoke", projectTitle: "smoke",
          sourceStoragePath: `users/${SMOKE_UID}/projects/smoke/original/none.mp4`,
          outputWidth: 1920, outputHeight: 1080, fps: 30, resolution: "1080p",
          durationSeconds: 1, serializedRecipe: {},
        }),
      });
      const body = await r.text();
      // Any STRUCTURED outcome proves the path: 402 (free→gate), 429 (no minutes),
      // 200 (paid uid → a job was created — only if SMOKE_UID is a real paid user).
      smokeOk = [200, 402, 429].includes(r.status);
      console.log(`  ${smokeOk ? "✔" : "✗"} POST /exports/enqueue (with secret, uid=${SMOKE_UID}) → ${r.status} ${body.slice(0, 200)}`);
      if (r.status === 200) console.warn("    ⚠ 200 means a real job was created — SMOKE_UID is a paid user with this source.");
    } catch (e) {
      console.log(`  ✗ POST /exports/enqueue (with secret) → ${e.message}`);
    }
  } else {
    console.log("  • Enqueue smoke skipped (secret is in Secret Manager, not available to the script). Manual command:");
    printManualChecks(url);
  }

  console.log("");
  if (healthOk && authRejects && (smokeOk || !SECRET)) {
    console.log("✓ Verification passed — the C# export API builds, deploys, starts, and responds on Cloud Run.");
  } else {
    bail("Verification FAILED — see the checks above. The service is deployed; fix and re-verify.");
  }
}

function printManualChecks(url) {
  console.log("\n  Manual verification (needs an identity token with run.invoker):");
  console.log(`    TOKEN=$(gcloud auth print-identity-token --audiences="${url}")`);
  console.log(`    curl -H "Authorization: Bearer $TOKEN" ${url}/health`);
  console.log(
    `    curl -X POST -H "Authorization: Bearer $TOKEN" -H "X-Internal-Secret: $EXPORT_API_INTERNAL_SECRET" \\\n` +
      `      -H "Content-Type: application/json" ${url}/exports/enqueue \\\n` +
      `      -d '{"uid":"${SMOKE_UID}","projectId":"smoke","projectTitle":"smoke",` +
      `"sourceStoragePath":"users/${SMOKE_UID}/projects/smoke/original/none.mp4",` +
      `"outputWidth":1920,"outputHeight":1080,"fps":30,"resolution":"1080p","durationSeconds":1,"serializedRecipe":{}}'`
  );
}

// ── helpers ──
function env(key, fallback) {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : fallback;
}

/** Short git sha (+ "-dirty" when the tree has uncommitted changes), "unknown" off-git. */
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
