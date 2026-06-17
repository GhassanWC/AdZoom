"use client";

import { ExportError, describeError } from "../export-error";
import type { ExportSink } from "./types";

/**
 * WebM sink — the reliable default. Wraps the (battle-tested) `MediaRecorder`
 * path verbatim: audio+video construction with a video-only fallback, the
 * data/stop/error handlers, the mid-record track-death probes, and the
 * pause/resume cut hooks. The container is WebM only — MP4 via MediaRecorder is
 * the unstable path that produced the production `EncodingError`, and is handled
 * by `Mp4WebCodecsSink` instead.
 */
export interface WebmSinkOptions {
  outputStream: MediaStream;
  /** A MediaRecorder-supported WebM mime (from `pickWebmMime`). */
  mimeType: string;
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  /** Called if the audio track had to be dropped (video-only fallback). */
  onAudioDropped?: () => void;
  /** Source playhead getter — for mid-record track-death diagnostics. */
  currentTime?: () => number;
  /** Audio acquisition path (diagnostics). */
  audioPath?: string;
}

export function createWebmSink(opts: WebmSinkOptions): ExportSink {
  const { outputStream, mimeType, videoBitsPerSecond, audioBitsPerSecond } = opts;

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(outputStream, {
      mimeType,
      videoBitsPerSecond,
      audioBitsPerSecond,
    });
  } catch (err) {
    // Constructing WITH audio was rejected — degrade to a video-only file so the
    // user still gets an export, and signal that it'll be silent.
    console.error(
      "[export-recorder] rejected the audio+video stream; retrying video only",
      describeError(err)
    );
    for (const t of outputStream.getAudioTracks()) outputStream.removeTrack(t);
    opts.onAudioDropped?.();
    try {
      recorder = new MediaRecorder(outputStream, { mimeType, videoBitsPerSecond });
    } catch (err2) {
      for (const t of outputStream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
      throw new ExportError(
        "recorder",
        "This browser couldn't start a video recorder for the export. Try Chrome or Edge.",
        { cause: err2, detail: { mime: mimeType } }
      );
    }
  }

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  let settled = false;
  let resolveDone!: (b: Blob) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<Blob>((res, rej) => {
    resolveDone = (b) => {
      if (!settled) {
        settled = true;
        res(b);
      }
    };
    rejectDone = (e) => {
      if (!settled) {
        settled = true;
        rej(e);
      }
    };
  });
  void done.catch(() => {}); // avoid unhandled-rejection if torn down un-awaited

  recorder.onstop = () => resolveDone(new Blob(chunks, { type: mimeType }));
  recorder.onerror = (e) => {
    const domErr = (e as unknown as { error?: DOMException }).error;
    const detail = {
      name: domErr?.name,
      message: domErr?.message,
      audioPath: opts.audioPath,
      recorderState: recorder.state,
      videoTrackState: outputStream.getVideoTracks()[0]?.readyState,
      audioTrackState: outputStream.getAudioTracks()[0]?.readyState,
      at: opts.currentTime?.(),
    };
    console.error("[export-render-loop] MediaRecorder error", detail);
    rejectDone(
      new ExportError(
        "render",
        "The video recorder failed mid-export. This often means the source track stopped or the format isn't fully supported — try Chrome or Edge.",
        { cause: domErr, detail }
      )
    );
  };

  // Mid-record track-death probe — a recorded track going `ended` while
  // recording is the historical "MediaRecorder error" failure mode.
  outputStream.getAudioTracks()[0]?.addEventListener("ended", () => {
    if (recorder.state === "recording") {
      console.warn("[export] export audio track ENDED mid-record", {
        at: opts.currentTime?.(),
        path: opts.audioPath,
      });
    }
  });
  outputStream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (recorder.state === "recording") {
      console.warn("[export] export VIDEO track ENDED mid-record", {
        at: opts.currentTime?.(),
      });
    }
  });

  return {
    container: "webm",
    mimeType,
    videoCodec: mimeType,
    done,
    start() {
      // May throw a DOMException even though isTypeSupported passed — the caller
      // wraps this and tears the pipeline down.
      recorder.start(500);
    },
    pause() {
      if (recorder.state === "recording") {
        try {
          recorder.pause();
        } catch {
          /* ignore */
        }
      }
    },
    resume() {
      if (recorder.state === "paused") {
        try {
          recorder.resume();
        } catch {
          /* ignore */
        }
      }
    },
    stop() {
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
    },
    dispose() {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        /* ignore */
      }
    },
  };
}
