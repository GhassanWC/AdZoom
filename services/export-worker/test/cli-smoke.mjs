/**
 * Smoke test for the render CLI (dist/cli.js) — the subprocess the C# export API
 * spawns. Verifies stdout is PURE NDJSON (the [worker:*] logs don't leak onto
 * it), the preflight→done event sequence fires, and the output is a valid H.264
 * MP4. Run after `npm run build:cli`:  node test/cli-smoke.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../dist/cli.js");
if (!existsSync(cli)) {
  console.error("dist/cli.js missing — run `npm run build:cli` first");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "cli-smoke-"));
const src = join(dir, "src.mp4");
const out = join(dir, "out.mp4");

// A 2s 640x360 H.264/AAC source.
execFileSync(ffmpegPath, [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
]);

const effects = {
  autoZoom: 72, cursorSize: 50, cursorSmoothing: 65, zoomSpeed: 55,
  motionSensitivity: 70, clickHighlightSize: 60, clickHighlightStyle: "ring",
  verticalExport: false, clickHighlights: true, motionTracking: true,
  pacing: "moderate", targetPlatform: "youtube", defaultExportFormat: "YouTube 16:9",
};
const spec = {
  sourcePath: src, outputPath: out, crf: 23, preset: "ultrafast", normalizeEnabled: false,
  serializedRecipe: {
    sourceWidth: 640, sourceHeight: 360, fps: 30, resolution: "1080p", format: "Source",
    sourceDuration: 2, moments: [], effects, sourceCrop: null, applyWatermark: false,
  },
};
const specPath = join(dir, "spec.json");
writeFileSync(specPath, JSON.stringify(spec));

const child = spawn(process.execPath, [cli, specPath], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
child.on("close", (code) => {
  const lines = stdout.trim().split("\n").filter(Boolean);
  const events = [];
  for (const l of lines) {
    try {
      events.push(JSON.parse(l));
    } catch {
      console.error("FAIL: non-JSON line on stdout (a [worker:*] log leaked):", l);
      process.exit(1);
    }
  }
  const types = events.map((e) => e.type);
  console.log("exit:", code, "| events:", types.join(","));
  const ok = code === 0 && types.includes("preflight") && types.includes("done") && existsSync(out);
  if (!ok) {
    console.error("FAIL:", { code, types, outExists: existsSync(out), stderrTail: stderr.slice(-400) });
    process.exit(1);
  }
  const probe = execFileSync(ffprobeStatic.path, [
    "-v", "quiet", "-print_format", "json", "-show_streams", out,
  ], { encoding: "utf8" });
  const streams = JSON.parse(probe).streams || [];
  if (!streams.some((s) => s.codec_type === "video" && s.codec_name === "h264")) {
    console.error("FAIL: output has no h264 video stream");
    process.exit(1);
  }
  console.log("PASS: CLI stdout is pure NDJSON (preflight→done) + valid H.264 MP4 produced");
});
