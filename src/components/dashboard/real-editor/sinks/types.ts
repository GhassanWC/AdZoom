"use client";

import type { ExportContainer } from "../export-format";

/**
 * An export "sink" — the final encode/mux step of `renderProjectClientSide`,
 * abstracted so the container is just a choice of implementation. The render
 * loop (cuts, speed, Canvas Fit, source crop, camera, vignette, watermark,
 * audio mixing) builds one `outputStream` (canvas video + mixed audio) and feeds
 * it to a sink; the sink decides how it becomes a file.
 *
 *   • `WebmRecorderSink` — `MediaRecorder` (VP9/VP8 + Opus). Reliable default.
 *   • `Mp4WebCodecsSink` — `MediaStreamTrackProcessor` → `VideoEncoder` (H.264) +
 *     `AudioEncoder` (AAC) → `mp4-muxer`. Replaces Chrome's unstable
 *     MediaRecorder MP4 muxer.
 *
 * `pause()`/`resume()` mirror the existing cut logic (which paused the recorder
 * while seeking past a cut so the skipped span is never captured). `stop()`
 * finalizes and resolves `done`; `dispose()` is a hard, blob-less teardown for
 * cancel/error paths. All four are idempotent.
 */
export interface ExportSink {
  readonly container: ExportContainer;
  /** Container MIME of the produced blob (e.g. "video/webm", "video/mp4"). */
  readonly mimeType: string;
  /** Video codec actually used (diagnostics / logs). */
  readonly videoCodec: string;
  /**
   * Resolves with the encoded blob after `stop()` + finalize; REJECTS (with an
   * `ExportError`) on a fatal encode/record error. Awaited once by the renderer.
   */
  readonly done: Promise<Blob>;
  /** Begin capturing/encoding. MAY throw synchronously (caller tags it `recorder`). */
  start(): void;
  /** Cut-seek: stop accepting frames so the skipped span is removed. Idempotent. */
  pause(): void;
  /** Cut-seek finished: resume accepting frames. Idempotent. */
  resume(): void;
  /** Finalize and resolve `done`. Idempotent. */
  stop(): void;
  /** Hard teardown with no blob — cancel/error cleanup. Idempotent. */
  dispose(): void;
}
