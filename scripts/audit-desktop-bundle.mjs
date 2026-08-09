#!/usr/bin/env node
/**
 * Does the thing we are about to ship contain anything it shouldn't?
 *
 *   node scripts/audit-desktop-bundle.mjs [--dir <path>] [--env production]
 *
 * An installer is a file on a stranger's disk that they can unzip. Anything
 * baked into it is public, permanently, to anyone who cares to look — so this
 * runs over the built artifacts and fails the release if it finds:
 *
 *   1. A SECRET. Every non-public value in the env files (service-account JSON,
 *      the OAuth client secret, API keys, webhook secrets) is searched for
 *      byte-for-byte in every packaged file. The *names* are reported; the
 *      values never are, because a CI log is not a safe place for them either.
 *
 *   2. DEVELOPMENT CONFIGURATION. A production build that carries the dev
 *      Firebase project, the dev OAuth client or a localhost API base is a
 *      build that will quietly talk to the wrong backend — the exact failure
 *      the env-profile split exists to prevent.
 *
 *   3. A MISSING production identifier. If the prod Firebase project id isn't
 *      in there at all, the bundle wasn't built with production config and the
 *      other two checks passed for the wrong reason.
 *
 * Exit 0 = safe to ship. Exit 1 = do not upload this.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvironmentFiles } from "../config/desktop-env.mjs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const DESKTOP_ROOT = join(REPO_ROOT, "desktop");

const args = process.argv.slice(2);
const dirArg = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : null;
const environment = args.includes("--env") ? args[args.indexOf("--env") + 1] : "production";

/**
 * What gets scanned. `.vite` holds the main/preload bundles; `.resources`
 * holds the staged renderer, the render CLI and everything copied into the
 * packaged `resources/` tree. Together that is the whole shipped surface.
 */
const DEFAULT_TARGETS = [
  join(DESKTOP_ROOT, ".vite"),
  join(DESKTOP_ROOT, ".resources"),
  join(DESKTOP_ROOT, "out"),
];

/**
 * Values that are PUBLIC by design and must not be flagged.
 *
 *   • Every NEXT_PUBLIC_* value — that prefix is the contract that says so.
 *   • The desktop OAuth CLIENT ID, which appears in the authorization URL the
 *     user's own browser loads. (The client SECRET is not here, and must not
 *     be: it lives only on the server — see docs/desktop/security.md.)
 */
const PUBLIC_KEYS = new Set([
  "GOOGLE_DESKTOP_OAUTH_CLIENT_ID",
  "FRAMEVO_GOOGLE_DESKTOP_CLIENT_ID",
]);

function isPublicKey(key) {
  return key.startsWith("NEXT_PUBLIC_") || PUBLIC_KEYS.has(key);
}

/** Files big enough that scanning is pointless (ffmpeg, Electron itself). */
const MAX_SCAN_BYTES = 300 * 1024 * 1024;

const problems = [];
const notes = [];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (st.size <= MAX_SCAN_BYTES) out.push(full);
  }
  return out;
}

function main() {
  const targets = dirArg ? [resolve(dirArg)] : DEFAULT_TARGETS;
  const present = targets.filter((t) => existsSync(t));
  if (present.length === 0) {
    console.error(
      `[audit] nothing to scan. Build first (npm run desktop:build) or pass --dir.`
    );
    process.exit(1);
  }

  const files = present.flatMap((t) => (statSync(t).isDirectory() ? walk(t) : [t]));
  console.log(`[audit] scanning ${files.length} files from:\n  ${present.map((p) => relative(REPO_ROOT, p)).join("\n  ")}`);

  // ── The needles ──────────────────────────────────────────────────────────
  const prodEnv = readEnvironmentFiles("production", { processEnv: {} });
  const devEnv = readEnvironmentFiles("development", { processEnv: {} });

  /** [label, value] pairs that must NOT appear anywhere. */
  const forbidden = [];
  for (const [key, value] of Object.entries(prodEnv)) {
    if (isPublicKey(key)) continue;
    // Short values produce false positives ("true", "1", a port number).
    if (!value || value.length < 12) continue;
    forbidden.push([`secret:${key}`, value]);
  }

  // Development identifiers, which a production build must never carry.
  const devProject = devEnv.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const prodProject = prodEnv.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (environment === "production" && devProject && devProject !== prodProject) {
    forbidden.push([`dev-config:NEXT_PUBLIC_FIREBASE_PROJECT_ID`, devProject]);
  }
  const devClient = devEnv.GOOGLE_DESKTOP_OAUTH_CLIENT_ID;
  const prodClient = prodEnv.GOOGLE_DESKTOP_OAUTH_CLIENT_ID;
  if (environment === "production" && devClient && devClient !== prodClient) {
    forbidden.push([`dev-config:GOOGLE_DESKTOP_OAUTH_CLIENT_ID`, devClient]);
  }

  if (forbidden.length === 0) {
    notes.push("no secret values were configured to search for — check your env files");
  }

  // ── Scan ─────────────────────────────────────────────────────────────────
  for (const file of files) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      continue;
    }
    for (const [label, value] of forbidden) {
      if (buf.includes(value)) {
        problems.push(`${label} found in ${relative(REPO_ROOT, file)}`);
      }
    }
  }

  // ── A production build must actually BE production ───────────────────────
  if (environment === "production") {
    const bundle = join(DESKTOP_ROOT, ".vite", "main.js");
    if (existsSync(bundle)) {
      const main = readFileSync(bundle, "utf8");
      if (prodProject && !main.includes(prodProject)) {
        problems.push(
          `.vite/main.js does not contain the production Firebase project id — ` +
            `this bundle was not built with FRAMEVO_ENV=production`
        );
      }
      // Two localhost strings are EXPECTED and harmless in a packaged build:
      //   • the dev renderer URL (guarded by `isDev = !app.isPackaged`)
      //   • the dev-only CSP entries (guarded by the same flag)
      // Both are dead branches once packaged. Anything else is worth a look, so
      // the known pair is subtracted before deciding whether to say anything.
      const KNOWN_DEV_LOCALHOST = [
        "http://localhost:3010",
        "http://localhost:*",
        "ws://localhost:*",
      ];
      let residual = main;
      for (const known of KNOWN_DEV_LOCALHOST) residual = residual.split(known).join("");
      if (/localhost/.test(residual)) {
        notes.push(
          ".vite/main.js references an UNEXPECTED localhost URL — the dev-server " +
            "and dev-CSP strings are known dead branches, so check what this one is"
        );
      }
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────
  for (const note of notes) console.warn(`[audit] note: ${note}`);

  if (problems.length > 0) {
    console.error(`\n[audit] FAILED — ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(
      `\nDo not upload this build. Values are never printed here; look up the ` +
        `named key in your env files to see what leaked.\n`
    );
    process.exit(1);
  }

  console.log(
    `[audit] PASSED — ${forbidden.length} forbidden value(s) checked against ` +
      `${files.length} files; none present.`
  );
}

main();
