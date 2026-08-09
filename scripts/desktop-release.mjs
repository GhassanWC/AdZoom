#!/usr/bin/env node
/**
 * Turn packaged artifacts into a release the website can serve.
 *
 *   node scripts/desktop-release.mjs [--publish] [--base-url <url>]
 *
 * What it does, in order:
 *
 *   1. Finds the artifacts `desktop:package` produced (Setup.exe, .nupkg,
 *      RELEASES on Windows; .dmg/.zip on macOS if a mac build ran).
 *   2. Computes the SHA-256 and exact byte size of each installer.
 *   3. Writes `checksums.txt` beside them, in `sha256sum` format so a user can
 *      verify with the tool their OS already has.
 *   4. Reads the newest section of desktop/RELEASE_NOTES.md.
 *   5. Rewrites src/lib/desktop/current-release.ts from all of the above.
 *
 * The generated manifest stays `status: "draft"` unless `--publish` is passed.
 * That is the safety interlock the brief asked for: the production download is
 * not replaced until someone has actually run the end-to-end checks and says so
 * — and because the website's desktop gate reads the same flag, a draft release
 * also means the website keeps working for everyone in the meantime.
 *
 * This script NEVER uploads. `desktop-upload-release.mjs` does that, and it
 * refuses to run against a manifest whose checksums don't match the files.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const DESKTOP_ROOT = join(REPO_ROOT, "desktop");
const MANIFEST_PATH = join(REPO_ROOT, "src", "lib", "desktop", "current-release.ts");
const NOTES_PATH = join(DESKTOP_ROOT, "RELEASE_NOTES.md");

/** Where the Windows maker leaves its output. */
const WIN_MAKE_DIR = join(DESKTOP_ROOT, "out", "make", "squirrel.windows");
/** Where a macOS build would leave its .dmg / .zip. */
const MAC_MAKE_DIR = join(DESKTOP_ROOT, "out", "make");

const args = process.argv.slice(2);
const publish = args.includes("--publish");
const baseUrlArg = args[args.indexOf("--base-url") + 1];
const BASE_URL = (
  args.includes("--base-url") ? baseUrlArg : process.env.FRAMEVO_RELEASE_BASE_URL
)?.replace(/\/+$/, "");

const pkg = JSON.parse(readFileSync(join(DESKTOP_ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;

function log(msg) {
  console.log(`[desktop-release] ${msg}`);
}

function fail(msg) {
  console.error(`[desktop-release] ${msg}`);
  process.exit(1);
}

function sha256(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/** Every installer we can find, with the platform/arch it belongs to. */
function findArtifacts() {
  const found = [];

  // Windows: out/make/squirrel.windows/<arch>/Framevo-Setup.exe
  if (existsSync(WIN_MAKE_DIR)) {
    for (const arch of readdirSync(WIN_MAKE_DIR)) {
      const dir = join(WIN_MAKE_DIR, arch);
      if (!statSync(dir).isDirectory()) continue;
      const setup = readdirSync(dir).find((f) => /Setup\.exe$/i.test(f));
      if (setup) {
        found.push({
          platform: "windows",
          arch: arch === "arm64" ? "arm64" : "x64",
          path: join(dir, setup),
          minimumOs: "Windows 10 (64-bit) or later",
        });
      }
    }
  }

  // macOS: a .dmg (preferred) or the maker's .zip, anywhere under out/make.
  if (existsSync(MAC_MAKE_DIR)) {
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (entry !== "squirrel.windows") walk(full);
          continue;
        }
        if (/\.dmg$/i.test(entry) || /darwin.*\.zip$/i.test(entry)) {
          found.push({
            platform: "macos",
            // A universal binary is the recommended shape — browsers cannot
            // reliably tell Apple Silicon from Intel (see platform-detect.ts).
            arch: /arm64/i.test(entry) ? "arm64" : /x64|intel/i.test(entry) ? "x64" : "universal",
            path: full,
            minimumOs: "macOS 12 Monterey or later",
          });
        }
      }
    };
    walk(MAC_MAKE_DIR);
  }

  return found;
}

/** The newest `## <version>` section of RELEASE_NOTES.md, as bullet strings. */
function readNotes() {
  if (!existsSync(NOTES_PATH)) return [];
  const lines = readFileSync(NOTES_PATH, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith("## "));
  if (start === -1) return [];
  const heading = lines[start].replace(/^##\s*/, "").trim();
  if (heading !== VERSION) {
    console.warn(
      `[desktop-release] RELEASE_NOTES.md's newest section is "${heading}" but ` +
        `package.json says ${VERSION}. Using it anyway — check that's intended.`
    );
  }
  const notes = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) notes.push(line.slice(2).trim());
  }
  return notes;
}

function manifestSource({ assets, notes, updateFeedUrl }) {
  const body = {
    version: VERSION,
    channel: "stable",
    status: publish ? "published" : "draft",
    releasedAt: new Date().toISOString().slice(0, 10),
    notes,
    assets,
    updateFeedUrl,
  };
  // Drop undefined-valued keys (JSON.stringify already does) and keep the
  // literal at column 0 so the generated file reads like hand-written source
  // rather than pasted output.
  const json = JSON.stringify(body, null, 2);

  return `/**
 * THE CURRENT RELEASE — generated by scripts/desktop-release.mjs.
 *
 * Do not edit the checksums or sizes by hand: they describe the exact files the
 * release script hashed, and a number that drifts from the artifact behind it
 * is worse than no checksum at all. Re-run the script instead.
 *
 * \`status\` is the one field a human changes, and only by re-running with
 * \`--publish\` once the packaged app has passed end-to-end verification.
 * Publishing turns on the public download AND the website's desktop gate in the
 * same edit — see src/lib/desktop/release.ts for why those are coupled.
 */
import type { DesktopRelease } from "./release";

export const CURRENT_RELEASE: DesktopRelease = ${json};
`;
}

async function main() {
  const artifacts = findArtifacts();
  if (artifacts.length === 0) {
    fail(
      "no installers found. Run `npm run desktop:package` (Windows) or the mac " +
        "maker first — this script only describes artifacts, it never builds them."
    );
  }

  const assets = [];
  const checksumLines = [];
  for (const artifact of artifacts) {
    const digest = await sha256(artifact.path);
    const size = statSync(artifact.path).size;
    const filename = basename(artifact.path);
    log(`${filename}  ${(size / 1_000_000).toFixed(1)} MB  ${digest.slice(0, 16)}…`);
    checksumLines.push(`${digest}  ${filename}`);
    assets.push({
      platform: artifact.platform,
      arch: artifact.arch,
      // Without a base URL the manifest still records everything else, so the
      // hashes are captured at build time and only the location is pending.
      url: BASE_URL
        ? `${BASE_URL}/${VERSION}/${filename}`
        : `REPLACE_ME/${VERSION}/${filename}`,
      filename,
      sizeBytes: size,
      sha256: digest,
      minimumOs: artifact.minimumOs,
    });
  }

  const checksumFile = join(DESKTOP_ROOT, "out", "checksums.txt");
  writeFileSync(checksumFile, `${checksumLines.join("\n")}\n`, "utf8");
  log(`checksums → ${checksumFile}`);

  const notes = readNotes();
  if (notes.length === 0) {
    console.warn("[desktop-release] no release notes found — /download will show none.");
  }

  const updateFeedUrl = BASE_URL ? `${BASE_URL}/stable` : undefined;
  writeFileSync(MANIFEST_PATH, manifestSource({ assets, notes, updateFeedUrl }), "utf8");
  log(`manifest → ${MANIFEST_PATH}`);

  if (!BASE_URL) {
    console.warn(
      "[desktop-release] no --base-url given: asset URLs are placeholders. " +
        "Re-run with --base-url, or let desktop-upload-release.mjs fill them in."
    );
  }
  log(
    publish
      ? "status = PUBLISHED — the website will serve this build and the desktop gate goes live."
      : "status = draft — the website is unchanged until you re-run with --publish."
  );
}

main().catch((err) => fail(err?.stack ?? String(err)));
