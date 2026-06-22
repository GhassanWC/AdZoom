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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { normalizeSource, probeSource, ffmpegBin } from "./ffmpeg.js";
import { toUserFacingError } from "./errors.js";
import type { SerializedRenderRecipe } from "@/lib/firebase/schema";

interface JobSpec {
  sourcePath: string;
  outputPath: string;
  serializedRecipe: SerializedRenderRecipe;
  crf?: number;
  preset?: string;
  normalizeCrf?: number;
  normalizePreset?: string;
  normalizeEnabled?: boolean;
  audioAlreadyDropped?: boolean;
  /** Chunked render: render ONLY this OUTPUT window [startSec, endSec) (see
   *  RenderOptions.chunk). Omitted ⇒ whole-video render (default). */
  chunk?: { startSec: number; endSec: number };
  /** "concat" ⇒ losslessly join `inputs` (rendered chunks) into `outputPath`. */
  mode?: "render" | "concat";
  /** concat mode: ordered chunk file paths to join. */
  inputs?: string[];
}

/**
 * Concat mode — losslessly join pre-rendered chunk MP4s (identical codecs/params)
 * into the final MP4 via ffmpeg's concat demuxer (`-c copy`, no re-encode).
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
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    child.stderr.on("data", (d: Buffer) => {
      tail = (tail + d.toString()).slice(-4000);
      const t = d.toString().trim();
      if (t) toStderr("[worker:concat]", t);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`concat_failed: ffmpeg exited ${code}: ${tail.trim().slice(-800)}`));
    });
  });
  emit({ type: "done", warnings: [], merged: inputs.length });
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

  const crf = spec.crf ?? 19;
  const preset = spec.preset ?? "veryfast";
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
    if (audioStatus === "removed") pushWarning(AUDIO_UNSUPPORTED_WARNING);

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
    // Only "preserved" means audio should be present (removed/none = silent by design).
    if (audioStatus === "preserved" && outProbe && !outProbe.hasAudio) {
      throw new Error(
        "audio_missing_after_render: render source has audio but final output has none"
      );
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
