#!/usr/bin/env node
/**
 * Applies CORS configuration to the Firebase Storage bucket for either
 * the dev or prod project. Replaces gsutil — uses the Google Cloud
 * Storage JSON API directly (PATCH /storage/v1/b/<bucket>).
 *
 * Usage:
 *   node scripts/deploy-cors.mjs --project=dev
 *   node scripts/deploy-cors.mjs --project=prod --yes
 *
 * Source of truth for the rules: cors.json at the repo root.
 * Both dev and prod read the same file. If you need different origins
 * per environment, split into cors.dev.json / cors.prod.json and update
 * CORS_FILE_BY_PROJECT below.
 *
 * Safety:
 *   - `--project=dev|prod` is REQUIRED. Same three guards as
 *     deploy-rules.mjs (CLI flag vs env file vs service-account
 *     project_id all must agree).
 *   - Prod requires either `--yes` or typing the project id back at
 *     an interactive prompt.
 *   - After PATCH, a verification GET reads the bucket back and the
 *     script exits non-zero unless the live config matches what we
 *     sent (defensive — catches partial writes / proxy munging).
 */

import { readFileSync, existsSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

// Must match .firebaserc + deploy-rules.mjs + firebase-active.mjs.
const PROJECT_IDS = {
  dev: "adzoomdev",
  prod: "adzoom-prod",
};

const ENV_FILES = {
  dev: ".env.local",
  prod: ".env.production",
};

// If per-environment CORS files become necessary, change these values.
const CORS_FILE_BY_PROJECT = {
  dev: "cors.json",
  prod: "cors.json",
};

const { project, yes } = parseArgs(process.argv.slice(2));

if (!project || !(project in PROJECT_IDS)) {
  bail(
    "Pass --project=dev or --project=prod. Example:\n" +
      "  node scripts/deploy-cors.mjs --project=dev"
  );
}

const expectedProjectId = PROJECT_IDS[project];
const envFile = ENV_FILES[project];
const corsFile = CORS_FILE_BY_PROJECT[project];

console.log(`\n→ Target Firebase project alias: ${project} (${expectedProjectId})`);
console.log(`  Loading env from: ${envFile}`);
console.log(`  CORS source:      ${corsFile}`);

loadDotEnv(path.join(root, envFile));

const loadedProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

if (!loadedProjectId) bail(`${envFile} is missing NEXT_PUBLIC_FIREBASE_PROJECT_ID`);
if (!bucket) bail(`${envFile} is missing NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`);
if (!b64) bail(`${envFile} is missing FIREBASE_SERVICE_ACCOUNT_B64`);

// ── Guard #1: env file must match the expected project.
if (loadedProjectId !== expectedProjectId) {
  bail(
    `Mismatch: --project=${project} expects "${expectedProjectId}" but ` +
      `${envFile} contains NEXT_PUBLIC_FIREBASE_PROJECT_ID="${loadedProjectId}".`
  );
}

console.log(`  Project ID confirmed: ${loadedProjectId}`);
console.log(`  Bucket:               gs://${bucket}`);

// ── Guard #2: prod requires explicit consent.
if (project === "prod" && !yes) {
  const typed = await prompt(
    `\n⚠  You are about to overwrite CORS on PRODUCTION bucket gs://${bucket}.\n` +
      `   Type the project id to confirm, or anything else to abort: `
  );
  if (typed.trim() !== expectedProjectId) {
    bail("Aborted — confirmation text did not match.");
  }
}

let credentials;
try {
  credentials = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
} catch (err) {
  bail(`Could not parse FIREBASE_SERVICE_ACCOUNT_B64 as base64 JSON: ${err.message}`);
}

// ── Guard #3: SA key project_id must match too.
if (credentials.project_id && credentials.project_id !== expectedProjectId) {
  bail(
    `Service-account key is for project "${credentials.project_id}" ` +
      `but --project=${project} expects "${expectedProjectId}".`
  );
}

// ── Load + sanity-check cors.json.
const corsPath = path.join(root, corsFile);
if (!existsSync(corsPath)) bail(`${corsFile} not found at repo root`);
let corsPolicy;
try {
  corsPolicy = JSON.parse(readFileSync(corsPath, "utf-8"));
} catch (err) {
  bail(`${corsFile} is not valid JSON: ${err.message}`);
}
if (!Array.isArray(corsPolicy)) {
  bail(`${corsFile} must be a JSON ARRAY of CORS rules (got ${typeof corsPolicy})`);
}
for (const [i, rule] of corsPolicy.entries()) {
  if (!rule || typeof rule !== "object") {
    bail(`${corsFile} entry #${i} is not an object`);
  }
  if (!Array.isArray(rule.origin) || rule.origin.length === 0) {
    bail(`${corsFile} entry #${i} is missing a non-empty "origin" array`);
  }
  if (!Array.isArray(rule.method) || rule.method.length === 0) {
    bail(`${corsFile} entry #${i} is missing a non-empty "method" array`);
  }
}

console.log(`\n→ Parsed ${corsPolicy.length} CORS rule${corsPolicy.length === 1 ? "" : "s"} from ${corsFile}:`);
for (const [i, rule] of corsPolicy.entries()) {
  console.log(`  [${i}] origin=${JSON.stringify(rule.origin)}`);
  console.log(`      method=${JSON.stringify(rule.method)}`);
  if (rule.responseHeader) console.log(`      responseHeader=${JSON.stringify(rule.responseHeader)}`);
  if (rule.maxAgeSeconds !== undefined) console.log(`      maxAgeSeconds=${rule.maxAgeSeconds}`);
}

// ── Auth.
const auth = new GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/devstorage.full_control"],
});
const client = await auth.getClient();

async function api(method, url, body) {
  return client.request({
    method,
    url,
    data: body,
    headers: { "content-type": "application/json" },
    validateStatus: () => true,
  });
}

const bucketUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`;

// ── PATCH the bucket's CORS config.
console.log(`\n→ PATCH ${bucketUrl}?fields=cors`);
const patchRes = await api("PATCH", `${bucketUrl}?fields=cors`, { cors: corsPolicy });
if (patchRes.status !== 200) {
  console.error(`\n✗ PATCH failed (${patchRes.status}):`);
  console.error(JSON.stringify(patchRes.data, null, 2));
  process.exit(1);
}
console.log(`  · response status: ${patchRes.status}`);

// ── Verification GET.
console.log(`\n→ GET  ${bucketUrl}?fields=cors`);
const getRes = await api("GET", `${bucketUrl}?fields=cors`);
if (getRes.status !== 200) {
  console.error(`\n✗ Verification GET failed (${getRes.status}):`);
  console.error(JSON.stringify(getRes.data, null, 2));
  process.exit(1);
}
const liveCors = getRes.data?.cors ?? [];
console.log(`  · response status: ${getRes.status}`);

console.log(`\n→ Live CORS on gs://${bucket}:`);
console.log(JSON.stringify(liveCors, null, 2));

// ── Deep-equal check between what we sent and what GCS returned.
const ok = corsEqual(corsPolicy, liveCors);
if (!ok) {
  console.error("\n✗ Verification mismatch — what GCS returned does not match cors.json.");
  console.error("  Sent:");
  console.error(JSON.stringify(corsPolicy, null, 2));
  console.error("  Got:");
  console.error(JSON.stringify(liveCors, null, 2));
  process.exit(1);
}

console.log(`\n✓ CORS applied to gs://${bucket} (${expectedProjectId}) and verified.`);

// ── helpers ──────────────────────────────────────────────────────────

function corsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i];
    const rb = b[i];
    if (!arraysEqualUnordered(ra.origin, rb.origin)) return false;
    if (!arraysEqualUnordered(ra.method, rb.method)) return false;
    // responseHeader is optional on either side — treat undefined === [].
    if (!arraysEqualUnordered(ra.responseHeader ?? [], rb.responseHeader ?? [])) return false;
    const ma = ra.maxAgeSeconds ?? 0;
    const mb = rb.maxAgeSeconds ?? 0;
    if (ma !== mb) return false;
  }
  return true;
}

function arraysEqualUnordered(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function parseArgs(argv) {
  const out = { project: null, yes: false };
  for (const a of argv) {
    if (a.startsWith("--project=")) out.project = a.slice("--project=".length);
    else if (a === "--yes" || a === "-y") out.yes = true;
  }
  return out;
}

function bail(msg) {
  console.error("✗", msg);
  process.exit(1);
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function loadDotEnv(file) {
  let content;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return;
  }
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
