/**
 * The local export service, driving REAL renders.
 *
 * This is the layer that spawns the shared render core as a child process, so
 * the things worth testing are the ones that only show up with a real process:
 * progress actually arrives, the output file actually exists, a cancel actually
 * stops it and cleans up, and — the bug this suite was written after — a cancel
 * that arrives BEFORE the child exists is still honoured.
 *
 * Requires `npm run build:bundle` (the render CLI). Skips with a clear message
 * if it hasn't been built, rather than failing for the wrong reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveFfmpegPaths } from "../src/main/ffmpeg-paths.ts";
import { ExportService } from "../src/main/export/service.ts";
import type { SerializedRenderRecipe } from "@/lib/firebase/schema";
import type { LocalExportProgress, LocalExportResult } from "@/lib/platform/types";

const DESKTOP_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const CLI = join(DESKTOP_ROOT, ".vite", "render-cli.mjs");
const paths = resolveFfmpegPaths({ nodeModulesDir: join(DESKTOP_ROOT, "node_modules") });
const dir = mkdtempSync(join(tmpdir(), "framevo-export-test-"));

test.after(() => rmSync(dir, { recursive: true, force: true }));

function fixture(seconds: number, name: string, size = "320x240"): string {
  const out = join(dir, name);
  if (existsSync(out)) return out;
  execFileSync(
    paths.ffmpeg,
    [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=size=${size}:rate=30:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", "-y", out,
    ],
    { timeout: 300_000 }
  );
  return out;
}

function recipe(sourceDuration: number): SerializedRenderRecipe {
  return {
    sourceWidth: 320,
    sourceHeight: 240,
    fps: 30,
    resolution: "720p",
    format: "YouTube 16:9",
    sourceDuration,
    moments: [
      {
        id: "zoom1",
        startTime: 0.5,
        endTime: 1.5,
        label: "",
        reason: "",
        focusRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
        effectType: "zoom",
      },
    ],
    effects: {
      autoZoom: 72,
      cursorSize: 50,
      cursorSmoothing: 65,
      zoomSpeed: 55,
      motionSensitivity: 70,
      clickHighlightSize: 60,
      clickHighlightStyle: "ring",
      verticalExport: false,
      clickHighlights: true,
      motionTracking: true,
      pacing: "moderate",
      targetPlatform: "youtube",
      defaultExportFormat: "YouTube 16:9",
    },
    sourceCrop: null,
    applyWatermark: false,
  } as SerializedRenderRecipe;
}

interface RunOutcome {
  progress: LocalExportProgress[];
  done?: LocalExportResult;
  failed?: { message: string; code?: string };
  canceled: boolean;
}

/** Run one export to a terminal state, optionally cancelling along the way. */
function run(
  service: ExportService,
  options: {
    jobId: string;
    sourcePath: string;
    outputPath: string;
    sourceDuration: number;
    cancelAfterMs?: number;
    cancelBeforeStart?: boolean;
  }
): Promise<RunOutcome> {
  return new Promise((resolvePromise) => {
    const outcome: RunOutcome = { progress: [], canceled: false };
    if (options.cancelBeforeStart) service.cancel(options.jobId);

    service.start(
      {
        jobId: options.jobId,
        projectTitle: "Test project",
        sourcePath: options.sourcePath,
        outputPath: options.outputPath,
        recipe: recipe(options.sourceDuration),
        encoder: "libx264",
        cliPath: CLI,
        ffmpegPath: paths.ffmpeg,
        ffprobePath: paths.ffprobe,
      },
      {
        onProgress: (p) => outcome.progress.push(p),
        onDone: (result) => {
          outcome.done = result;
          resolvePromise(outcome);
        },
        onFailed: (error) => {
          outcome.failed = error;
          resolvePromise(outcome);
        },
        onCanceled: () => {
          outcome.canceled = true;
          resolvePromise(outcome);
        },
      }
    );

    if (options.cancelAfterMs !== undefined) {
      setTimeout(() => service.cancel(options.jobId), options.cancelAfterMs);
    }
  });
}

test(
  "renders a real MP4 through the shared render core, reporting progress",
  { skip: existsSync(CLI) ? false : "run `npm run build:bundle` first" },
  async () => {
    const service = new ExportService();
    const output = join(dir, "rendered.mp4");
    const outcome = await run(service, {
      jobId: "renderjob01",
      sourcePath: fixture(2, "short.mp4"),
      outputPath: output,
      sourceDuration: 2,
    });

    assert.equal(outcome.failed, undefined, `failed: ${outcome.failed?.message}`);
    assert.equal(outcome.canceled, false);
    assert.ok(outcome.done, "a done event arrived");
    assert.equal(outcome.done!.encoder, "libx264");
    assert.ok(outcome.done!.sizeBytes > 1000, "the file has real content");
    assert.ok(existsSync(output));

    // Progress must actually move, and reach the rendering stage.
    assert.ok(outcome.progress.length > 1, "more than one progress event");
    assert.ok(
      outcome.progress.some((p) => p.stage === "rendering"),
      "reported the rendering stage"
    );
    assert.ok(
      outcome.progress.some((p) => p.progress > 0),
      "progress advanced past zero"
    );
    assert.equal(service.activeCount(), 0, "the job was released");
  }
);

test(
  "cancelling a running render stops it and removes the partial file",
  { skip: existsSync(CLI) ? false : "run `npm run build:bundle` first" },
  async () => {
    const service = new ExportService();
    const output = join(dir, "canceled.mp4");
    const outcome = await run(service, {
      jobId: "canceljob01",
      // Long enough that the cancel lands mid-render rather than after it.
      sourcePath: fixture(40, "long.mp4", "1280x720"),
      outputPath: output,
      sourceDuration: 40,
      cancelAfterMs: 1500,
    });

    assert.equal(outcome.canceled, true, "reported as canceled, not failed");
    assert.equal(outcome.done, undefined);
    assert.equal(existsSync(output), false, "no half-written file is left behind");
    assert.equal(service.activeCount(), 0);
  }
);

test(
  "a cancel that arrives before the child exists is still honoured",
  { skip: existsSync(CLI) ? false : "run `npm run build:bundle` first" },
  async () => {
    // The regression this guards: the renderer offers Cancel the moment the user
    // picks an output file, which is BEFORE `start` reaches the service. That
    // cancel used to hit an empty job map and be silently dropped — the export
    // then ran to completion after the user had stopped it.
    const service = new ExportService();
    const output = join(dir, "never-started.mp4");
    const outcome = await run(service, {
      jobId: "earlycancel1",
      sourcePath: fixture(2, "short.mp4"),
      outputPath: output,
      sourceDuration: 2,
      cancelBeforeStart: true,
    });

    assert.equal(outcome.canceled, true);
    assert.equal(outcome.done, undefined);
    assert.equal(existsSync(output), false, "nothing was rendered");
    assert.equal(service.activeCount(), 0, "no child process was spawned");
  }
);

test("a broken installation fails with a message instead of hanging", async () => {
  const service = new ExportService();
  const output = join(dir, "broken.mp4");
  const outcome = await new Promise<RunOutcome>((resolvePromise) => {
    const result: RunOutcome = { progress: [], canceled: false };
    service.start(
      {
        jobId: "brokencli01",
        projectTitle: "Test project",
        sourcePath: fixture(2, "short.mp4"),
        outputPath: output,
        recipe: recipe(2),
        encoder: "libx264",
        // Simulates a corrupted install: the render core isn't where it should be.
        cliPath: join(dir, "does-not-exist.mjs"),
        ffmpegPath: paths.ffmpeg,
        ffprobePath: paths.ffprobe,
      },
      {
        onProgress: (p) => result.progress.push(p),
        onDone: (done) => {
          result.done = done;
          resolvePromise(result);
        },
        onFailed: (error) => {
          result.failed = error;
          resolvePromise(result);
        },
        onCanceled: () => {
          result.canceled = true;
          resolvePromise(result);
        },
      }
    );
  });

  assert.ok(outcome.failed, "reported a failure");
  assert.equal(outcome.done, undefined);
  assert.ok(outcome.failed!.message.length > 0);
  // The message crosses into the renderer, so it must not leak a path.
  assert.equal(/[\\/]/.test(outcome.failed!.message), false, outcome.failed!.message);
  assert.equal(existsSync(output), false);
  assert.equal(service.activeCount(), 0);
});
