#!/usr/bin/env node
/**
 * Deploys Firestore + Storage security rules to either the dev or prod
 * Firebase project, using the Firebase Rules REST API. Bypasses the
 * need for `firebase login`.
 *
 * Usage:
 *   node scripts/deploy-rules.mjs --project=dev
 *   node scripts/deploy-rules.mjs --project=prod --yes
 *
 * Safety:
 *   - `--project=dev|prod` is REQUIRED.
 *   - Loads .env.local for dev, .env.production for prod.
 *   - Verifies the loaded NEXT_PUBLIC_FIREBASE_PROJECT_ID matches the
 *     expected project id (PROJECT_IDS map below). Mismatch → exit 1.
 *   - Prints which project + bucket it's about to write to. Prod
 *     requires `--yes` to skip the interactive confirmation prompt.
 *
 * The script writes ruleset releases via the Firebase Rules API:
 *   - cloud.firestore                  → firestore.rules
 *   - firebase.storage/<bucket>        → storage.rules
 *
 * Reads from the matching env file:
 *   - FIREBASE_SERVICE_ACCOUNT_B64  (base64 JSON of a service-account key
 *     scoped to the target project)
 *   - NEXT_PUBLIC_FIREBASE_PROJECT_ID
 *   - NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
 */

import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

// Hard-coded mapping — must match .firebaserc. If you rename a project,
// update both files in the same commit.
const PROJECT_IDS = {
  dev: "adzoomdev",
  prod: "adzoom-prod",
};

const ENV_FILES = {
  dev: ".env.local",
  prod: ".env.production",
};

const { project, yes } = parseArgs(process.argv.slice(2));

if (!project || !(project in PROJECT_IDS)) {
  bail(
    "Pass --project=dev or --project=prod. Example:\n" +
      "  node scripts/deploy-rules.mjs --project=dev"
  );
}

const expectedProjectId = PROJECT_IDS[project];
const envFile = ENV_FILES[project];

console.log(`\n→ Target Firebase project alias: ${project} (${expectedProjectId})`);
console.log(`  Loading env from: ${envFile}`);

loadDotEnv(path.join(root, envFile));

const loadedProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

if (!loadedProjectId) bail(`${envFile} is missing NEXT_PUBLIC_FIREBASE_PROJECT_ID`);
if (!b64) bail(`${envFile} is missing FIREBASE_SERVICE_ACCOUNT_B64`);

// ── Guard #1: env file MUST match the expected project. This is the
// gate that prevents accidentally deploying dev rules to prod (or vice
// versa) because the wrong env file was picked up.
if (loadedProjectId !== expectedProjectId) {
  bail(
    `Mismatch: --project=${project} expects "${expectedProjectId}" but ` +
      `${envFile} contains NEXT_PUBLIC_FIREBASE_PROJECT_ID="${loadedProjectId}".\n` +
      `Fix the env file or pick the right --project flag.`
  );
}

console.log(`  Project ID confirmed: ${loadedProjectId}`);
console.log(`  Storage bucket:        ${bucket ?? "(none — storage rules will be skipped)"}`);

// ── Guard #2: prod requires explicit confirmation. Either via --yes or
// via an interactive prompt that wants the exact project id typed back.
if (project === "prod" && !yes) {
  const typed = await prompt(
    `\n⚠  You are about to write rules to PRODUCTION (${expectedProjectId}).\n` +
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

// ── Guard #3: service account project_id must match too. Catches the
// case where the env file is correct but the SA key belongs to a
// different project.
if (credentials.project_id && credentials.project_id !== expectedProjectId) {
  bail(
    `Service-account key is for project "${credentials.project_id}" ` +
      `but --project=${project} expects "${expectedProjectId}".`
  );
}

const auth = new GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/firebase"],
});

const client = await auth.getClient();

async function api(method, url, body) {
  const res = await client.request({
    method,
    url,
    data: body,
    headers: { "content-type": "application/json" },
    validateStatus: () => true,
  });
  return res;
}

async function deployRules(release, rulesPath) {
  const source = readFileSync(rulesPath, "utf-8");
  console.log(`\n→ Deploying ${path.basename(rulesPath)} → release "${release}"`);

  const createRes = await api(
    "POST",
    `https://firebaserules.googleapis.com/v1/projects/${expectedProjectId}/rulesets`,
    {
      source: { files: [{ name: path.basename(rulesPath), content: source }] },
    }
  );
  if (createRes.status !== 200) {
    throw new Error(
      `Ruleset create failed (${createRes.status}): ${JSON.stringify(createRes.data)}`
    );
  }
  const rulesetName = createRes.data.name;
  console.log(`  · ruleset created: ${rulesetName.split("/").pop()}`);

  const releaseName = `projects/${expectedProjectId}/releases/${release}`;
  const patchRes = await api(
    "PATCH",
    `https://firebaserules.googleapis.com/v1/${releaseName}`,
    { release: { name: releaseName, rulesetName } }
  );

  if (patchRes.status === 200) {
    console.log(`  · release updated: ${release}`);
    return;
  }
  if (patchRes.status === 404) {
    const createRel = await api(
      "POST",
      `https://firebaserules.googleapis.com/v1/projects/${expectedProjectId}/releases`,
      { name: releaseName, rulesetName }
    );
    if (createRel.status !== 200) {
      throw new Error(
        `Release create failed (${createRel.status}): ${JSON.stringify(createRel.data)}`
      );
    }
    console.log(`  · release created: ${release}`);
    return;
  }
  throw new Error(
    `Release update failed (${patchRes.status}): ${JSON.stringify(patchRes.data)}`
  );
}

try {
  await deployRules("cloud.firestore", path.join(root, "firestore.rules"));
  if (bucket) {
    await deployRules(`firebase.storage/${bucket}`, path.join(root, "storage.rules"));
  } else {
    console.log("\n⚠ NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET not set, skipping storage rules");
  }
  console.log(`\n✓ All rules deployed to ${expectedProjectId}.`);
} catch (err) {
  console.error("\n✗", err.message);
  process.exitCode = 1;
}

// ── helpers ──────────────────────────────────────────────────────────

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
