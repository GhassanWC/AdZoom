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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

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
import { normalizeSource } from "./ffmpeg.js";
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
}

async function main(): Promise<void> {
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
      throw new Error("preflight: source video could not be decoded");
    }

    // 2. Conditional normalization — risky source → worker-safe H.264 + AAC.
    let renderSource = spec.sourcePath;
    let audioDropped = !!spec.audioAlreadyDropped;
    let normalized = false;
    if (spec.normalizeEnabled && pf.risky) {
      emit({ type: "stage", name: "normalizing" });
      const normPath = join(dirname(spec.outputPath), "normalized.mp4");
      await normalizeSource({
        sourcePath: spec.sourcePath,
        outputPath: normPath,
        dropAudio: pf.needsAudioDrop,
        crf: spec.normalizeCrf ?? 18,
        preset: spec.normalizePreset ?? "veryfast",
        signal: controller.signal,
      });
      renderSource = normPath;
      normalized = true;
      if (pf.needsAudioDrop) audioDropped = true;
    }
    if (audioDropped) pushWarning(AUDIO_UNSUPPORTED_WARNING);

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
    emit({
      type: "done",
      warnings,
      preflight: { videoCodec: pf.info.videoCodec, audioCodec, risky: pf.risky, normalized },
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
