/**
 * Recording engine — `createRecordingEngine()` returns a stateful object that
 * owns three media streams (screen, mic, webcam), mixes audio via an
 * AudioContext, drives a MediaRecorder, and exposes a small event API.
 *
 * Design notes:
 *  - `prepare()` MUST be called from a user gesture (button click). Browsers
 *    gate `getDisplayMedia()` and `getUserMedia()` on direct user activation.
 *  - `start()` and `stop()` are async because we wait for the recorder's first
 *    chunk and final blob, respectively.
 *  - The webcam stream is captured but never piped into the recorder — it's
 *    held for live PiP preview only. We compose the webcam into the final
 *    render at export time (later phase). For v1 the recorded artifact is
 *    pure screen + mixed audio.
 */

import {
  classifyGetDisplayMediaError,
  classifyGetUserMediaError,
  pickRecordingMime,
  RecordingError,
  type Interaction,
  type RecordingEvent,
  type RecordingOptions,
  type RecordingResult,
  type RecordingState,
} from "./types";
import type { InteractionProvider } from "./interaction-provider";
import { createBrowserInteractionProvider } from "./browser-interaction-provider";

/**
 * `getDisplayMedia` options that aren't in the stock `lib.dom.d.ts` yet.
 * Chrome 107+ honors these — most importantly `selfBrowserSurface: "include"`,
 * which surfaces the current tab as a pickable source.
 */
type ExtendedDisplayMediaOptions = DisplayMediaStreamOptions & {
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  systemAudio?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
};

interface InternalState {
  state: RecordingState;
  screen: MediaStream | null;
  webcam: MediaStream | null;
  mic: MediaStream | null;
  /** The audio track that ends up on the recorder (mic + maybe sys audio). */
  mixedAudioTrack: MediaStreamTrack | null;
  /** The stream wired into MediaRecorder (screen video + mixedAudioTrack). */
  recorderStream: MediaStream | null;
  recorder: MediaRecorder | null;
  audioCtx: AudioContext | null;
  analyser: AnalyserNode | null;
  chunks: Blob[];
  mime: string;
  startedAt: number;
  pausedAt: number;
  totalPausedMs: number;
  width: number;
  height: number;
  /** Bound handler to unregister on the screen video track's "ended" event. */
  screenEndHandler: (() => void) | null;
  tickInterval: ReturnType<typeof setInterval> | null;
  micLevel: number;
  /**
   * "tab" when the picked source is the AdZoom tab itself (events here are
   * authoritative). "external" for any other surface — events are kept but
   * downstream marks them as not-the-recorded-surface.
   */
  interactionScope: "tab" | "external";
}

export interface CreateRecordingEngineOptions {
  /**
   * Source of real interaction events. Defaults to a browser DOM provider.
   * Swap in `createElectronSystemInteractionProvider()` (future) for OS-wide
   * capture without touching any other code.
   */
  interactionProvider?: InteractionProvider;
}

export interface RecordingEngine {
  /** Pull-style state read; events fire as it changes. */
  getState(): RecordingState;
  getScreenStream(): MediaStream | null;
  getWebcamStream(): MediaStream | null;
  /** Smoothed 0..1 mic level — call inside requestAnimationFrame for UI. */
  getMicLevel(): number;
  /** Seconds since `start()` minus paused time. */
  getElapsedSeconds(): number;

  /** Request streams + create the recorder. Throws RecordingError on failure. */
  prepare(opts: RecordingOptions): Promise<{ width: number; height: number }>;
  /** Begin recording. Must be called after `prepare()` resolved. */
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  /** Stop and return the finalized blob. */
  stop(): Promise<RecordingResult>;
  /** Tear everything down. Safe to call from any state. */
  cancel(): void;

  on(listener: (event: RecordingEvent) => void): () => void;
}

export function createRecordingEngine(
  opts: CreateRecordingEngineOptions = {}
): RecordingEngine {
  const interactionProvider: InteractionProvider =
    opts.interactionProvider ?? createBrowserInteractionProvider();

  const s: InternalState = {
    state: "idle",
    screen: null,
    webcam: null,
    mic: null,
    mixedAudioTrack: null,
    recorderStream: null,
    recorder: null,
    audioCtx: null,
    analyser: null,
    chunks: [],
    mime: "",
    startedAt: 0,
    pausedAt: 0,
    totalPausedMs: 0,
    width: 0,
    height: 0,
    screenEndHandler: null,
    tickInterval: null,
    micLevel: 0,
    interactionScope: "tab",
  };

  const listeners = new Set<(e: RecordingEvent) => void>();
  const emit = (e: RecordingEvent) => listeners.forEach((l) => l(e));

  const setState = (next: RecordingState) => {
    if (s.state === next) return;
    s.state = next;
    emit({ type: "state", state: next });
  };

  const sampleMic = () => {
    if (!s.analyser) return;
    const buf = new Uint8Array(s.analyser.frequencyBinCount);
    s.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    // Light exponential smoothing — keeps the meter calm.
    s.micLevel = s.micLevel * 0.6 + Math.min(1, rms * 2.5) * 0.4;
  };

  const getElapsed = (): number => {
    if (s.startedAt === 0) return 0;
    const now = s.state === "paused" ? s.pausedAt : Date.now();
    return Math.max(0, (now - s.startedAt - s.totalPausedMs) / 1000);
  };

  const startTicker = () => {
    if (s.tickInterval) return;
    s.tickInterval = setInterval(() => {
      sampleMic();
      emit({
        type: "tick",
        tick: { elapsedSeconds: getElapsed(), micLevel: s.micLevel },
      });
    }, 100);
  };

  const stopTicker = () => {
    if (s.tickInterval) {
      clearInterval(s.tickInterval);
      s.tickInterval = null;
    }
  };

  const teardown = () => {
    stopTicker();
    if (s.recorder && s.recorder.state !== "inactive") {
      try {
        s.recorder.stop();
      } catch {
        /* ignore */
      }
    }
    s.recorder = null;

    const stopStream = (stream: MediaStream | null) => {
      if (!stream) return;
      stream.getTracks().forEach((t) => t.stop());
    };
    if (s.screen && s.screenEndHandler) {
      const v = s.screen.getVideoTracks()[0];
      v?.removeEventListener("ended", s.screenEndHandler);
    }
    stopStream(s.screen);
    stopStream(s.webcam);
    stopStream(s.mic);
    stopStream(s.recorderStream);

    s.screen = null;
    s.webcam = null;
    s.mic = null;
    s.mixedAudioTrack = null;
    s.recorderStream = null;
    s.screenEndHandler = null;

    if (s.audioCtx) {
      s.audioCtx.close().catch(() => {});
      s.audioCtx = null;
    }
    s.analyser = null;
    s.chunks = [];
    s.micLevel = 0;
    s.startedAt = 0;
    s.pausedAt = 0;
    s.totalPausedMs = 0;
  };

  const prepare: RecordingEngine["prepare"] = async (opts) => {
    if (s.state !== "idle" && s.state !== "stopped" && s.state !== "error") {
      throw new RecordingError("unknown", "Engine is already prepared.");
    }
    setState("preparing");

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
      setState("error");
      throw new RecordingError(
        "no_display_media",
        "This browser doesn't support screen capture."
      );
    }

    // 1. Mic + webcam FIRST — sequentially, so the user resolves these prompts
    // before the screen picker appears. Otherwise the OS "Sharing your screen"
    // indicator turns on while mic/webcam prompts are still pending, and any
    // "Stop sharing" click during that gap produces no recorded blob.
    //
    // Denial falls through gracefully (user-chosen behavior): the toggle stays
    // on but the stream is omitted. We classify the error for richer logs.
    if (opts.mic) {
      try {
        s.mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        console.warn("[recording]", classifyGetUserMediaError(err, "microphone"));
      }
    }
    if (opts.webcam) {
      try {
        s.webcam = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (err) {
        console.warn("[recording]", classifyGetUserMediaError(err, "webcam"));
      }
    }

    // 2. Screen capture — LAST, so the picker is the final await before
    // `recorder.start()` and the dead window between "user sees Sharing
    // indicator" and "recorder is actually capturing" collapses to a few
    // synchronous lines (mixer setup + MediaRecorder ctor).
    //
    // `selfBrowserSurface: "include"` is what makes the current Chrome tab
    // show up in the picker; without it the user can't capture the tab
    // they're running AdZoom in. `surfaceSwitching` and `monitorTypeSurfaces`
    // are belt-and-suspenders: tell Chrome to surface every source type it
    // can. `systemAudio` mirrors the user's toggle.
    const constraints: ExtendedDisplayMediaOptions = {
      video: {
        frameRate: { ideal: 30, max: 60 },
      },
      // Browsers only honor this on certain source types; harmless otherwise.
      audio: opts.systemAudio,
      selfBrowserSurface: "include",
      surfaceSwitching: "include",
      systemAudio: opts.systemAudio ? "include" : "exclude",
      monitorTypeSurfaces: "include",
    };
    try {
      s.screen = await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (err) {
      teardown();
      setState("idle");
      throw classifyGetDisplayMediaError(err);
    }

    const screenVideo = s.screen.getVideoTracks()[0];
    if (!screenVideo) {
      teardown();
      setState("error");
      throw new RecordingError("no_display_media", "No video track in screen capture.");
    }
    const settings = screenVideo.getSettings() as MediaTrackSettings & {
      displaySurface?: "monitor" | "window" | "browser";
    };
    s.width = settings.width ?? 1920;
    s.height = settings.height ?? 1080;

    // Decide whether real input events are authoritative for this take.
    // displaySurface === "browser" means the user picked a tab. We can't tell
    // *which* tab without CaptureController (Chrome 116+) but if the picked
    // tab dimensions match our viewport, it's almost certainly ours.
    // Anything else (monitor, window) is definitely external.
    if (settings.displaySurface === "browser") {
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const dimsMatch =
        Math.abs((settings.width ?? 0) - viewportW) <= Math.max(64, viewportW * 0.1) &&
        Math.abs((settings.height ?? 0) - viewportH) <= Math.max(64, viewportH * 0.1);
      s.interactionScope = dimsMatch ? "tab" : "external";
    } else {
      s.interactionScope = "external";
    }

    // If the user clicks the browser's "Stop sharing" button, we get an
    // `ended` event on the video track. Fold that into the normal stop path
    // — the result fires via the `result` event, so listeners get it even
    // though nobody awaited the returned promise here.
    //
    // If the track ends BEFORE recording has begun (during the tiny
    // mixer+recorder construction window after the picker resolves), surface
    // a typed error instead of silently dropping back to idle — otherwise
    // the user sees nothing happen and can't tell why.
    s.screenEndHandler = () => {
      if (s.state === "recording" || s.state === "paused") {
        void stop().catch(() => {});
      } else if (s.state === "preparing" || s.state === "ready") {
        emit({
          type: "error",
          error: new RecordingError(
            "recorder_failed",
            "Screen sharing stopped before recording began."
          ),
        });
        teardown();
        setState("idle");
      } else {
        teardown();
        setState("idle");
      }
    };
    screenVideo.addEventListener("ended", s.screenEndHandler);

    // 3. Audio mixing — mic + system audio (if any) into one destination track.
    const sysAudio = s.screen.getAudioTracks();
    const hasMic = !!s.mic;
    const hasSys = sysAudio.length > 0;
    if (hasMic || hasSys) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      s.audioCtx = new Ctx();
      const dest = s.audioCtx.createMediaStreamDestination();

      if (hasMic && s.mic) {
        const src = s.audioCtx.createMediaStreamSource(s.mic);
        src.connect(dest);
        s.analyser = s.audioCtx.createAnalyser();
        s.analyser.fftSize = 1024;
        src.connect(s.analyser);
      }
      if (hasSys) {
        const sysStream = new MediaStream(sysAudio);
        const src = s.audioCtx.createMediaStreamSource(sysStream);
        src.connect(dest);
      }

      s.mixedAudioTrack = dest.stream.getAudioTracks()[0] ?? null;
    }

    // 4. Build the stream that goes to MediaRecorder: screen video + mixed audio.
    const recorderTracks: MediaStreamTrack[] = [screenVideo];
    if (s.mixedAudioTrack) recorderTracks.push(s.mixedAudioTrack);
    s.recorderStream = new MediaStream(recorderTracks);

    // 5. Pick a supported MIME and wire the recorder.
    s.mime = pickRecordingMime();
    try {
      s.recorder = new MediaRecorder(s.recorderStream, {
        mimeType: s.mime,
        videoBitsPerSecond: 6_000_000,
        audioBitsPerSecond: 128_000,
      });
    } catch (err) {
      teardown();
      setState("error");
      throw new RecordingError(
        "no_supported_mime",
        "No MediaRecorder MIME type works in this browser.",
        err
      );
    }

    s.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) s.chunks.push(e.data);
    };
    s.recorder.onerror = (e) => {
      emit({
        type: "error",
        error: new RecordingError("recorder_failed", "Recorder failed mid-take.", e),
      });
      setState("error");
    };

    setState("ready");
    return { width: s.width, height: s.height };
  };

  const start: RecordingEngine["start"] = async () => {
    if (s.state !== "ready") {
      throw new RecordingError("unknown", "prepare() must be called first.");
    }
    s.chunks = [];
    s.startedAt = Date.now();
    s.totalPausedMs = 0;
    // Start the interaction provider on the same clock as the recorder so
    // event timestamps line up with the video. `performance.now()` is the
    // monotonic reference; the provider subtracts this from each event ts.
    interactionProvider.start(performance.now());
    // Emit chunks every second so we can recover something even if the page
    // is closed mid-recording.
    s.recorder!.start(1000);
    startTicker();
    setState("recording");
  };

  const pause: RecordingEngine["pause"] = () => {
    if (s.state !== "recording" || !s.recorder) return;
    s.recorder.pause();
    interactionProvider.pause();
    s.pausedAt = Date.now();
    setState("paused");
  };

  const resume: RecordingEngine["resume"] = () => {
    if (s.state !== "paused" || !s.recorder) return;
    s.totalPausedMs += Date.now() - s.pausedAt;
    s.pausedAt = 0;
    s.recorder.resume();
    interactionProvider.resume();
    setState("recording");
  };

  const stop: RecordingEngine["stop"] = () => {
    return new Promise<RecordingResult>((resolve, reject) => {
      if (!s.recorder || (s.state !== "recording" && s.state !== "paused")) {
        reject(new RecordingError("unknown", "Nothing to stop."));
        return;
      }
      let settled = false;
      const finalize = async () => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimer);
        // Snapshot everything BEFORE teardown nukes the internal state.
        const durationSeconds = getElapsed();
        const width = s.width;
        const height = s.height;
        const mimeType = s.mime;
        const interactionScope = s.interactionScope;
        const blob = new Blob(s.chunks, { type: mimeType });
        // Drain the interaction provider before tearing down. If the surface
        // was external we still keep the events around (they describe what
        // the user did *inside AdZoom* during recording) but mark the scope
        // so the analyzer doesn't trust them as the recorded surface.
        let interactions: Interaction[] = [];
        try {
          interactions = await interactionProvider.stop();
        } catch {
          interactions = [];
        }
        const result: RecordingResult = {
          blob,
          mimeType,
          durationSeconds,
          width,
          height,
          interactions,
          interactionScope,
        };
        teardown();
        setState("stopped");
        // Fire the event so any subscriber (the global provider) can pick the
        // result up — even when nobody awaited the returned promise (e.g. the
        // browser's own "Stop sharing" path).
        emit({ type: "result", result });
        resolve(result);
      };

      s.recorder.onstop = () => {
        void finalize();
      };
      try {
        // Force any buffered data out before we transition to inactive.
        s.recorder.requestData();
      } catch {
        /* some browsers reject requestData on stopped/inactive recorders */
      }
      try {
        s.recorder.stop();
      } catch (err) {
        settled = true;
        reject(
          new RecordingError("recorder_failed", "Failed to stop recorder.", err)
        );
        return;
      }
      // Safety net: if `onstop` never fires (some browsers misbehave on very
      // short clips), finalize anyway after a beat with whatever chunks we
      // collected. Better a short blob than a wedged promise.
      const safetyTimer = setTimeout(() => {
        void finalize();
      }, 1500);
    });
  };

  const cancel: RecordingEngine["cancel"] = () => {
    // Make sure the provider's DOM listeners are detached if cancel is called
    // mid-recording. `stop()` returns a promise we don't need here.
    void interactionProvider.stop().catch(() => {});
    teardown();
    setState("idle");
  };

  const on: RecordingEngine["on"] = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    getState: () => s.state,
    getScreenStream: () => s.screen,
    getWebcamStream: () => s.webcam,
    getMicLevel: () => s.micLevel,
    getElapsedSeconds: () => getElapsed(),
    prepare,
    start,
    pause,
    resume,
    stop,
    cancel,
    on,
  };
}
