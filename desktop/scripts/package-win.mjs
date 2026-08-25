/**
 * Windows packaging that assembles the app from the ALREADY-EXTRACTED Electron
 * runtime in node_modules, instead of re-extracting the Electron release zip.
 *
 * Why this exists: `electron-forge package` always unzips a fresh copy of the
 * Electron release, and on some Windows setups (this repo's included) that
 * extraction stalls inside Node — the zip's central directory reads fine, then
 * the first decompressed entry never completes. Everything else about packaging
 * works, so this script does the same job through file copies, which do work:
 *
 *   1. build the bundles + the static renderer (npm run build)
 *   2. stage resources/ (shared with the Forge config — see stage-resources.mjs)
 *   3. copy node_modules/electron/dist   → out/Framevo-win32-x64
 *   4. pack app.asar (main + preload + the native canvas addon, unpacked)
 *   5. rename electron.exe → Framevo.exe and stamp its version resources
 *   6. hand the directory to electron-winstaller for the Setup .exe
 *
 * `npm run make` (Forge) remains the primary, canonical path — see
 * docs/desktop/packaging.md. This produces the same layout.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DESKTOP_ROOT, STAGING_DIR, stageResources } from "./stage-resources.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const APP_NAME = "Framevo";
const OUT_DIR = join(DESKTOP_ROOT, "out");
const PACKAGE_DIR = join(OUT_DIR, `${APP_NAME}-win32-${process.arch}`);
const pkg = require("../package.json");

function log(step) {
  console.log(`[package:win] ${step}`);
}

/**
 * Packaging is PRODUCTION, stated outright rather than inferred.
 *
 * `NODE_ENV` is not a reliable signal here — npm does not set it, and the
 * `next build` child sets its own — so the intent is declared once and passed
 * down to every build step. A packaged app can then never be assembled from
 * development Firebase credentials or a development OAuth client.
 *
 * `FRAMEVO_ENV` may still be overridden deliberately (e.g. to package a
 * staging build); it just cannot be arrived at by accident.
 */
const BUILD_ENV = {
  ...process.env,
  FRAMEVO_ENV: process.env.FRAMEVO_ENV ?? "production",
};

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    cwd: DESKTOP_ROOT,
    shell: process.platform === "win32",
    env: BUILD_ENV,
    ...options,
  });
}

if (process.platform !== "win32") {
  console.error("[package:win] this script builds the Windows package; run it on Windows.");
  process.exit(1);
}

// ── 1. Build ────────────────────────────────────────────────────────────────
if (!process.env.FRAMEVO_SKIP_BUILD) {
  log(`building for FRAMEVO_ENV=${BUILD_ENV.FRAMEVO_ENV}`);
  run("node", [join(here, "..", "esbuild.mjs")]);
  log("building the static renderer");
  run("node", [join(here, "build-renderer.mjs")]);
}

// ── 2. Stage resources ──────────────────────────────────────────────────────
log("staging resources");
stageResources();

// ── 3. Copy the Electron runtime ────────────────────────────────────────────
const electronDist = join(DESKTOP_ROOT, "node_modules", "electron", "dist");
if (!existsSync(join(electronDist, "electron.exe"))) {
  console.error("[package:win] node_modules/electron/dist is missing — run `npm install` first.");
  process.exit(1);
}
log(`copying the Electron ${pkg.devDependencies.electron.replace(/[^\d.]/g, "")} runtime`);
rmSync(PACKAGE_DIR, { recursive: true, force: true });
mkdirSync(PACKAGE_DIR, { recursive: true });
cpSync(electronDist, PACKAGE_DIR, { recursive: true });

// Electron's stock "no app loaded" placeholder must not ship.
rmSync(join(PACKAGE_DIR, "resources", "default_app.asar"), { force: true });

// ── 4. Pack app.asar ────────────────────────────────────────────────────────
// Only the app manifest and the two esbuild bundles go inside the archive.
// Everything else the app needs at runtime — the renderer, FFmpeg, the render
// CLI and its native canvas addon — is staged into resources/.
log("packing app.asar");
const asarSrc = join(DESKTOP_ROOT, ".asar-src");
rmSync(asarSrc, { recursive: true, force: true });
mkdirSync(join(asarSrc, ".vite"), { recursive: true });
writeFileSync(
  join(asarSrc, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      productName: APP_NAME,
      version: pkg.version,
      description: pkg.description,
      author: pkg.author,
      main: ".vite/main.js",
    },
    null,
    2
  )
);
cpSync(join(DESKTOP_ROOT, ".vite", "main.js"), join(asarSrc, ".vite", "main.js"));
cpSync(join(DESKTOP_ROOT, ".vite", "preload.js"), join(asarSrc, ".vite", "preload.js"));

// @napi-rs/canvas is NOT in here — see stage-resources.mjs for why it lives in
// resources/node_modules instead.
const asar = require("@electron/asar");
await asar.createPackageWithOptions(asarSrc, join(PACKAGE_DIR, "resources", "app.asar"), {});
rmSync(asarSrc, { recursive: true, force: true });

// ── 5. Resources + executable identity ──────────────────────────────────────
log("copying staged resources");
for (const entry of readdirSync(STAGING_DIR)) {
  cpSync(join(STAGING_DIR, entry), join(PACKAGE_DIR, "resources", entry), { recursive: true });
}

log("stamping the executable");
renameSync(join(PACKAGE_DIR, "electron.exe"), join(PACKAGE_DIR, `${APP_NAME}.exe`));

const rcedit = join(DESKTOP_ROOT, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");
if (existsSync(rcedit)) {
  // THE taskbar icon of an installed app: Windows reads it from the exe's own
  // resource table, not from anything the app does at runtime. It must be the
  // 256px-capable `assets/icon.ico` — the website's favicon stops at 48px, and
  // Windows would upscale it for every large-icon surface there is.
  const icon = resolve(DESKTOP_ROOT, "assets", "icon.ico");
  const args = [
    join(PACKAGE_DIR, `${APP_NAME}.exe`),
    "--set-version-string", "CompanyName", "Framevo",
    "--set-version-string", "FileDescription", "Framevo video editor",
    "--set-version-string", "ProductName", APP_NAME,
    "--set-version-string", "InternalName", APP_NAME,
    "--set-version-string", "OriginalFilename", `${APP_NAME}.exe`,
    "--set-file-version", pkg.version,
    "--set-product-version", pkg.version,
  ];
  if (existsSync(icon)) args.push("--set-icon", icon);
  // rcedit is an ANSI-path tool: it cannot open a file whose path contains
  // non-ASCII characters (this repo lives under a localised OneDrive folder).
  // Stamp a copy in a plain temp path and move it back.
  const scratch = mkdtempSync(join(tmpdir(), "framevo-rcedit-"));
  const scratchExe = join(scratch, `${APP_NAME}.exe`);
  const scratchIcon = join(scratch, "app.ico");
  try {
    cpSync(join(PACKAGE_DIR, `${APP_NAME}.exe`), scratchExe);
    if (existsSync(icon)) cpSync(icon, scratchIcon);
    args[0] = scratchExe;
    const iconIndex = args.indexOf("--set-icon");
    if (iconIndex !== -1) args[iconIndex + 1] = scratchIcon;
    // NOT through a shell: the arguments contain spaces, and a shell would
    // re-split them (rcedit then reports "Unable to load file").
    execFileSync(rcedit, args, { stdio: "pipe" });
    cpSync(scratchExe, join(PACKAGE_DIR, `${APP_NAME}.exe`));
  } catch (err) {
    // Non-fatal: the app runs either way, it just keeps Electron's metadata.
    console.warn(
      `[package:win] could not stamp the executable (${(err.stderr ?? err.message ?? "").toString().trim()})`
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
} else {
  console.warn("[package:win] rcedit not found — the executable keeps Electron's metadata");
}

log(`packaged app → ${PACKAGE_DIR}`);

// ── 6. Installer ────────────────────────────────────────────────────────────
if (process.env.FRAMEVO_SKIP_INSTALLER) {
  log("skipping the installer (FRAMEVO_SKIP_INSTALLER)");
  process.exit(0);
}

log("building the Squirrel installer (this takes a few minutes)");
const winstaller = require("electron-winstaller");
const makeDir = join(OUT_DIR, "make", "squirrel.windows", process.arch);
mkdirSync(makeDir, { recursive: true });

/**
 * Squirrel stamps version resources onto the finished Setup.exe with rcedit,
 * which is an ANSI-path tool: it cannot open a file whose path contains
 * non-ASCII characters. This repo lives under a localised OneDrive folder, so
 * the whole installer build runs in a plain ASCII temp directory and the
 * artifacts are copied back afterwards. Costs one directory copy; removes an
 * entire class of "works on my machine".
 */
const buildRoot = mkdtempSync(join(tmpdir(), "framevo-installer-"));
const buildAppDir = join(buildRoot, "app");
const buildOutDir = join(buildRoot, "out");
log("staging the installer build in a temporary ASCII path");
cpSync(PACKAGE_DIR, buildAppDir, { recursive: true });
mkdirSync(buildOutDir, { recursive: true });

await winstaller.createWindowsInstaller({
  appDirectory: buildAppDir,
  outputDirectory: buildOutDir,
  authors: "Framevo",
  exe: `${APP_NAME}.exe`,
  name: APP_NAME,
  title: APP_NAME,
  version: pkg.version,
  setupExe: `${APP_NAME}-Setup.exe`,
  noMsi: true,
  description: "Framevo — import, edit and export video locally.",
  // Code signing is opt-in via the environment; unset ⇒ an unsigned build that
  // still installs (with a SmartScreen warning). See docs/desktop/code-signing.md.
  ...(process.env.WINDOWS_CERTIFICATE_FILE
    ? {
        certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
        certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
      }
    : {}),
});

// Copy the release artifacts (Setup.exe, the .nupkg and RELEASES — the updater
// needs all three) back into out/make and drop the temp build.
for (const entry of readdirSync(buildOutDir)) {
  cpSync(join(buildOutDir, entry), join(makeDir, entry), { recursive: true });
}
rmSync(buildRoot, { recursive: true, force: true });

// electron-winstaller names its output Setup.exe; give it the product name.
const producedSetup = join(makeDir, "Setup.exe");
const finalSetup = join(makeDir, `${APP_NAME}-Setup.exe`);
if (existsSync(producedSetup)) {
  rmSync(finalSetup, { force: true });
  renameSync(producedSetup, finalSetup);
}

// VERIFY before declaring victory. createWindowsInstaller has failure modes
// that resolve without producing an installer, and this script used to log
// "installer → …" unconditionally — leaving an empty out/make behind a
// success-looking build log, which then reads as "the installer is broken"
// one download attempt later. Missing artifact ⇒ loud non-zero exit, here.
if (!existsSync(finalSetup)) {
  console.error(
    `[package:win] FAILED: the installer build completed without producing ${finalSetup}`
  );
  process.exit(1);
}
log(`installer → ${finalSetup}`);
