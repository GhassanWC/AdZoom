/**
 * FFmpeg resolution + hardware encoder detection.
 *
 * These two decide whether an export can run at all, and (on a machine with a
 * GPU) whether it takes 40 seconds or 4 minutes. The detection test runs the
 * REAL probe against the REAL bundled binary — the whole point of the design is
 * that "the encoder is compiled in" and "the encoder works here" are different
 * questions, and only an actual trial encode answers the second one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The desktop package's own node_modules — where the static binaries live. */
const NODE_MODULES = resolve(fileURLToPath(import.meta.url), "../../node_modules");

import { resolveFfmpegPaths } from "../src/main/ffmpeg-paths.ts";
import {
  detectEncoders,
  encoderArgs,
  parseEncoderList,
  pickEncoder,
  resetEncoderCache,
} from "../src/main/export/encoders.ts";

test("ffmpeg resolves from the bundled packages in development", () => {
  const paths = resolveFfmpegPaths({ nodeModulesDir: NODE_MODULES });
  assert.equal(paths.source, "node_modules");
  assert.ok(existsSync(paths.ffmpeg), "ffmpeg binary exists");
  assert.ok(existsSync(paths.ffprobe), "ffprobe binary exists");
});

test("a packaged resources/ffmpeg directory wins over node_modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "framevo-res-"));
  try {
    const ffmpegDir = join(dir, "ffmpeg");
    const exe = process.platform === "win32" ? ".exe" : "";
    mkdirSync(ffmpegDir, { recursive: true });
    writeFileSync(join(ffmpegDir, `ffmpeg${exe}`), "");
    writeFileSync(join(ffmpegDir, `ffprobe${exe}`), "");

    const paths = resolveFfmpegPaths({ resourcesDir: dir, nodeModulesDir: NODE_MODULES });
    assert.equal(paths.source, "packaged");
    assert.ok(paths.ffmpeg.startsWith(ffmpegDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit override beats everything (how the render subprocess is told)", () => {
  const real = resolveFfmpegPaths({ nodeModulesDir: NODE_MODULES });
  const prevFfmpeg = process.env.FRAMEVO_FFMPEG_PATH;
  const prevFfprobe = process.env.FRAMEVO_FFPROBE_PATH;
  try {
    process.env.FRAMEVO_FFMPEG_PATH = real.ffmpeg;
    process.env.FRAMEVO_FFPROBE_PATH = real.ffprobe;
    const paths = resolveFfmpegPaths({ resourcesDir: "/nonexistent/resources", nodeModulesDir: NODE_MODULES });
    assert.equal(paths.source, "override");
    assert.equal(paths.ffmpeg, real.ffmpeg);
  } finally {
    if (prevFfmpeg === undefined) delete process.env.FRAMEVO_FFMPEG_PATH;
    else process.env.FRAMEVO_FFMPEG_PATH = prevFfmpeg;
    if (prevFfprobe === undefined) delete process.env.FRAMEVO_FFPROBE_PATH;
    else process.env.FRAMEVO_FFPROBE_PATH = prevFfprobe;
  }
});

test("a missing binary is reported, never guessed at", () => {
  // Nothing configured and nothing on disk: the app must SAY it has no engine
  // rather than hand a bare "ffmpeg" to spawn and fail later with ENOENT.
  const paths = resolveFfmpegPaths({ resourcesDir: "/nonexistent/resources" });
  assert.equal(paths.source, "missing");
  assert.equal(paths.ffmpeg, "");
  assert.equal(paths.ffprobe, "");
});

test("the encoder list parser reads ffmpeg's table", () => {
  const sample = [
    "Encoders:",
    " V..... = Video",
    " ------",
    " V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)",
    " V..... h264_qsv             H.264 / AVC (Intel Quick Sync Video acceleration)",
    " A....D aac                  AAC (Advanced Audio Coding)",
  ].join("\n");
  const names = parseEncoderList(sample);
  assert.ok(names.has("h264_nvenc"));
  assert.ok(names.has("h264_qsv"));
  assert.ok(names.has("aac"));
  assert.equal(names.has("Encoders:"), false);
});

test("each encoder expresses quality in its own currency", () => {
  assert.deepEqual(encoderArgs("libx264", 20, "medium"), ["-preset", "medium", "-crf", "20"]);
  assert.ok(encoderArgs("h264_nvenc", 20, "medium").includes("-cq"));
  assert.ok(encoderArgs("h264_qsv", 20, "medium").includes("-global_quality"));
  assert.ok(encoderArgs("h264_amf", 20, "medium").includes("-qp_i"));
  const vt = encoderArgs("h264_videotoolbox", 20, "medium");
  const quality = Number(vt[vt.indexOf("-q:v") + 1]);
  assert.ok(quality > 0 && quality <= 100, `videotoolbox quality ${quality}`);
  // No encoder args may ever contain the codec itself — that is passed separately.
  for (const id of ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"] as const) {
    assert.equal(encoderArgs(id, 20, "medium").includes(id), false);
  }
});

test("detection distinguishes 'compiled in' from 'works on this machine'", async () => {
  resetEncoderCache();
  const paths = resolveFfmpegPaths({ nodeModulesDir: NODE_MODULES });
  const encoders = await detectEncoders(paths.ffmpeg);

  // Software is always present and always usable — the guaranteed fallback.
  const software = encoders.find((e) => e.id === "libx264");
  assert.ok(software, "libx264 is listed");
  assert.equal(software!.available, true);
  assert.equal(software!.hardware, false);

  // Every hardware candidate for this platform is reported with a reason when
  // it is unusable, so the UI can explain rather than just hide it.
  for (const encoder of encoders.filter((e) => e.hardware)) {
    if (!encoder.available) assert.ok(encoder.detail, `${encoder.id} has no reason`);
  }

  // The picker prefers hardware, falls back to software, and never returns an
  // unavailable encoder.
  const chosen = pickEncoder(encoders, "auto");
  assert.equal(chosen.available, true);
  const forcedMissing = pickEncoder(
    [
      { id: "h264_nvenc", label: "NVENC", hardware: true, available: false },
      { id: "libx264", label: "Software", hardware: false, available: true },
    ],
    "h264_nvenc"
  );
  assert.equal(forcedMissing.id, "libx264", "an unusable request degrades instead of failing");
});

test("detection degrades safely when ffmpeg is missing entirely", async () => {
  resetEncoderCache();
  const encoders = await detectEncoders("");
  assert.equal(encoders.length, 1);
  assert.equal(encoders[0]!.id, "libx264");
  assert.equal(encoders[0]!.available, false);
  resetEncoderCache();
});
