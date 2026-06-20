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
import { existsSync, readFileSync } from "node:fs";
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
      const norm = await normalizeSource({
        sourcePath: spec.sourcePath,
        outputPath: normPath,
        crf: spec.normalizeCrf ?? 18,
        preset: spec.normalizePreset ?? "veryfast",
        signal: controller.signal,
      });
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
