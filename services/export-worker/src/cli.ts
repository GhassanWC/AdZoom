/**
 * Render CLI — the subprocess the C# export API (services/export-api-dotnet)
 * spawns to render ONE job.
 *
 * It reuses the worker's render core (renderToMp4 + computePreflight +
 * normalizeSource + the canvas compositor) against LOCAL files ONLY — no
 * Firestore, GCS, or Cloud Tasks (the C# orchestrator owns those). It emits
 * NDJSON events on STDOUT (one per line) and routes ALL human/`[worker:*]` logs
 * to STDERR, so stdout is a clean machine channel the orchestrator parses.
 *
 *   node dist/cli.js <jobSpec.json>
 *
 * Spec (JSON file, path = argv[2]):
 *   { sourcePath, outputPath, serializedRecipe, crf?, preset?,
 *     normalizeCrf?, normalizePreset?, normalizeEnabled?, audioAlreadyDropped? }
 *
 * Events (NDJSON, stdout):
 *   preflight | stage | progress | warning | first-frame | done | error | canceled
 *
 * Cancel: the orchestrator writes the line `cancel` to this process's stdin →
 * the render aborts (kills ffmpeg) and exits 2. (EOF is NOT treated as cancel,
 * so a standalone run with stdin closed still renders to completion.)
 *
 * Exit codes: 0 = done, 1 = error, 2 = canceled.
 */
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

/**
 * Bumped whenever the render/normalization contract changes. Logged at startup +
 * emitted as a `version` event so a STALE worker image is OBVIOUS in the logs: a
 * new image logs `2025.06-normalize+canvasdata`; an old one logs a different
 * value (or none at all — pre-versioning images never emit a `version` event).
 */
const RENDER_CLI_VERSION = "2025.06-normalize+canvasdata";

// ── stdout = NDJSON only; route every console.* to stderr ───────────────────
function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}
function toStderr(...args: unknown[]): void {
  process.stderr.write(
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n"
  );
}
// The reused render core logs via console.info/warn/error ([worker:*]). Redirect
// them all to stderr so they never corrupt the NDJSON on stdout. (Imports below
// only DEFINE functions — they don't log at load time — so this runs first.)
console.log = toStderr as typeof console.log;
console.info = toStderr as typeof console.info;
console.debug = toStderr as typeof console.debug;
console.warn = toStderr as typeof console.warn;
console.error = toStderr as typeof console.error;

import { renderToMp4 } from "./render.js";
import { computePreflight, AUDIO_UNSUPPORTED_WARNING } from "./preflight.js";
import { normalizeSource, probeSource, ffmpegBin, type SourceInfo } from "./ffmpeg.js";
import { buildAudioFilterComplex } from "./audio.js";
import { buildRenderRecipe } from "@/lib/render/recipe";
import { toUserFacingError } from "./errors.js";
import type { SerializedRenderRecipe } from "@/lib/firebase/schema";

interface JobSpec {
  /** Job id for log correlation (diagnostics only). */
  jobId?: string;
  sourcePath: string;
  outputPath: string;
  serializedRecipe: SerializedRenderRecipe;
  crf?: number;
  preset?: string;
  normalizeCrf?: number;
  normalizePreset?: string;
  normalizeEnabled?: boolean;
  audioAlreadyDropped?: boolean;
  /** Chunked render: RENDER [renderStartSec, renderEndSec) but EMIT only
   *  [trimStartSec, trimEndSec) (see RenderOptions.chunk). Output time is mapped to
   *  source time via the timeline map, so cuts/speed work. Chunks are silent —
   *  audio is added globally in `audiomux`. Omitted ⇒ whole-video render. */
  chunk?: {
    index?: number;
    renderStartSec: number;
    renderEndSec: number;
    trimStartSec: number;
    trimEndSec: number;
  };
  /**
   * Pipeline stage:
   *   "render"   (default) → decode/composite/encode (whole video or one chunk).
   *   "concat"   → losslessly join `inputs` (rendered SILENT chunks) into `outputPath`.
   *   "audiomux" → compose final audio over the WHOLE timeline and mux it into the
   *                concatenated silent video (`videoPath`) → `outputPath`.
   */
  mode?: "render" | "concat" | "audiomux";
  /** concat mode: ordered chunk file paths to join. */
  inputs?: string[];
  /** audiomux mode: the concatenated SILENT video to add audio to. */
  videoPath?: string;
  /** audiomux mode: hard wall-clock budget (seconds) for the audio-mux ffmpeg
   *  before it's killed and we fall back to a video-only final. Falls back to
   *  EXPORT_AUDIOMUX_TIMEOUT_SECONDS, then 300. */
  audioMuxTimeoutSec?: number;
}

/** Read a positive-integer env var with a fallback (0/negative/NaN ⇒ fallback). */
function envInt(key: string, fallback: number): number {
  const n = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Spawn ffmpeg, stream stderr to logs, resolve on exit 0, reject otherwise. */
function runFfmpeg(args: string[], tag: string, failCode: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    child.stderr.on("data", (d: Buffer) => {
      tail = (tail + d.toString()).slice(-4000);
      const t = d.toString().trim();
      if (t) toStderr(`[worker:${tag}]`, t);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${failCode}: ffmpeg exited ${code}: ${tail.trim().slice(-800)}`));
    });
  });
}

/** Error thrown by {@link runFfmpegSupervised} when ffmpeg is killed for exceeding
 *  its wall-clock budget — distinguishable from a normal non-zero exit. */
interface FfmpegTimeoutError extends Error {
  timedOut: true;
}

/**
 * Like {@link runFfmpeg}, but for stages that can WEDGE (audiomux): adds a hard
 * wall-clock timeout (SIGKILLs ffmpeg on exceed → rejects with `timedOut`), a 15s
 * liveness heartbeat (stderr + an NDJSON `audiomux-progress` event so a stall is
 * visible within seconds, not after the watchdog), cooperative abort (cancel), and
 * logs the full ffmpeg command up front. Resolves on exit 0.
 */
function runFfmpegSupervised(
  args: string[],
  opts: { tag: string; failCode: string; label: string; timeoutMs: number; signal?: AbortSignal }
): Promise<void> {
  const { tag, failCode, label, timeoutMs, signal } = opts;
  return new Promise<void>((resolve, reject) => {
    toStderr(`[worker:${tag}] ffmpeg start label=${label} timeoutSec=${Math.round(timeoutMs / 1000)}`);
    toStderr(`[worker:${tag}] ffmpeg cmd: ${ffmpegBin()} ${args.join(" ")}`);
    const startMs = Date.now();
    const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    let settled = false;
    let timedOut = false;
    const elapsedSec = (): number => Math.round((Date.now() - startMs) / 1000);

    child.stderr.on("data", (d: Buffer) => {
      tail = (tail + d.toString()).slice(-4000);
      const t = d.toString().trim();
      if (t) toStderr(`[worker:${tag}]`, t);
    });

    // req: a progress log every 15s while ffmpeg runs — proves liveness and makes a
    // stall obvious immediately (the timeout is the hard backstop, this is the signal).
    const heartbeat = setInterval(() => {
      toStderr(`[worker:${tag}] still running label=${label} elapsed=${elapsedSec()}s`);
      emit({ type: "audiomux-progress", stage: tag, label, elapsedSec: elapsedSec() });
    }, 15_000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    // req: hard timeout — SIGKILL ffmpeg if it exceeds the budget (a hung mux).
    const timer = setTimeout(() => {
      timedOut = true;
      toStderr(`[worker:${tag}] TIMEOUT after ${Math.round(timeoutMs / 1000)}s — killing ffmpeg label=${label}`);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const onAbort = (): void => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = (): void => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const sec = elapsedSec();
      if (timedOut) {
        const e = new Error(
          `${failCode}_timeout: ffmpeg killed after ${Math.round(timeoutMs / 1000)}s (label=${label})`
        ) as FfmpegTimeoutError;
        e.timedOut = true;
        reject(e);
        return;
      }
      if (signal?.aborted) {
        reject(new Error(`${failCode}_canceled`));
        return;
      }
      if (code === 0) {
        toStderr(`[worker:${tag}] ffmpeg done label=${label} in ${sec}s`);
        resolve();
        return;
      }
      reject(new Error(`${failCode}: ffmpeg exited ${code} after ${sec}s: ${tail.trim().slice(-800)}`));
    });
  });
}

/**
 * Concat mode — losslessly join pre-rendered SILENT chunk MP4s (identical codecs/
 * params, each starting on an IDR) into one MP4 via ffmpeg's concat demuxer
 * (`-c copy`, no re-encode). Audio is added afterwards by `audiomux`.
 */
async function runConcat(spec: JobSpec): Promise<void> {
  const inputs = spec.inputs ?? [];
  if (inputs.length === 0) {
    emit({ type: "error", code: "concat_no_inputs", message: "No chunk inputs to concat." });
    process.exit(1);
  }
  for (const f of inputs) {
    if (!existsSync(f)) {
      emit({ type: "error", code: "concat_missing_chunk", message: `Chunk missing: ${f}` });
      process.exit(1);
    }
  }
  emit({ type: "stage", name: "merging" });
  const listPath = join(dirname(spec.outputPath), "concat-list.txt");
  // ffmpeg concat demuxer: one `file '<path>'` per line; single-quotes escaped.
  const list = inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
  writeFileSync(listPath, list, "utf8");

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-y",
    spec.outputPath,
  ];
  await runFfmpeg(args, "concat", "concat_failed");
  emit({ type: "done", warnings: [], merged: inputs.length });
  process.exit(0);
}

/**
 * Audiomux mode (chunked finalize) — compose the FINAL audio over the WHOLE output
 * timeline and mux it into the concatenated silent video. Video is stream-copied
 * (`-c:v copy`, no re-encode); audio is mapped direct (linear timeline) or rebuilt
 * from the timeline segments (cuts/speed), padded to the video length so `-shortest`
 * trims it exactly. Validates the result (duration ≈ expected; audio present if
 * expected) BEFORE the orchestrator uploads it. Idempotent: writes `outputPath`
 * fresh each run, so a re-claimed merge leader can re-run safely.
 */
async function runAudioMux(spec: JobSpec, signal: AbortSignal): Promise<void> {
  const videoPath = spec.videoPath ?? "";
  if (!videoPath || !existsSync(videoPath)) {
    emit({ type: "error", code: "audiomux_no_video", message: `Merged video missing: ${videoPath}` });
    process.exit(1);
  }
  if (!spec.sourcePath || !existsSync(spec.sourcePath)) {
    emit({ type: "error", code: "audiomux_no_source", message: `Audio source missing: ${spec.sourcePath}` });
    process.exit(1);
  }
  emit({ type: "stage", name: "muxing-audio" });
  const timeoutSec = Math.max(30, spec.audioMuxTimeoutSec ?? envInt("EXPORT_AUDIOMUX_TIMEOUT_SECONDS", 300));
  const timeoutMs = timeoutSec * 1000;
  // The video-only fallback is a stream-copy (`-c:v copy`) — near-instant even for a
  // long video — so cap it tightly regardless of the (larger) audio-mux budget.
  const videoOnlyTimeoutMs = Math.min(timeoutMs, 120_000);
  toStderr(
    `[worker:audiomux] start video=${videoPath} source=${spec.sourcePath} out=${spec.outputPath} timeoutSec=${timeoutSec}`
  );

  const recipe = buildRenderRecipe({ ...spec.serializedRecipe, debugBorders: false });
  const { fps, outputDuration, timelineMap } = recipe;
  const hasSpeed = recipe.moments.some((m) => m.effectType === "speed-up");
  const hasCuts = timelineMap.totalRemoved > 0;

  // Obtain a clean AAC audio source. The merge normally passes the PERSISTED
  // normalized-source.mp4 with normalizeEnabled=false (use as-is, no re-transcode).
  // Fallback (persisted missing) passes the ORIGINAL with normalizeEnabled !== false.
  let audioSource = spec.sourcePath;
  let audioStatus: "preserved" | "removed" | "none";
  if (spec.normalizeEnabled !== false) {
    const normPath = join(dirname(spec.outputPath), "normalized-source.mp4");
    const norm = await normalizeSource({
      sourcePath: spec.sourcePath,
      outputPath: normPath,
      crf: spec.normalizeCrf ?? 18,
      preset: spec.normalizePreset ?? "veryfast",
      signal,
    });
    audioSource = normPath;
    audioStatus = norm.audioStatus;
  } else {
    const probe = await probeSource(audioSource).catch(() => null);
    audioStatus = probe?.hasAudio ? "preserved" : "none";
  }

  const srcProbe = await probeSource(audioSource).catch(() => null);
  let sourceHasAudio = audioStatus === "preserved" && !!srcProbe?.hasAudio;

  // ── req: detailed input diagnostics BEFORE any ffmpeg work (so a hang/failure is
  //    self-explanatory in the logs: paths, existence, sizes, ffprobe streams). ──
  const vidProbe = await probeSource(videoPath).catch(() => null);
  const vidSize = existsSync(videoPath) ? statSync(videoPath).size : 0;
  const srcSize = existsSync(audioSource) ? statSync(audioSource).size : 0;
  toStderr(
    `[worker:audiomux] input.video path=${videoPath} exists=${existsSync(videoPath)} size=${vidSize} probe=${JSON.stringify(vidProbe)}`
  );
  toStderr(
    `[worker:audiomux] input.audioSource path=${audioSource} exists=${existsSync(audioSource)} size=${srcSize} audioStatus=${audioStatus} sourceHasAudio=${sourceHasAudio} hasCuts=${hasCuts} hasSpeed=${hasSpeed} probe=${JSON.stringify(srcProbe)}`
  );
  emit({
    type: "audiomux-inputs",
    videoPath,
    videoExists: existsSync(videoPath),
    videoSize: vidSize,
    videoProbe: vidProbe,
    sourcePath: audioSource,
    sourceExists: existsSync(audioSource),
    sourceSize: srcSize,
    sourceProbe: srcProbe,
    audioStatus,
    sourceHasAudio,
    hasCuts,
    hasSpeed,
  });

  // Surface the unsupported-audio notice ONCE for the final output (the per-chunk
  // renders suppress it). Only knowable here when audiomux re-normalized the source.
  const muxWarnings: string[] = [];
  if (audioStatus === "removed") {
    muxWarnings.push(AUDIO_UNSUPPORTED_WARNING);
    emit({ type: "warning", message: AUDIO_UNSUPPORTED_WARNING });
  }

  // Video-only final (silent): stream-copy the concatenated video. Used when the
  // source has no usable audio, OR as the FALLBACK when the audio mux fails/times out.
  const videoOnlyArgs: string[] = [
    "-hide_banner", "-loglevel", "warning", "-i", videoPath,
    "-map", "0:v", "-c:v", "copy", "-movflags", "+faststart", "-y", spec.outputPath,
  ];
  const buildWithAudioArgs = (): string[] => {
    const a: string[] = ["-hide_banner", "-loglevel", "warning", "-i", videoPath, "-i", audioSource];
    const sampleRate = srcProbe?.audioSampleRate ?? 48000;
    const fc =
      !hasSpeed && !hasCuts
        ? null
        : buildAudioFilterComplex(timelineMap.segments, recipe.moments, sampleRate, {
            padToFill: true,
          });
    if (fc) {
      // Cuts/speed: rebuild audio from the timeline segments (already apad-padded).
      const scriptPath = join(dirname(spec.outputPath), "audiomux-afc.txt");
      writeFileSync(scriptPath, fc, "utf8");
      a.push("-filter_complex_script", scriptPath, "-map", "0:v", "-map", "[aout]");
    } else {
      // Linear: map the source audio straight through, padded to the video length.
      a.push("-map", "0:v", "-map", "1:a:0?", "-af", "apad");
    }
    a.push("-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", "-y", spec.outputPath);
    return a;
  };

  if (!sourceHasAudio) {
    // No usable audio → final stays silent (copy the video only).
    await runFfmpegSupervised(videoOnlyArgs, {
      tag: "audiomux", failCode: "audiomux_failed", label: "video-only", timeoutMs: videoOnlyTimeoutMs, signal,
    });
  } else {
    try {
      await runFfmpegSupervised(buildWithAudioArgs(), {
        tag: "audiomux", failCode: "audiomux_failed", label: "with-audio", timeoutMs, signal,
      });
    } catch (err) {
      if (signal.aborted) throw err; // cancel — handled by the caller (exit 2)
      // req: invalid / unmuxable / HUNG audio must not lose the whole export, and
      // must not hang forever. The audio mux failed or timed out → deliver a
      // VIDEO-ONLY final (silent) and warn, instead of failing. Only a failure of
      // THIS fallback is a true audiomux failure.
      const detail = (err as Error)?.message ?? String(err);
      const why = (err as Partial<FfmpegTimeoutError>)?.timedOut
        ? `timed out after ${timeoutSec}s`
        : "errored";
      toStderr(`[worker:audiomux] with-audio mux ${why} — falling back to VIDEO-ONLY. detail=${detail}`);
      emit({ type: "warning", message: AUDIO_UNSUPPORTED_WARNING });
      if (!muxWarnings.includes(AUDIO_UNSUPPORTED_WARNING)) muxWarnings.push(AUDIO_UNSUPPORTED_WARNING);
      sourceHasAudio = false;
      audioStatus = "removed";
      await runFfmpegSupervised(videoOnlyArgs, {
        tag: "audiomux", failCode: "audiomux_failed", label: "video-only-fallback", timeoutMs: videoOnlyTimeoutMs, signal,
      });
    }
  }

  // ── Validate BEFORE the orchestrator uploads/settles, WITH a video-only safety
  //    net. A with-audio mux that "succeeded" but produced a silent / wrong-length
  //    file means the AUDIO muxing went wrong — degrade to a video-only final
  //    (correct video, no audio) rather than hard-failing the whole export (req:
  //    audio problems never lose the export). Only a video-only output that ALSO
  //    fails validation is fatal. ────────────────────────────────────────────────
  const tol = Math.max(0.5, 2 / fps);
  const validateFinal = async (
    expectAudio: boolean
  ): Promise<
    | { ok: true; outProbe: SourceInfo; outDur: number; size: number }
    | { ok: false; recoverable: boolean; code: string; message: string }
  > => {
    const outProbe = await probeSource(spec.outputPath).catch(() => null);
    const size = existsSync(spec.outputPath) ? statSync(spec.outputPath).size : 0;
    if (!outProbe || size <= 0) {
      return { ok: false, recoverable: false, code: "audiomux_failed", message: "audiomux produced no/empty output" };
    }
    const outDur = outProbe.durationSec ?? 0;
    // Audio expected (source had usable audio, not muted-by-design) but final silent.
    if (expectAudio && !outProbe.hasAudio) {
      return { ok: false, recoverable: true, code: "audio_missing_after_render", message: "audio expected but the final muxed output is silent" };
    }
    if (Math.abs(outDur - outputDuration) > tol) {
      return {
        ok: false,
        recoverable: true,
        code: "duration_mismatch",
        message: `final duration ${outDur.toFixed(2)}s differs from expected ${outputDuration.toFixed(2)}s by more than ${tol.toFixed(2)}s`,
      };
    }
    return { ok: true, outProbe, outDur, size };
  };

  let result = await validateFinal(sourceHasAudio);
  if (!result.ok && result.recoverable && sourceHasAudio) {
    // The audio output is bad (silent/wrong-length) — fall back to a video-only final.
    toStderr(`[worker:audiomux] with-audio output failed validation (${result.code}) — falling back to VIDEO-ONLY`);
    emit({ type: "warning", message: AUDIO_UNSUPPORTED_WARNING });
    if (!muxWarnings.includes(AUDIO_UNSUPPORTED_WARNING)) muxWarnings.push(AUDIO_UNSUPPORTED_WARNING);
    sourceHasAudio = false;
    audioStatus = "removed";
    await runFfmpegSupervised(videoOnlyArgs, {
      tag: "audiomux", failCode: "audiomux_failed", label: "video-only-postvalidate", timeoutMs: videoOnlyTimeoutMs, signal,
    });
    result = await validateFinal(false);
  }
  if (!result.ok) {
    emit({ type: "error", code: result.code, message: result.message });
    process.exit(1);
  }

  const { outProbe, outDur, size } = result;
  emit({
    type: "audio-verify",
    audioStatus: sourceHasAudio ? "preserved" : "none",
    sourceHasAudio,
    outputHasAudio: outProbe.hasAudio,
    outputAudioCodec: outProbe.audioCodec || "(none)",
    outputDurationSec: outDur,
    expectedDurationSec: outputDuration,
    durationDiffSec: Math.abs(outDur - outputDuration),
    fileSizeBytes: size,
  });
  toStderr(
    `[worker:audiomux] audio-verify sourceAudio=${sourceHasAudio} outputAudio=${outProbe.hasAudio} ` +
      `outDur=${outDur.toFixed(2)} expected=${outputDuration.toFixed(2)} tol=${tol.toFixed(2)} size=${size}`
  );

  emit({
    type: "done",
    warnings: muxWarnings,
    merged: 1,
    normalized: spec.normalizeEnabled !== false,
    audioStatus: sourceHasAudio ? "preserved" : "none",
    outputDurationSec: outDur,
  });
  process.exit(0);
}

async function main(): Promise<void> {
  // Proof-of-build: always the FIRST line so a stale image is detectable even if
  // the job later fails. The C# orchestrator logs this as [vm-worker:cli-version].
  const build = process.env.BUILD_VERSION ?? "unknown";
  emit({ type: "version", cliVersion: RENDER_CLI_VERSION, build, node: process.version });
  toStderr(`[worker:cli] start version=${RENDER_CLI_VERSION} build=${build} node=${process.version}`);

  const specPath = process.argv[2];
  if (!specPath) {
    emit({ type: "error", code: "bad_invocation", message: "Missing job-spec path argument." });
    process.exit(1);
  }
  let spec: JobSpec;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8")) as JobSpec;
  } catch (err) {
    emit({
      type: "error",
      code: "bad_invocation",
      message: "Unreadable job spec: " + (err as Error).message,
    });
    process.exit(1);
  }

  // Concat mode (chunked render finalize) — join chunks, no decode/normalize.
  if (spec.mode === "concat") {
    try {
      await runConcat(spec);
    } catch (err) {
      const friendly = toUserFacingError(err);
      toStderr("[worker:cli] concat failed:", (err as Error)?.message ?? String(err));
      emit({ type: "error", code: friendly.code, message: friendly.message });
      process.exit(1);
    }
    return;
  }

  // Cooperative cancel: orchestrator writes the line `cancel` to stdin.
  const controller = new AbortController();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim() === "cancel") {
      toStderr("[worker:cli] cancel requested");
      controller.abort();
    }
  });
  rl.on("error", () => {});

  // Audiomux mode (chunked finalize) — global audio over the whole timeline, muxed
  // into the concatenated silent video. Uses controller.signal so a cancel mid-
  // normalize aborts cleanly.
  if (spec.mode === "audiomux") {
    try {
      await runAudioMux(spec, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        emit({ type: "canceled" });
        rl.close();
        process.exit(2);
      }
      const friendly = toUserFacingError(err);
      toStderr("[worker:cli] audiomux failed:", (err as Error)?.message ?? String(err));
      emit({ type: "error", code: friendly.code, message: friendly.message });
      rl.close();
      process.exit(1);
    }
    return;
  }

  const crf = spec.crf ?? 19;
  const preset = spec.preset ?? "veryfast";
  // A chunk render is INTENTIONALLY silent — final audio is composed once over the
  // whole timeline in `audiomux`. So we must NOT push an audio-drop warning per
  // chunk, and must NOT treat the silent chunk output as a bug.
  const chunkSilent = !!spec.chunk;
  const warnings: string[] = [];
  const pushWarning = (w: string): void => {
    if (!warnings.includes(w)) {
      warnings.push(w);
      emit({ type: "warning", message: w });
    }
  };

  try {
    // 1. Preflight — probe + decode tests (video fast-fail, audio fallback).
    const pf = await computePreflight(spec.sourcePath);
    const audioCodec = pf.info.audioCodec || pf.info.audioCodecTag || "";
    emit({
      type: "preflight",
      videoCodec: pf.info.videoCodec,
      audioCodec,
      risky: pf.risky,
      videoDecodable: pf.videoDecodable,
      audioDecodable: pf.audioDecodable,
      needsAudioDrop: pf.needsAudioDrop,
      normalized: false,
    });
    if (!pf.videoDecodable) {
      throw new Error("unsupported_video: source video could not be decoded");
    }

    // 2. Normalization — ALWAYS transcode to a worker-safe normalized-source.mp4
    //    (H.264 + exactly one clean AAC track, or silent). The renderer ONLY ever
    //    sees this file, so no exotic / extra / undecodable source stream — e.g. a
    //    MOV's bad `apac` track alongside a good AAC one — can crash the export.
    const normPath = join(dirname(spec.outputPath), "normalized-source.mp4");
    const expectNormalize = spec.normalizeEnabled !== false;
    let renderSource = spec.sourcePath;
    let audioStatus: "preserved" | "removed" | "none" = pf.info.hasAudio
      ? pf.needsAudioDrop
        ? "removed"
        : "preserved"
      : "none";
    let normalized = false;
    if (expectNormalize) {
      emit({ type: "stage", name: "normalizing" });
      let norm;
      try {
        norm = await normalizeSource({
          sourcePath: spec.sourcePath,
          outputPath: normPath,
          crf: spec.normalizeCrf ?? 18,
          preset: spec.normalizePreset ?? "veryfast",
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw err; // cancel — handled below
        // Tag so the failed job records `normalize_failed` (raw detail → stderr/logs).
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`normalize_failed: ${detail}`);
      }
      renderSource = normPath;
      normalized = true;
      audioStatus = norm.audioStatus;
    }
    // A caller can still force-drop (legacy); the normalized file has no audio
    // when removed/absent, so the render stays silent WITHOUT its own notice.
    if (spec.audioAlreadyDropped && audioStatus === "preserved") audioStatus = "removed";
    const audioDropped = audioStatus !== "preserved";
    // Per-chunk: suppress the unsupported-audio notice (it would duplicate across N
    // chunks); the global audiomux stage surfaces it once for the final output.
    if (audioStatus === "removed" && !chunkSilent) pushWarning(AUDIO_UNSUPPORTED_WARNING);

    // 2b. REQUIRED pre-render contract — prove exactly what the renderer will read.
    emit({
      type: "render-input",
      inputFile: spec.sourcePath,
      normalizedFile: normPath,
      renderSource,
      wasNormalizationRun: normalized,
    });
    toStderr(
      `[worker:cli] render-input input=${spec.sourcePath} normalizedFile=${normPath} renderSource=${renderSource} wasNormalizationRun=${normalized}`
    );
    // HARD GUARD — never silently render the ORIGINAL. If normalization was
    // expected but didn't run (stale image / bug), fail the job loudly instead.
    if (expectNormalize && (!normalized || renderSource !== normPath)) {
      throw new Error(
        `normalize_not_executed: normalizeEnabled but normalization did not run (renderSource=${renderSource})`
      );
    }
    if (normalized && !existsSync(renderSource)) {
      throw new Error(`normalize_not_executed: normalized-source.mp4 missing at ${renderSource}`);
    }

    // 3. Render — decode → composeFrame → encode (canvas parity with browser).
    const startedMs = Date.now();
    let lastStage = "";
    let firstFrameEmitted = false;
    const result = await renderToMp4({
      serialized: spec.serializedRecipe,
      jobId: spec.jobId,
      sourcePath: renderSource,
      outputPath: spec.outputPath,
      crf,
      preset,
      signal: controller.signal,
      audioAlreadyDropped: audioDropped,
      chunk: spec.chunk,
      onProgress: ({ stage, progress }) => {
        if (stage !== lastStage) {
          lastStage = stage;
          emit({ type: "stage", name: stage });
          if (stage === "rendering" && !firstFrameEmitted) {
            firstFrameEmitted = true;
            emit({ type: "first-frame", ms: Date.now() - startedMs });
          }
        }
        emit({ type: "progress", value: progress });
      },
    });

    for (const w of result.warnings) pushWarning(w);

    // 3b. Audio-integrity check — run ffprobe on the FINAL mp4 before the
    // orchestrator uploads it. If the render source carried usable audio that we
    // did NOT intentionally drop (apac → silent fallback), the output MUST have
    // audio. A silent output here is a real bug, not an unsupported codec — fail
    // with `audio_missing_after_render` so the orchestrator never uploads it.
    const [renderSrcProbe, outProbe] = await Promise.all([
      probeSource(renderSource).catch(() => null),
      probeSource(spec.outputPath).catch(() => null),
    ]);
    const outDur = outProbe?.durationSec ?? 0;
    const srcDur = renderSrcProbe?.durationSec ?? 0;
    emit({
      type: "audio-verify",
      audioStatus,
      sourceHasAudio: pf.info.hasAudio,
      sourceAudioCodec: audioCodec || "(none)",
      normalizedHasAudio: renderSrcProbe?.hasAudio ?? null,
      outputHasAudio: outProbe?.hasAudio ?? null,
      outputAudioCodec: outProbe?.audioCodec || "(none)",
      outputDurationSec: outDur,
      videoDurationSec: srcDur,
      durationDiffSec: Math.abs(outDur - srcDur),
    });
    toStderr(
      `[worker:cli] audio-verify audioStatus=${audioStatus} sourceAudio=${pf.info.hasAudio} ` +
        `normalizedAudio=${renderSrcProbe?.hasAudio} outputAudio=${outProbe?.hasAudio} ` +
        `outputCodec=${outProbe?.audioCodec || "(none)"} outDur=${outDur.toFixed(2)} ` +
        `vidDur=${srcDur.toFixed(2)} diff=${Math.abs(outDur - srcDur).toFixed(2)}`
    );
    // Only "preserved" means audio should be present (removed/none = silent by
    // design). A CHUNK is silent on purpose — its audio is composed later in
    // audiomux — so don't flag a missing-audio "bug" here for chunk renders.
    if (audioStatus === "preserved" && !chunkSilent && outProbe && !outProbe.hasAudio) {
      throw new Error(
        "audio_missing_after_render: render source has audio but final output has none"
      );
    }

    // Chunk completion visibility + output-duration sanity. The renderer EMITs only
    // the trim window, so the chunk output should ≈ that span; a big overshoot would
    // mean it rendered outside the requested window.
    if (chunkSilent && spec.chunk) {
      const expectedDur = Math.max(0, spec.chunk.trimEndSec - spec.chunk.trimStartSec);
      const fileSize = existsSync(spec.outputPath) ? statSync(spec.outputPath).size : 0;
      emit({
        type: "chunk-complete",
        chunkIndex: spec.chunk.index ?? -1,
        outputStartSec: spec.chunk.trimStartSec,
        outputEndSec: spec.chunk.trimEndSec,
        expectedDurationSec: Number(expectedDur.toFixed(2)),
        outputDurationSec: Number(outDur.toFixed(2)),
        fileSizeBytes: fileSize,
      });
      toStderr(
        `[worker:cli] chunk-complete index=${spec.chunk.index ?? -1} ` +
          `outWindow=[${spec.chunk.trimStartSec.toFixed(2)},${spec.chunk.trimEndSec.toFixed(2)}] ` +
          `outDur=${outDur.toFixed(2)}s expected=${expectedDur.toFixed(2)}s size=${fileSize}B`
      );
      if (expectedDur > 0 && outDur > expectedDur * 1.5) {
        toStderr(
          `[worker:cli] WARN chunk_output_duration_unexpected index=${spec.chunk.index ?? -1} ` +
            `outDur=${outDur.toFixed(2)}s >> expected=${expectedDur.toFixed(2)}s — rendered outside the window?`
        );
        emit({ type: "warning", message: "chunk_output_duration_unexpected" });
      }
    }

    emit({
      type: "done",
      warnings,
      // Top-level normalized/audioStatus so the orchestrator reads them off the
      // flat event (no nested-preflight parse). Mirrored inside `preflight` too.
      normalized,
      audioStatus,
      preflight: { videoCodec: pf.info.videoCodec, audioCodec, risky: pf.risky, normalized, audioStatus },
    });
    rl.close();
    process.exit(0);
  } catch (err) {
    if (controller.signal.aborted) {
      // Canceled by the orchestrator — not a failure.
      emit({ type: "canceled" });
      rl.close();
      process.exit(2);
    }
    const friendly = toUserFacingError(err);
    toStderr("[worker:cli] render failed:", (err as Error)?.message ?? String(err));
    emit({ type: "error", code: friendly.code, message: friendly.message });
    rl.close();
    process.exit(1);
  }
}

void main();
