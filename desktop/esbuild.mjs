/**
 * Bundles the three Node-side artifacts the desktop app ships:
 *
 *   .vite/main.js      — the Electron main process
 *   .vite/preload.js   — the sandboxed preload script (CJS, as Electron requires)
 *   .vite/render-cli.mjs — the SHARED render CLI from services/export-worker,
 *                         which is what makes desktop export pixel-identical to
 *                         the cloud. It is bundled here (rather than shipping
 *                         the whole service) so the installer carries one file.
 *
 * The `@` alias points at the app's own src/, exactly like the export worker's
 * build does — that is how main/preload import the IPC contract and the render
 * core without a copy.
 *
 * Native/binary packages stay EXTERNAL and are unpacked next to the asar (see
 * forge.config.ts): a .node addon cannot be executed from inside an archive.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { assertDesktopConfig, resolveDesktopConfig } from "./scripts/read-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const appSrc = resolve(repoRoot, "src");
const outDir = resolve(here, ".vite");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/**
 * Build-time configuration for ONE environment.
 *
 * esbuild reads no env files of its own, and the packaged app has no `.env` to
 * load at runtime — so anything main needs is substituted in HERE, from the
 * environment-specific files only (see scripts/read-env.mjs).
 *
 * `assertDesktopConfig` prints the resolved identifiers and FAILS THE BUILD if
 * the Firebase project and the OAuth client belong to different Google Cloud
 * projects. That pairing is invisible at build time otherwise, and its only
 * other symptom is `auth/invalid-credential` in front of a user.
 *
 * Both values baked in below are public: the client id appears in the
 * authorization URL the user's browser loads. The client SECRET is never read
 * here at all — it exists only on the server, in
 * src/app/api/auth/desktop/exchange. See docs/desktop/security.md.
 */
const config = assertDesktopConfig(resolveDesktopConfig(), "desktop:bundle");

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  alias: { "@": appSrc },
  sourcemap: false,
  logLevel: "info",
  define: {
    // Baked into the renderer-facing app info + the CSP connect-src.
    "process.env.NEXT_PUBLIC_CLOUD_API_BASE": JSON.stringify(config.apiBaseUrl),
    // Read by main/index.ts to broker the system-browser sign-in flow.
    "process.env.FRAMEVO_GOOGLE_DESKTOP_CLIENT_ID": JSON.stringify(config.googleClientId),
    // Reported at startup so a running app can say which project it is on.
    "process.env.FRAMEVO_ENV": JSON.stringify(config.environment),
    "process.env.FRAMEVO_FIREBASE_PROJECT_ID": JSON.stringify(config.firebaseProjectId),
  },
};

// Main + preload are CommonJS: Electron loads the preload with `require`, and
// keeping main CJS avoids ESM/`__dirname` friction in the packaged app.
await build({
  ...shared,
  entryPoints: [resolve(here, "src/main/index.ts")],
  outfile: resolve(outDir, "main.js"),
  format: "cjs",
  external: ["electron", "@napi-rs/canvas", "ffmpeg-static", "ffprobe-static"],
});

await build({
  ...shared,
  entryPoints: [resolve(here, "src/preload/index.ts")],
  outfile: resolve(outDir, "preload.js"),
  format: "cjs",
  external: ["electron"],
});

// The render CLI runs as its own Node process (ELECTRON_RUN_AS_NODE), so it is
// ESM like the worker's own build and keeps the same externals.
await build({
  ...shared,
  entryPoints: [resolve(repoRoot, "services/export-worker/src/cli.ts")],
  // .mjs, NOT .js: this package is "type": "commonjs" (Electron main needs
  // CJS), so a .js file would be loaded as CommonJS and the ESM bundle would
  // die with "Cannot use import statement outside a module".
  outfile: resolve(outDir, "render-cli.mjs"),
  format: "esm",
  banner: {
    js: "import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url); import { fileURLToPath as _f } from 'url'; import { dirname as _d } from 'path'; const __filename = _f(import.meta.url); const __dirname = _d(__filename);",
  },
  external: [
    // Native addon — must load from unpacked node_modules at runtime.
    "@napi-rs/canvas",
    // Cloud-only imports the desktop CLI path never reaches.
    "firebase-admin",
    "google-auth-library",
    "express",
  ],
  // ffmpeg-static / ffprobe-static are pure path helpers, so they are BUNDLED
  // (not external) — a packaged app has no node_modules for them to resolve
  // from. The path they compute is unused: FRAMEVO_FFMPEG_PATH points at the
  // binaries in resources/ffmpeg and takes precedence (see worker ffmpeg.ts).
});

// The migration SQL is read at runtime by the migration runner, so it travels
// alongside the bundles and is copied into `resources/migrations` at package time.
cpSync(resolve(here, "src/main/db/migrations"), resolve(outDir, "migrations"), {
  recursive: true,
  filter: (src) => !src.endsWith(".ts") && !src.includes(`${"meta"}`),
});

// The window icon is loaded from disk at runtime (BrowserWindow `icon`), so it
// travels with the bundles exactly as the migrations do. Without it here, a
// DEVELOPMENT run has no icon to load and the window falls back to Electron's
// own — which is precisely what it looks like when this step is forgotten.
for (const name of ["icon.ico", "icon.png"]) {
  cpSync(resolve(here, "assets", name), resolve(outDir, name));
}

console.log("desktop bundles written to .vite/");
