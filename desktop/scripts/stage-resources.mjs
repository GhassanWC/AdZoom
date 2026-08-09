/**
 * Stage everything that must live OUTSIDE app.asar into `.resources/`.
 *
 * One definition, two consumers: Electron Forge's `prePackage` hook and the
 * direct Windows packaging script. Keeping it here is what stops the two paths
 * from producing subtly different installers.
 *
 *   .resources/app/            the Next static export (served by framevo://app)
 *   .resources/ffmpeg/         ffmpeg + ffprobe (+ licence) — executables
 *   .resources/render-cli.mjs  the shared render core, run as a child process
 *   .resources/migrations/     SQL the library database applies on first run
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
export const DESKTOP_ROOT = resolve(here, "..");
export const STAGING_DIR = join(DESKTOP_ROOT, ".resources");

const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);

export function stageResources() {
  rmSync(STAGING_DIR, { recursive: true, force: true });
  mkdirSync(STAGING_DIR, { recursive: true });

  // 1. The renderer (built by `npm run build:renderer`).
  const rendererOut = join(DESKTOP_ROOT, "renderer", "out");
  if (!existsSync(join(rendererOut, "index.html"))) {
    throw new Error(
      "renderer/out/index.html is missing — run `npm run build:renderer` before packaging."
    );
  }
  cpSync(rendererOut, join(STAGING_DIR, "app"), { recursive: true });

  // 2. FFmpeg + FFprobe, resolved from the static packages at BUILD time. The
  //    packaged app finds them via resources/ffmpeg (see main/ffmpeg-paths.ts).
  //    Swapping in an LGPL build means replacing these two files — see
  //    docs/desktop/ffmpeg-licensing.md.
  const ffmpegSource = require("ffmpeg-static");
  const ffprobeSource = require("ffprobe-static").path;
  const ffmpegDir = join(STAGING_DIR, "ffmpeg");
  mkdirSync(ffmpegDir, { recursive: true });
  cpSync(ffmpegSource, join(ffmpegDir, exe("ffmpeg")));
  cpSync(ffprobeSource, join(ffmpegDir, exe("ffprobe")));
  // The FFmpeg licence travels with the binary — a GPL build MUST ship it.
  const licence = join(DESKTOP_ROOT, "node_modules", "ffmpeg-static", "LICENSE");
  if (existsSync(licence)) cpSync(licence, join(ffmpegDir, "FFMPEG-LICENSE.txt"));

  // 3. The render CLI + migrations produced by esbuild.mjs.
  const viteOut = join(DESKTOP_ROOT, ".vite");
  if (!existsSync(join(viteOut, "render-cli.mjs"))) {
    throw new Error("`.vite/render-cli.mjs` is missing — run `npm run build:bundle` first.");
  }
  cpSync(join(viteOut, "render-cli.mjs"), join(STAGING_DIR, "render-cli.mjs"));
  cpSync(join(viteOut, "migrations"), join(STAGING_DIR, "migrations"), { recursive: true });
  // The window icon, read from disk at runtime. On Windows the TASKBAR icon
  // comes from the exe's own resource table instead (the packager stamps it),
  // but the window still asks for this one — and on Linux it is the only icon
  // there is.
  for (const name of ["icon.ico", "icon.png"]) {
    cpSync(join(viteOut, name), join(STAGING_DIR, name));
  }

  // 4. @napi-rs/canvas — the ONLY runtime native dependency. It sits NEXT TO
  //    render-cli.mjs (resources/node_modules/…) rather than inside app.asar,
  //    for two reasons: a .node addon cannot be loaded from an archive, and the
  //    render subprocess resolves `require("@napi-rs/canvas")` by walking up
  //    from its own location — which, in an installed app, is resources/.
  cpSync(
    join(DESKTOP_ROOT, "node_modules", "@napi-rs"),
    join(STAGING_DIR, "node_modules", "@napi-rs"),
    { recursive: true }
  );

  return STAGING_DIR;
}
