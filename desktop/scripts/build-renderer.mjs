/**
 * Build the desktop renderer (a static Next export of the shared UI).
 *
 * `next build` is run from desktop/renderer with `output: "export"`, producing
 * `renderer/out/` — plain HTML/JS/CSS the Electron protocol handler serves. No
 * server is involved at build time or at run time.
 *
 * NEXT_PUBLIC_CLOUD_API_BASE is baked in here: it is the origin the packaged
 * app calls for the features that must stay server-side (AI analysis, captions,
 * billing). Unset ⇒ those features report "unavailable" instead of silently
 * calling a URL that cannot exist inside the app.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { assertDesktopConfig, resolveDesktopConfig } from "./read-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, "../renderer");
const outDir = join(rendererRoot, "out");

/**
 * Public config for ONE environment, read from the REPO ROOT (see ./read-env.mjs).
 *
 * Next loads `.env*` relative to the app being built, and the app being built
 * is desktop/renderer — where those files do not live. Without this the desktop
 * bundle shipped with no `NEXT_PUBLIC_FIREBASE_*` at all, so it could not sign
 * anyone in, and every account-backed screen was dead on arrival.
 *
 * Only `NEXT_PUBLIC_*` is forwarded. Anything else in those files is a SERVER
 * secret (Firebase Admin, Gemini, Lemon Squeezy, the OAuth client secret) and
 * must never reach a client bundle — see docs/desktop/security.md.
 *
 * The same assertion the main bundle runs applies here, so BOTH halves of a
 * build agree on which Firebase project they are for, and a mismatched OAuth
 * client stops the build rather than a user's sign-in.
 */
const config = assertDesktopConfig(resolveDesktopConfig(), "desktop:renderer");
const publicEnv = config.publicEnv;
const apiBase = config.apiBaseUrl;

rmSync(outDir, { recursive: true, force: true });

// `npx next build` (not a local bin path) so this works from a fresh clone
// where next resolves from the repo root's node_modules.
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const env = {
  ...process.env,
  ...publicEnv,
  NEXT_PUBLIC_CLOUD_API_BASE: apiBase,
  // The desktop app renders locally; the browser/cloud engines stay dark so
  // the export panel offers exactly one path (see RealExportPanel).
  NEXT_PUBLIC_EDITFRAME_EXPORT_ENABLED: "false",
  NEXT_PUBLIC_CLOUD_EXPORT_ENABLED: "false",
};

function runBuild() {
  return spawnSync(npx, ["next", "build"], {
    cwd: rendererRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env,
  });
}

let result = runBuild();
if (result.status !== 0) {
  // Windows (especially under OneDrive) intermittently holds a lock on a file
  // in .next/static, which Turbopack reports as EPERM on unlink. Clearing the
  // build cache and retrying once turns a spurious failure into a slow build
  // instead of a broken one.
  console.warn("[desktop:renderer] build failed — clearing .next and retrying once");
  rmSync(join(rendererRoot, ".next"), { recursive: true, force: true });
  result = runBuild();
}

if (result.status !== 0) {
  console.error("[desktop:renderer] next build failed");
  process.exit(result.status ?? 1);
}
if (!existsSync(join(outDir, "index.html"))) {
  console.error("[desktop:renderer] build produced no out/index.html");
  process.exit(1);
}

/**
 * Stamp the export with the environment it was built for.
 *
 * The main bundle is a SEPARATE build with its own baked OAuth client. Each
 * validates itself, so a stale renderer paired with a fresh main passes both
 * checks and fails at sign-in with `auth/invalid-credential` — which names two
 * project numbers and neither artifact. Main reads this file at startup and can
 * then say which half is stale (see src/main/build-identity.ts).
 *
 * Public identifiers only: the same project id, project number and origin that
 * are already compiled into the JavaScript sitting beside it.
 */
writeFileSync(
  join(outDir, "framevo-build.json"),
  `${JSON.stringify(
    {
      environment: config.environment,
      firebaseProjectId: config.firebaseProjectId,
      messagingSenderId: config.messagingSenderId,
      apiBaseUrl: apiBase,
    },
    null,
    2
  )}\n`
);

console.log(
  `[desktop:renderer] static renderer ready at renderer/out (${config.environment}, ` +
    `${config.firebaseProjectId || "no firebase project"})`
);
