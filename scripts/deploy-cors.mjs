#!/usr/bin/env node
/**
 * Applies CORS to the Firebase Storage bucket so the browser can play
 * uploaded videos (via <video crossOrigin="anonymous">) and the canvas
 * export pipeline can draw frames without tainting.
 *
 * Reads .env.local:
 *   - FIREBASE_SERVICE_ACCOUNT_B64
 *   - NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
 *
 * One-shot equivalent of:
 *   gcloud storage buckets update gs://<bucket> --cors-file=cors.json
 */

import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

loadDotEnv(path.join(root, ".env.local"));

const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

if (!bucket) bail("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET not set");
if (!b64) bail("FIREBASE_SERVICE_ACCOUNT_B64 not set in .env.local");

const credentials = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));

const auth = new GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/devstorage.full_control"],
});
const client = await auth.getClient();

// CORS policy: allow GET/HEAD/OPTIONS from any origin so videos play in dev + prod.
// (For maximum-security setups, narrow `origin` to your domain list.)
const corsPolicy = [
  {
    origin: ["*"],
    method: ["GET", "HEAD", "OPTIONS"],
    responseHeader: [
      "Content-Type",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "ETag",
      "Authorization",
      "Range",
      "x-goog-meta-firebaseStorageDownloadTokens",
    ],
    maxAgeSeconds: 3600,
  },
];

console.log(`→ Applying CORS to bucket gs://${bucket}`);

const res = await client.request({
  method: "PATCH",
  url: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`,
  data: { cors: corsPolicy },
  headers: { "content-type": "application/json" },
  validateStatus: () => true,
});

if (res.status !== 200) {
  console.error(`✗ CORS update failed (${res.status})`);
  console.error(JSON.stringify(res.data, null, 2));
  process.exit(1);
}

console.log("✓ CORS applied:");
console.log(JSON.stringify(res.data.cors, null, 2));

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
