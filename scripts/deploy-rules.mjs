#!/usr/bin/env node
/**
 * Deploys Firestore and Storage security rules using the Firebase Rules REST API.
 *
 * Reads credentials from .env.local:
 *   - FIREBASE_SERVICE_ACCOUNT_B64  (base64 JSON of a service-account key)
 *   - NEXT_PUBLIC_FIREBASE_PROJECT_ID
 *   - NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
 *
 * This is a one-shot equivalent of:
 *   firebase deploy --only firestore:rules,storage:rules
 *
 * It bypasses the need for `firebase login`.
 */

import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

loadDotEnv(path.join(root, ".env.local"));

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

if (!projectId) bail("NEXT_PUBLIC_FIREBASE_PROJECT_ID not set");
if (!b64) bail("FIREBASE_SERVICE_ACCOUNT_B64 not set in .env.local");

let credentials;
try {
  credentials = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
} catch (err) {
  bail(`Could not parse FIREBASE_SERVICE_ACCOUNT_B64 as base64 JSON: ${err.message}`);
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

  // 1. Create a new ruleset
  const createRes = await api(
    "POST",
    `https://firebaserules.googleapis.com/v1/projects/${projectId}/rulesets`,
    {
      source: { files: [{ name: path.basename(rulesPath), content: source }] },
    }
  );
  if (createRes.status !== 200) {
    throw new Error(
      `Ruleset create failed (${createRes.status}): ${JSON.stringify(createRes.data)}`
    );
  }
  const rulesetName = createRes.data.name; // e.g. "projects/<pid>/rulesets/<id>"
  console.log(`  · ruleset created: ${rulesetName.split("/").pop()}`);

  // 2. Attempt to update the existing release; if it doesn't exist, create it.
  // Body format matches firebase-tools: { release: { name, rulesetName } }
  const releaseName = `projects/${projectId}/releases/${release}`;
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
      `https://firebaserules.googleapis.com/v1/projects/${projectId}/releases`,
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
  console.log("\n✓ All rules deployed.");
} catch (err) {
  console.error("\n✗", err.message);
  process.exitCode = 1;
}

function bail(msg) {
  console.error("✗", msg);
  process.exit(1);
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
