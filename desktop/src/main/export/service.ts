/**
 * The local export service.
 *
 * It runs the EXACT renderer the cloud runs: `services/export-worker`'s render
 * CLI, bundled to `resources/render-cli.js`, which calls `buildRenderRecipe` +
 * `composeFrame` on an @napi-rs/canvas context and pipes frames into FFmpeg.
 * There is no desktop-specific compositor, so preview / browser export / cloud
 * export / desktop export cannot drift: they all consume the same
 * `SerializedRenderRecipe`.
 *
 * The render runs in a CHILD PROCESS (never the renderer, never the main
 * process's event loop), so a 4K export cannot freeze the interface. The child
 * is Electron's own binary re-launched as plain Node (`ELECTRON_RUN_AS_NODE`),
 * which is how a packaged app gets a Node runtime without shipping a second
 * one — and it is the runtime @napi-rs/canvas is already loaded into.
 *
 * Protocol with the child (defined by the CLI): NDJSON events on stdout, human
 * logs on stderr, the literal line `cancel` on stdin to abort, exit codes
 * 0 = done / 1 = error / 2 = canceled.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SerializedRenderRecipe } from "@/lib/firebase/schema";
import type {
  EncoderId,
  LocalExportProgress,
  LocalExportResult,
  LocalExportStage,
} from "@/lib/platform/types";
import { logger, reportError } from "../logger";
import { encoderArgs } from "./encoders";

/** Quality dial — the same default the cloud render uses. */
export const DEFAULT_CRF = 20;
export const DEFAULT_PRESET = "medium";

export interface ExportJobSpec {
  jobId: string;
  projectTitle: string;
  /** Absolute path of the user's source video (main-process side only). */
  sourcePath: string;
  /** Absolute path the finished MP4 is written to. */
  outputPath: string;
  recipe: SerializedRenderRecipe;
  encoder: EncoderId;
  /** Absolute path of the bundled render CLI. */
  cliPath: string;
  ffmpegPath: string;
  ffprobePath: string;
}

export interface ExportCallbacks {
  onProgress(progress: LocalExportProgress): void;
  onDone(result: LocalExportResult): void;
  onFailed(error: { message: string; code?: string }): void;
  onCanceled(): void;
}

/** Map the CLI's stage names onto the four the UI shows. */
function toStage(name: string): LocalExportStage {
  switch (name) {
    case "decoding":
      return "preparing";
    case "rendering":
      return "rendering";
    case "encoding":
      return "encoding";
    case "merging":
    case "muxing-audio":
      return "finalizing";
    default:
      return "preparing";
  }
}

interface RunningJob {
  child: ChildProcess;
  tempDir: string;
  outputPath: string;
  canceled: boolean;
}

export class ExportService {
  private readonly jobs = new Map<string, RunningJob>();
  /**
   * Jobs cancelled BEFORE their child process existed.
   *
   * The renderer shows a cancellable "preparing" state the moment the user
   * picks an output file, but `start` only reaches this service after the save
   * dialog resolves and the media is re-validated. A cancel in that window used
   * to hit an empty job map and be dropped — the user pressed Cancel and the
   * export completed anyway. Recording the intent here makes cancel truthful at
   * every point in the lifecycle.
   */
  private readonly canceledBeforeStart = new Set<string>();

  /** Jobs currently rendering — used to refuse a duplicate start. */
  isRunning(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  activeCount(): number {
    return this.jobs.size;
  }

  start(spec: ExportJobSpec, callbacks: ExportCallbacks): void {
    if (this.canceledBeforeStart.delete(spec.jobId)) {
      logger.info("export canceled before it started", { jobId: spec.jobId });
      callbacks.onCanceled();
      return;
    }
    if (this.jobs.has(spec.jobId)) {
      callbacks.onFailed({ message: "That export is already running.", code: "duplicate" });
      return;
    }

    // Everything the child needs (job spec + any scratch) lives in ONE temp dir
    // so cleanup is a single recursive delete on every exit path.
    const tempDir = mkdtempSync(join(tmpdir(), "framevo-export-"));
    const specPath = join(tempDir, "job.json");

    const childSpec = {
      jobId: spec.jobId,
      sourcePath: spec.sourcePath,
      outputPath: spec.outputPath,
      serializedRecipe: spec.recipe,
      crf: DEFAULT_CRF,
      preset: DEFAULT_PRESET,
      videoEncoder: {
        codec: spec.encoder,
        args: encoderArgs(spec.encoder, DEFAULT_CRF, DEFAULT_PRESET),
      },
      // The source is a file the user picked, not an uploaded blob: normalizing
      // is what makes an odd container (MOV with multi-track audio, VFR screen
      // capture) render correctly, so keep the cloud's behaviour.
      normalizeEnabled: true,
    };
    writeFileSync(specPath, JSON.stringify(childSpec), "utf8");

    const child = spawn(process.execPath, [spec.cliPath, specPath], {
      // ELECTRON_RUN_AS_NODE turns Electron into a plain Node process — no
      // Chromium, no window, and the ABI @napi-rs/canvas is built against.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        FRAMEVO_FFMPEG_PATH: spec.ffmpegPath,
        FRAMEVO_FFPROBE_PATH: spec.ffprobePath,
        // The child must not inherit a stale Sentry DSN — it reports through
        // the parent's already-redacted channel.
        FRAMEVO_SENTRY_DSN: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const job: RunningJob = { child, tempDir, outputPath: spec.outputPath, canceled: false };
    this.jobs.set(spec.jobId, job);

    const warnings: string[] = [];
    let failure: { message: string; code?: string } | null = null;
    let stage: LocalExportStage = "preparing";
    const startedAt = Date.now();
    let stdoutBuffer = "";
    let stderrTail = "";

    const emitProgress = (value: number) => {
      const clamped = Math.max(0, Math.min(1, value));
      const elapsed = Date.now() - startedAt;
      callbacks.onProgress({
        stage,
        progress: clamped,
        // ETA only once there is enough signal for it to mean anything.
        etaMs: clamped > 0.02 ? Math.round((elapsed / clamped) * (1 - clamped)) : undefined,
      });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let index: number;
      while ((index = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, index).trim();
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (!line) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // not NDJSON — ignore rather than fail the render
        }
        switch (event.type) {
          case "stage":
            stage = toStage(String(event.name));
            emitProgress(0);
            break;
          case "progress":
            emitProgress(Number(event.value ?? 0));
            break;
          case "warning":
            if (typeof event.message === "string") warnings.push(event.message);
            break;
          case "error":
            failure = {
              message: typeof event.message === "string" ? event.message : "The export failed.",
              code: typeof event.code === "string" ? event.code : undefined,
            };
            break;
          default:
            break;
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Renderer logs are verbose; keep only a bounded tail for diagnosis and
      // let the redacting logger scrub any paths before they hit disk.
      stderrTail = (stderrTail + chunk).slice(-4000);
    });

    child.on("error", (err) => {
      failure = { message: "Framevo couldn't start the export engine.", code: "spawn_failed" };
      reportError(err, { jobId: spec.jobId, phase: "spawn" });
    });

    child.on("close", (code) => {
      this.jobs.delete(spec.jobId);
      this.cleanup(tempDir);

      if (job.canceled || code === 2) {
        // A canceled render leaves a partial file behind — remove it so the
        // user never finds a half-written MP4 where their export should be.
        this.removeIfPresent(spec.outputPath);
        logger.info("export canceled", {
          jobId: spec.jobId,
          afterMs: Date.now() - startedAt,
        });
        callbacks.onCanceled();
        return;
      }
      if (code === 0 && !failure) {
        let sizeBytes = 0;
        try {
          sizeBytes = statSync(spec.outputPath).size;
        } catch {
          callbacks.onFailed({
            message: "The export finished but the file could not be found.",
            code: "missing_output",
          });
          return;
        }
        callbacks.onDone({
          outputId: spec.jobId,
          fileName: basename(spec.outputPath),
          sizeBytes,
          durationSec: (Date.now() - startedAt) / 1000,
          encoder: spec.encoder,
          warnings,
        });
        return;
      }

      this.removeIfPresent(spec.outputPath);
      const detail = failure ?? {
        message: "The export failed. Please try again.",
        code: `exit_${code}`,
      };
      logger.error("export failed", { jobId: spec.jobId, code: detail.code, tail: stderrTail.slice(-600) });
      callbacks.onFailed(detail);
    });

    logger.info("export started", {
      jobId: spec.jobId,
      encoder: spec.encoder,
      resolution: spec.recipe.resolution,
      fps: spec.recipe.fps,
      moments: spec.recipe.moments.length,
    });
  }

  /**
   * Ask the child to stop. The CLI aborts its ffmpeg processes and exits 2; if
   * it doesn't respond within the grace window it is killed outright, so cancel
   * always completes from the user's point of view.
   */
  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      // Not spawned yet (or already finished) — remember the intent so `start`
      // refuses to launch. Bounded, because an id that never starts would
      // otherwise linger for the life of the process.
      if (this.canceledBeforeStart.size > 32) this.canceledBeforeStart.clear();
      this.canceledBeforeStart.add(jobId);
      return;
    }
    job.canceled = true;
    try {
      job.child.stdin?.write("cancel\n");
    } catch {
      /* pipe already gone */
    }
    setTimeout(() => {
      if (this.jobs.has(jobId)) {
        logger.warn("export did not stop on request — killing", { jobId });
        try {
          job.child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }, 4000).unref?.();
  }

  /** Stop everything (app quit). */
  cancelAll(): void {
    for (const jobId of [...this.jobs.keys()]) this.cancel(jobId);
  }

  private cleanup(tempDir: string): void {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn("temp cleanup failed", { error: (err as Error).message });
    }
  }

  private removeIfPresent(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      /* nothing to remove */
    }
  }
}
