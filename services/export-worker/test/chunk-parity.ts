/**
 * TIMELINE-AWARE CHUNKING PARITY GATE.
 *
 * Renders a synthetic clip the WHOLE way (single render) and as N CHUNKS (the
 * timeline-aware path: each chunk renders an OUTPUT window mapped to source time,
 * emits only its trim window, then the silent chunks are concatenated and final
 * audio is muxed globally). Then proves the two are equivalent:
 *
 *   - frame count identical                         → tiling has no gap/overlap
 *   - per-frame PSNR(single, chunked) very high     → the chunk seams sample the
 *                                                     RIGHT source frames (this is
 *                                                     the decoder-seek / emit-window
 *                                                     correctness check)
 *   - final duration ≈ single duration              → durations agree
 *   - final has audio when the source does          → global audio pass works
 *
 * Cases: linear, linear+padding, cuts, speed, cuts+speed.
 *
 *   Run:  npx tsx --tsconfig tsconfig.json test/chunk-parity.ts
 *
 * Requires only the bundled ffmpeg/ffprobe (no Firebase/Storage).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ffmpegBin, ffprobeBin, probeSource } from "../src/ffmpeg.js";
import { renderToMp4 } from "../src/render.js";
import { buildAudioFilterComplex } from "../src/audio.js";
import { buildRenderRecipe } from "@/lib/render/recipe";
import { deriveChunkWindow, type ChunkTilingInput } from "@/lib/export/chunk-window";
import { DEFAULT_EFFECTS_SETTINGS } from "@/lib/firebase/schema";
import type { DetectedMoment, SerializedRenderRecipe } from "@/lib/firebase/schema";

const execFileP = promisify(execFile);
const SRC_W = 640;
const SRC_H = 360;
const FPS = 30;
const SRC_DUR = 12; // seconds
const CHUNK_SECONDS = 4; // → ~3 chunks
const CRF = 28;
const PRESET = "ultrafast";
const MIN_AVG_PSNR = 35; // dB — independent encodes of identical frames ≫ this
const MIN_MIN_PSNR = 22; // dB — a misaligned seam tanks the per-frame minimum

const neverAbort = new AbortController().signal;

function recipe(sourceDuration: number, moments: DetectedMoment[] = []): SerializedRenderRecipe {
  return {
    sourceWidth: SRC_W,
    sourceHeight: SRC_H,
    fps: FPS,
    resolution: "1080p",
    format: "Source",
    sourceDuration,
    moments,
    effects: DEFAULT_EFFECTS_SETTINGS,
    sourceCrop: null,
    applyWatermark: false,
  };
}

async function ff(args: string[]): Promise<void> {
  await execFileP(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** testsrc2 (moving pattern — so a misaligned frame is obvious) + sine audio. */
async function genClip(out: string): Promise<void> {
  await ff([
    "-f", "lavfi", "-i", `testsrc2=size=${SRC_W}x${SRC_H}:rate=${FPS}:duration=${SRC_DUR}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${SRC_DUR}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-shortest", out,
  ]);
}

async function frameCount(path: string): Promise<number> {
  const { stdout } = await execFileP(ffprobeBin(), [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path,
  ]);
  return Number.parseInt(stdout.trim(), 10) || 0;
}

/** Per-frame PSNR(a, b) → { avg, min } in dB (Infinity when bit-identical). */
async function psnr(a: string, b: string): Promise<{ avg: number; min: number }> {
  // ffmpeg writes the psnr summary to stderr.
  const res = await execFileP(
    ffmpegBin(),
    ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"],
    { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 }
  ).catch((e: { stderr?: string; stdout?: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
  const text = (res as { stderr?: string }).stderr ?? "";
  const parse = (key: string): number => {
    const m = text.match(new RegExp(`${key}:([0-9.]+|inf)`, "i"));
    if (!m) return NaN;
    return m[1].toLowerCase() === "inf" ? Infinity : Number.parseFloat(m[1]);
  };
  return { avg: parse("average"), min: parse("min") };
}

/** Concat silent chunk MP4s losslessly (-c copy), like the merge concat step. */
async function concat(chunks: string[], out: string, dir: string): Promise<void> {
  const listPath = join(dir, "concat-list.txt");
  await writeFile(listPath, chunks.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  await ff(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", out]);
}

/** Global audio pass: mux final audio into the silent concatenated video (mirrors
 *  the CLI audiomux: video -c copy, audio direct for linear / filter for cuts-speed). */
async function audiomux(
  videoPath: string,
  sourcePath: string,
  serialized: SerializedRenderRecipe,
  out: string,
  dir: string
): Promise<void> {
  const r = buildRenderRecipe({ ...serialized, debugBorders: false });
  const hasSpeed = r.moments.some((m) => m.effectType === "speed-up");
  const hasCuts = r.timelineMap.totalRemoved > 0;
  const srcProbe = await probeSource(sourcePath);
  const args = ["-i", videoPath, "-i", sourcePath];
  if (!hasSpeed && !hasCuts) {
    args.push("-map", "0:v", "-map", "1:a:0?", "-af", "apad");
  } else {
    const fc = buildAudioFilterComplex(r.timelineMap.segments, r.moments, srcProbe.audioSampleRate, {
      padToFill: true,
    });
    const scriptPath = join(dir, "afc.txt");
    await writeFile(scriptPath, fc ?? "", "utf8");
    args.push("-filter_complex_script", scriptPath, "-map", "0:v", "-map", "[aout]");
  }
  args.push("-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out);
  await ff(args);
}

// ── runner ──────────────────────────────────────────────────────────────────
const results: { name: string; ok: boolean; detail: string }[] = [];
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function runScenario(
  name: string,
  dir: string,
  source: string,
  moments: DetectedMoment[],
  paddingSeconds: number
): Promise<void> {
  const started = Date.now();
  try {
    const serialized = recipe(SRC_DUR, moments);
    const r = buildRenderRecipe({ ...serialized, debugBorders: false });
    const outputDuration = r.outputDuration;
    const chunkCount = Math.max(1, Math.ceil(outputDuration / CHUNK_SECONDS));

    // 1. Single (whole-video) render — the reference.
    const single = join(dir, `${name}-single.mp4`);
    await renderToMp4({
      serialized, sourcePath: source, outputPath: single,
      crf: CRF, preset: PRESET, signal: neverAbort, onProgress: () => {},
    });

    // 2. Chunked render — each chunk renders its OUTPUT window, emits the trim span.
    const tiling: ChunkTilingInput = {
      outputDurationSeconds: outputDuration, fps: FPS, chunkCount, chunkSeconds: CHUNK_SECONDS, paddingSeconds,
    };
    const chunkFiles: string[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const w = deriveChunkWindow(i, tiling);
      const cf = join(dir, `${name}-chunk-${i}.mp4`);
      await renderToMp4({
        serialized, sourcePath: source, outputPath: cf,
        crf: CRF, preset: PRESET, signal: neverAbort, onProgress: () => {},
        chunk: {
          index: i,
          renderStartSec: w.renderStartSec, renderEndSec: w.renderEndSec,
          trimStartSec: w.trimStartSec, trimEndSec: w.trimEndSec,
        },
      });
      chunkFiles.push(cf);
    }

    // 3. Concat silent chunks → silent video.
    const mergedVideo = join(dir, `${name}-merged-video.mp4`);
    await concat(chunkFiles, mergedVideo, dir);

    // 4. Video parity: frame count + PSNR(single, chunked-video).
    const [fcSingle, fcChunked] = await Promise.all([frameCount(single), frameCount(mergedVideo)]);
    assert(
      Math.abs(fcSingle - fcChunked) <= 0,
      `frame count mismatch: single=${fcSingle} chunked=${fcChunked}`
    );
    const p = await psnr(single, mergedVideo);
    assert(
      p.avg >= MIN_AVG_PSNR || p.avg === Infinity,
      `avg PSNR too low (seam misalignment?): ${p.avg} dB < ${MIN_AVG_PSNR}`
    );
    assert(
      p.min >= MIN_MIN_PSNR || p.min === Infinity,
      `min PSNR too low (a seam frame is wrong): ${p.min} dB < ${MIN_MIN_PSNR}`
    );

    // 5. Global audio pass + duration/audio parity.
    const final = join(dir, `${name}-final.mp4`);
    await audiomux(mergedVideo, source, serialized, final, dir);
    const [si, fi] = await Promise.all([probeSource(single), probeSource(final)]);
    assert(fi.hasAudio, "final output is missing audio (global audio pass failed)");
    const durTol = Math.max(0.5, 2 / FPS);
    assert(
      Math.abs(fi.durationSec - si.durationSec) <= durTol,
      `final duration ${fi.durationSec.toFixed(2)}s vs single ${si.durationSec.toFixed(2)}s > ${durTol.toFixed(2)}s`
    );

    const detail =
      `chunks=${chunkCount} frames=${fcChunked} ` +
      `psnr(avg=${p.avg === Infinity ? "inf" : p.avg.toFixed(1)},min=${p.min === Infinity ? "inf" : p.min.toFixed(1)})dB ` +
      `dur=${fi.durationSec.toFixed(2)}s audio=${fi.audioCodec}`;
    results.push({ name, ok: true, detail: `${detail} (${Date.now() - started}ms)` });
    console.log(`  ✔ ${name} — ${detail}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.error(`  x ${name} — FAILED: ${detail}`);
  }
}

function cut(id: string, start: number, end: number): DetectedMoment {
  return {
    id, startTime: start, endTime: end, label: "", reason: "",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType: "cut", cut: { active: true },
  };
}
function speed(id: string, start: number, end: number, mult: number): DetectedMoment {
  return {
    id, startTime: start, endTime: end, label: "", reason: "",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType: "speed-up", speed: { multiplier: mult, audioMode: "keep", transition: "cut" },
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "framevo-chunk-parity-"));
  console.log(`\nTimeline-aware chunking parity gate — workdir ${dir}\n`);
  const source = join(dir, "source.mp4");
  await genClip(source);

  await runScenario("linear", dir, source, [], 0);
  await runScenario("linear+pad", dir, source, [], 1); // exercise warm-up + emit-window
  await runScenario("cuts", dir, source, [cut("c1", 3, 5)], 0);
  await runScenario("speed", dir, source, [speed("s1", 4, 8, 2)], 0);
  await runScenario("cuts+speed", dir, source, [cut("c1", 2, 3), speed("s1", 5, 9, 2)], 0);

  await rm(dir, { recursive: true, force: true }).catch(() => {});

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed.`);
  if (failed.length) {
    console.error("\nFAILED:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log("All chunking parity scenarios passed.\n");
}

void main();
