/**
 * Where FFmpeg and FFprobe live — the one answer for dev AND for the packaged
 * app.
 *
 * Resolution order (first hit wins):
 *   1. FRAMEVO_FFMPEG_PATH / FRAMEVO_FFPROBE_PATH   — explicit override.
 *   2. <resourcesDir>/ffmpeg/…                      — packaged layout, where the
 *      binaries are copied by forge.config.ts (executables cannot run from
 *      inside app.asar).
 *   3. <nodeModulesDir>/{ffmpeg,ffprobe}-static/…   — development.
 *
 * The layout in (3) is computed rather than `require()`d on purpose: this module
 * is loaded as CommonJS inside the bundled main process and as an ES module by
 * the test runner, and a bare `require` silently returns nothing in the latter —
 * which would look exactly like "FFmpeg is missing".
 *
 * The SAME environment variables are read by the render subprocess (see
 * services/export-worker/src/ffmpeg.ts), so the child never has to guess.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
  /** Which strategy produced the paths (diagnostics). */
  source: "override" | "packaged" | "node_modules" | "missing";
}

export interface ResolveFfmpegOptions {
  /** `process.resourcesPath` in a packaged app. */
  resourcesDir?: string;
  /** Directory containing ffmpeg-static / ffprobe-static (development). */
  nodeModulesDir?: string;
}

const exe = (name: string): string => (process.platform === "win32" ? `${name}.exe` : name);

/** The on-disk layout the two static packages publish. */
function staticPaths(nodeModulesDir: string): { ffmpeg: string; ffprobe: string } {
  return {
    ffmpeg: join(nodeModulesDir, "ffmpeg-static", exe("ffmpeg")),
    ffprobe: join(
      nodeModulesDir,
      "ffprobe-static",
      "bin",
      process.platform,
      process.arch,
      exe("ffprobe")
    ),
  };
}

export function resolveFfmpegPaths(options: ResolveFfmpegOptions = {}): FfmpegPaths {
  const envFfmpeg = process.env.FRAMEVO_FFMPEG_PATH;
  const envFfprobe = process.env.FRAMEVO_FFPROBE_PATH;
  if (envFfmpeg && envFfprobe && existsSync(envFfmpeg) && existsSync(envFfprobe)) {
    return { ffmpeg: envFfmpeg, ffprobe: envFfprobe, source: "override" };
  }

  if (options.resourcesDir) {
    const dir = join(options.resourcesDir, "ffmpeg");
    const ffmpeg = join(dir, exe("ffmpeg"));
    const ffprobe = join(dir, exe("ffprobe"));
    if (existsSync(ffmpeg) && existsSync(ffprobe)) {
      return { ffmpeg, ffprobe, source: "packaged" };
    }
  }

  if (options.nodeModulesDir) {
    const dev = staticPaths(options.nodeModulesDir);
    if (existsSync(dev.ffmpeg) && existsSync(dev.ffprobe)) {
      return { ...dev, source: "node_modules" };
    }
  }

  return { ffmpeg: "", ffprobe: "", source: "missing" };
}

/** Human-readable failure for the UI when no binary could be found. */
export const FFMPEG_MISSING_MESSAGE =
  "The bundled video engine (FFmpeg) is missing from this installation. Reinstall Framevo, or set FRAMEVO_FFMPEG_PATH and FRAMEVO_FFPROBE_PATH.";
