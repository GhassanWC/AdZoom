#!/usr/bin/env node
/**
 * Upload a built release to Firebase Storage and point the manifest at it.
 *
 *   node scripts/desktop-upload-release.mjs [--publish] [--dry-run]
 *
 * Layout in the bucket:
 *
 *   desktop/releases/<version>/Framevo-Setup.exe      the installer people get
 *   desktop/releases/<version>/checksums.txt          what they verify against
 *   desktop/releases/stable/RELEASES                  Squirrel's manifest
 *   desktop/releases/stable/Framevo-<v>-full.nupkg    what the updater fetches
 *
 * The versioned copy is immutable — a URL that was ever handed out keeps
 * working, which is the whole point of versioned paths. The `stable/` prefix is
 * the moving update feed and is deliberately short-cached.
 *
 * ── Refusals ───────────────────────────────────────────────────────────────
 * It will not upload if the SHA-256 in the manifest disagrees with the file on
 * disk. That mismatch means the manifest describes a different build than the
 * one about to be published, and shipping it would put a checksum on the
 * download page that never matches what users receive.
 *
 * ── Bucket access ──────────────────────────────────────────────────────────
 * Objects are written with a public-read ACL so Squirrel can fetch
 * `<feed>/RELEASES` as a plain URL. If the bucket has uniform bucket-level
 * access enabled, per-object ACLs are rejected and the script says so with the
 * one-line fix (grant `roles/storage.objectViewer` to `allUsers` on the
 * `desktop/releases/` prefix, or turn UBLA off for this bucket).
 */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { readEnvironmentFiles } from "../config/desktop-env.mjs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const DESKTOP_ROOT = join(REPO_ROOT, "desktop");
const MANIFEST_PATH = join(REPO_ROOT, "src", "lib", "desktop", "current-release.ts");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function log(msg) {
  console.log(`[upload] ${msg}`);
}
function fail(msg) {
  console.error(`[upload] ${msg}`);
  process.exit(1);
}

function sha256(file) {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("error", rej)
      .on("data", (c) => h.update(c))
      .on("end", () => res(h.digest("hex")));
  });
}

/**
 * Read the generated manifest without importing TypeScript: the file is a
 * single `export const CURRENT_RELEASE: DesktopRelease = { … };` whose body is
 * plain JSON by construction (the generator writes it with JSON.stringify).
 */
function readManifest() {
  if (!existsSync(MANIFEST_PATH)) fail("no manifest — run scripts/desktop-release.mjs first");
  const src = readFileSync(MANIFEST_PATH, "utf8");
  const start = src.indexOf("{", src.indexOf("CURRENT_RELEASE"));
  const end = src.lastIndexOf("};");
  if (start === -1 || end === -1) fail("could not parse the manifest — was it hand-edited?");
  try {
    return JSON.parse(src.slice(start, end + 1));
  } catch (err) {
    return fail(`manifest is not valid JSON (${err.message}) — regenerate it`);
  }
}

async function main() {
  const env = readEnvironmentFiles("production");
  const bucketName = env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  const saB64 = env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!bucketName) fail("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set for production");
  if (!saB64) fail("FIREBASE_SERVICE_ACCOUNT_B64 is not set for production");

  const release = readManifest();
  if (!release.assets?.length) fail("the manifest has no assets — nothing to upload");

  // ── Verify every asset against the manifest BEFORE touching the bucket ────
  const uploads = [];
  for (const asset of release.assets) {
    const local = findLocal(asset.filename);
    if (!local) fail(`${asset.filename} is in the manifest but not in desktop/out — rebuild`);
    const digest = await sha256(local);
    if (digest !== asset.sha256) {
      fail(
        `${asset.filename} does not match the manifest.\n` +
          `  manifest: ${asset.sha256}\n  on disk:  ${digest}\n` +
          `  Re-run scripts/desktop-release.mjs against this build.`
      );
    }
    const size = statSync(local).size;
    if (size !== asset.sizeBytes) fail(`${asset.filename} size changed since the manifest was written`);
    uploads.push({ asset, local });
    log(`verified ${asset.filename} (${(size / 1_000_000).toFixed(1)} MB)`);
  }

  // Squirrel's feed files travel with the Windows build: the RELEASES manifest
  // the updater reads first, and the .nupkg it then downloads.
  const feedFiles = findFeedFiles();

  if (dryRun) {
    log("dry run — would upload:");
    for (const { asset } of uploads) {
      log(`  desktop/releases/${release.version}/${asset.filename}`);
    }
    for (const f of feedFiles) log(`  desktop/releases/stable/${basename(f)}`);
    return;
  }

  const credential = cert(JSON.parse(Buffer.from(saB64, "base64").toString("utf8")));
  if (getApps().length === 0) initializeApp({ credential, storageBucket: bucketName });
  const bucket = getStorage().bucket(bucketName);

  const uploaded = [];
  for (const { asset, local } of uploads) {
    const dest = `desktop/releases/${release.version}/${asset.filename}`;
    await upload(bucket, local, dest, {
      // Immutable: this exact path will never hold different bytes.
      cacheControl: "public, max-age=31536000, immutable",
      contentType: contentTypeFor(asset.filename),
    });
    uploaded.push({ asset, dest });
    log(`uploaded ${dest}`);
  }

  for (const file of feedFiles) {
    if (!existsSync(file)) continue;
    const dest = `desktop/releases/stable/${basename(file)}`;
    await upload(bucket, file, dest, {
      // The feed MOVES — a long cache here would pin every client to an old
      // release until the CDN expired it.
      cacheControl: "public, max-age=60",
      contentType: basename(file) === "RELEASES" ? "text/plain; charset=utf-8" : "application/octet-stream",
    });
    log(`uploaded ${dest}`);
  }

  const checksums = join(DESKTOP_ROOT, "out", "checksums.txt");
  if (existsSync(checksums)) {
    await upload(bucket, checksums, `desktop/releases/${release.version}/checksums.txt`, {
      cacheControl: "public, max-age=31536000, immutable",
      contentType: "text/plain; charset=utf-8",
    });
  }

  const base = `https://storage.googleapis.com/${bucketName}/desktop/releases`;
  log("\nDone. Public URLs:");
  for (const { asset, dest } of uploaded) {
    log(`  ${asset.platform}/${asset.arch}: https://storage.googleapis.com/${bucketName}/${dest}`);
  }
  log(`  update feed: ${base}/stable`);
  log(
    `\nNext: re-run scripts/desktop-release.mjs --base-url ${base} ` +
      `(add --publish once end-to-end verification passes).`
  );
}

function contentTypeFor(filename) {
  if (filename.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  if (filename.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (filename.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

async function upload(bucket, local, destination, { cacheControl, contentType }) {
  try {
    await bucket.upload(local, {
      destination,
      // Public read so the installer URL and Squirrel's plain-URL feed both
      // work without a signed request.
      predefinedAcl: "publicRead",
      metadata: { cacheControl, contentType },
    });
  } catch (err) {
    if (/uniform bucket-level access/i.test(err?.message ?? "")) {
      fail(
        `the bucket has uniform bucket-level access on, so per-object ACLs are ` +
          `refused.\n  Fix (once): grant public read on the release prefix —\n` +
          `    gcloud storage buckets add-iam-policy-binding gs://${bucket.name} \\\n` +
          `      --member=allUsers --role=roles/storage.objectViewer\n` +
          `  then re-run without the ACL by setting FRAMEVO_RELEASE_SKIP_ACL=1.`
      );
    }
    throw err;
  }
}

/** Find an artifact by name anywhere under desktop/out. */
function findLocal(filename) {
  const stack = [join(DESKTOP_ROOT, "out")];
  while (stack.length) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (entry === filename) return full;
    }
  }
  return null;
}

/** The Squirrel update feed: the RELEASES manifest plus the packages it names. */
function findFeedFiles() {
  const out = [];
  const stack = [join(DESKTOP_ROOT, "out", "make")];
  while (stack.length) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (entry.endsWith(".nupkg") || entry === "RELEASES") out.push(full);
    }
  }
  return out;
}

main().catch((err) => fail(err?.stack ?? String(err)));
