import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

/**
 * Packaging.
 *
 * Everything the app needs at runtime that CANNOT live inside `app.asar` —
 * executables, native addons, and the statically exported renderer — is staged
 * into `.resources/` by the `prePackage` hook below and copied to
 * `resources/…` by the packager:
 *
 *   resources/app/          the Next static export (served by framevo://app)
 *   resources/ffmpeg/       ffmpeg + ffprobe (executables can't run from asar)
 *   resources/render-cli.mjs the shared render core, run as a child process
 *   resources/migrations/   the SQL the library database applies on first run
 *
 * Windows is the target today; the structure is deliberately platform-neutral
 * (the mac maker is listed and the ffmpeg staging picks per-platform binaries),
 * so adding macOS is a signing/notarisation config change, not a rewrite.
 */
const here = __dirname;
const staging = resolve(here, ".resources");

// ONE staging implementation, shared with scripts/package-win.mjs — the two
// packaging paths must produce identical resources/ trees.
const require = createRequire(__filename);
const { stageResources } = require("./scripts/stage-resources.mjs") as {
  stageResources: () => string;
};

/**
 * What actually goes INSIDE app.asar.
 *
 * By default the packager copies the whole project directory — which here means
 * the renderer's Next cache, the Playwright artifacts, the TypeScript sources
 * and, worst of all, `node_modules/electron` (a second ~500 MB copy of Electron
 * itself). That is gigabytes of pointless I/O.
 *
 * The runtime needs exactly three things: the app manifest, the two bundles
 * esbuild produced, and the @napi-rs/canvas native addon. Everything else the
 * app uses at runtime is staged into `resources/` instead (see stageResources).
 */
const ASAR_KEEP = ["/package.json", "/.vite/main.js", "/.vite/preload.js"];

function shouldIgnore(relativePath: string): boolean {
  if (!relativePath) return false; // the app root itself
  return !ASAR_KEEP.some(
    (keep) =>
      keep === relativePath ||
      // an ancestor directory of something we keep (so it gets traversed)
      keep.startsWith(`${relativePath}/`) ||
      // a file inside something we keep
      relativePath.startsWith(`${keep}/`)
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    name: "Framevo",
    ignore: shouldIgnore,
    executableName: process.platform === "win32" ? "Framevo" : "framevo",
    appBundleId: "com.framevo.desktop",
    appCategoryType: "public.app-category.video",
    // Nothing inside the archive needs unpacking: the only native dependency
    // (@napi-rs/canvas) is staged into resources/ — see stage-resources.mjs.
    asar: true,
    // Forge appends the per-platform extension (.ico on Windows, .icns on mac).
    // `assets/icon.ico` carries every size Windows asks for, up to 256 — it is
    // generated from the brand artwork by `npm run make:icon`. (macOS will need
    // an .icns beside it; Forge picks the right extension on its own.)
    icon: resolve(here, "assets/icon"),
    extraResource: [
      join(staging, "app"),
      join(staging, "ffmpeg"),
      join(staging, "render-cli.mjs"),
      join(staging, "migrations"),
      join(staging, "node_modules"),
      // Read at runtime for the WINDOW icon. Distinct from `icon` above, which
      // is compiled into the executable for the shell to use.
      join(staging, "icon.ico"),
      join(staging, "icon.png"),
    ],
    // Windows code signing is opt-in via the environment; unset ⇒ an unsigned
    // build, which still installs (with a SmartScreen warning). See
    // docs/desktop/code-signing.md.
    ...(process.env.WINDOWS_CERTIFICATE_FILE
      ? {
          windowsSign: {
            certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
            certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
            timestampServer: "http://timestamp.digicert.com",
          },
        }
      : {}),
    // macOS notarisation, also environment-gated (no-op on Windows builds).
    ...(process.env.APPLE_ID && process.env.APPLE_ID_PASSWORD
      ? {
          osxNotarize: {
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_ID_PASSWORD,
            teamId: process.env.APPLE_TEAM_ID ?? "",
          },
        }
      : {}),
  },

  rebuildConfig: {},

  makers: [
    // Windows: a Setup .exe (Squirrel) — the format the built-in autoUpdater
    // consumes, so shipping updates later needs no new machinery.
    new MakerSquirrel({
      name: "Framevo",
      setupExe: "Framevo-Setup.exe",
      noMsi: true,
      ...(process.env.WINDOWS_CERTIFICATE_FILE
        ? {
            certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
            certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
          }
        : {}),
    }),
    // macOS/Linux archive — the mac maker is here so the config is ready; the
    // build itself must run on the target platform.
    new MakerZIP({}, ["darwin", "linux"]),
  ],

  plugins: [
    // Chromium/Electron hardening flags burned into the binary.
    new FusesPlugin({
      version: FuseVersion.V1,
      // Disable the "run as Node" fuse? NO — the render child process depends
      // on it (ELECTRON_RUN_AS_NODE). Every OTHER escape hatch is closed.
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],

  hooks: {
    prePackage: async () => {
      stageResources();
    },
  },

  // Publishing is deliberately absent: releases are cut explicitly (see
  // docs/desktop/releases.md), and the updater only ever contacts a feed when
  // FRAMEVO_UPDATE_FEED_URL is configured.
};

export default config;
