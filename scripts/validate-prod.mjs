#!/usr/bin/env node
/**
 * End-to-end Phase 1 validation for PROD.
 *
 *   1. Loads .env.production.
 *   2. Confirms every required env key is present + non-empty.
 *      Reports keys as "ok" / "missing" / "empty" — NEVER prints values.
 *   3. Decodes FIREBASE_SERVICE_ACCOUNT_B64 and confirms the JSON has
 *      project_id === "adzoom-prod" and client_email present.
 *      The private key is parsed but never printed.
 *   4. Initializes the Firebase Admin SDK against the decoded SA.
 *   5. Calls db.listCollections() — a benign read that proves
 *      credentials work AND Firestore is enabled on the prod project.
 *
 * Exit codes:
 *   0  every check passed
 *   1  any check failed (the report shows which one)
 *
 * Read-only. No writes to prod. No deploys. Run as:
 *
 *     node scripts/validate-prod.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const EXPECTED_PROJECT_ID = "adzoom-prod";
const ENV_FILE = ".env.production";

const REQUIRED_KEYS = [
  // Public Firebase config — embedded in client bundle
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
  // Server-only — Admin SDK + Gemini + Lemon Squeezy
  "FIREBASE_SERVICE_ACCOUNT_B64",
  "GEMINI_API_KEY",
  "LEMONSQUEEZY_API_KEY",
  "LEMONSQUEEZY_STORE_ID",
  "LEMONSQUEEZY_WEBHOOK_SECRET",
  "LEMONSQUEEZY_PRO_VARIANT_ID",
  "LEMONSQUEEZY_CREATOR_VARIANT_ID",
];

const results = {
  envFilePresent: false,
  keyStatus: /** @type {Record<string, "ok" | "missing" | "empty">} */ ({}),
  serviceAccountValid: false,
  serviceAccountProjectId: null,
  adminInitOk: false,
  firestoreReachable: false,
  firestoreCollections: null,
  errors: [],
};

// ── Step 1: load .env.production ─────────────────────────────────────
const envPath = path.join(root, ENV_FILE);
if (!existsSync(envPath)) {
  results.errors.push(`${ENV_FILE} does not exist`);
  printReport();
  process.exit(1);
}
results.envFilePresent = true;
loadDotEnv(envPath);

// ── Step 2: required-key presence ────────────────────────────────────
for (const key of REQUIRED_KEYS) {
  const raw = process.env[key];
  if (raw === undefined) results.keyStatus[key] = "missing";
  else if (raw.trim() === "") results.keyStatus[key] = "empty";
  else results.keyStatus[key] = "ok";
}

const allKeysOk = Object.values(results.keyStatus).every((s) => s === "ok");

// Cross-check: the loaded env MUST be the prod project.
const loadedProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
if (loadedProjectId !== EXPECTED_PROJECT_ID) {
  results.errors.push(
    `${ENV_FILE} NEXT_PUBLIC_FIREBASE_PROJECT_ID is "${loadedProjectId}", expected "${EXPECTED_PROJECT_ID}"`
  );
}

// ── Step 3: decode service-account B64 ───────────────────────────────
let credentials = null;
if (results.keyStatus.FIREBASE_SERVICE_ACCOUNT_B64 === "ok") {
  try {
    const decoded = Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_B64,
      "base64"
    ).toString("utf-8");
    credentials = JSON.parse(decoded);
    results.serviceAccountProjectId = credentials.project_id ?? null;
    if (!credentials.client_email) {
      results.errors.push("Service-account JSON has no client_email");
    } else if (!credentials.private_key) {
      results.errors.push("Service-account JSON has no private_key");
    } else if (credentials.project_id !== EXPECTED_PROJECT_ID) {
      results.errors.push(
        `Service-account project_id is "${credentials.project_id}", expected "${EXPECTED_PROJECT_ID}"`
      );
    } else {
      results.serviceAccountValid = true;
    }
  } catch (err) {
    results.errors.push(
      `FIREBASE_SERVICE_ACCOUNT_B64 decode/parse failed: ${err.message}`
    );
  }
}

// ── Steps 4+5: Admin SDK init + Firestore ping ───────────────────────
if (results.serviceAccountValid) {
  try {
    if (getApps().length === 0) {
      initializeApp({
        credential: cert({
          projectId: credentials.project_id,
          clientEmail: credentials.client_email,
          privateKey: credentials.private_key,
        }),
        projectId: credentials.project_id,
        storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      });
    }
    results.adminInitOk = true;

    // Benign Firestore read — listCollections at the root. Free op,
    // bypasses security rules (admin), confirms Firestore is enabled
    // on prod.
    const db = getFirestore();
    const cols = await db.listCollections();
    results.firestoreReachable = true;
    results.firestoreCollections = cols.map((c) => c.id);
  } catch (err) {
    results.errors.push(`Admin/Firestore: ${err.message}`);
  }
}

printReport();

const passed =
  results.envFilePresent &&
  allKeysOk &&
  results.serviceAccountValid &&
  results.adminInitOk &&
  results.firestoreReachable &&
  results.errors.length === 0;

process.exit(passed ? 0 : 1);

// ── helpers ──────────────────────────────────────────────────────────

function printReport() {
  console.log("\n┌─────────────────────────────────────────────────────────────┐");
  console.log("│ AdZoom — Phase 1 PROD validation                             │");
  console.log("└─────────────────────────────────────────────────────────────┘\n");

  console.log(`Env file (${ENV_FILE})    : ${results.envFilePresent ? "✓ present" : "✗ missing"}`);
  console.log(`Loaded NEXT_PUBLIC_FIREBASE_PROJECT_ID: ${loadedProjectIdSafe()}\n`);

  console.log("Required env keys:");
  for (const key of REQUIRED_KEYS) {
    const status = results.keyStatus[key] ?? "missing";
    const icon = status === "ok" ? "✓" : "✗";
    console.log(`  ${icon} ${key.padEnd(40)} ${status}`);
  }

  console.log("\nService account:");
  console.log(`  ${results.serviceAccountValid ? "✓" : "✗"} JSON decodes`);
  console.log(`  project_id in SA key: ${results.serviceAccountProjectId ?? "(none)"} (expected ${EXPECTED_PROJECT_ID})`);

  console.log("\nFirebase Admin SDK:");
  console.log(`  ${results.adminInitOk ? "✓" : "✗"} initializeApp OK`);
  console.log(`  ${results.firestoreReachable ? "✓" : "✗"} Firestore listCollections OK`);
  if (results.firestoreCollections !== null) {
    if (results.firestoreCollections.length === 0) {
      console.log("  (empty database — no top-level collections yet)");
    } else {
      console.log(`  top-level collections: ${results.firestoreCollections.join(", ")}`);
    }
  }

  if (results.errors.length > 0) {
    console.log("\nErrors:");
    for (const e of results.errors) console.log(`  ✗ ${e}`);
  }
}

function loadedProjectIdSafe() {
  const v = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!v) return "(unset)";
  return v;
}

function loadDotEnv(file) {
  const content = readFileSync(file, "utf-8");
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
