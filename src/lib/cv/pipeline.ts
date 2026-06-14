/**
 * Computer-vision pipeline orchestrator.
 *
 * `runVisualAnalysis()` is the single entry point used by the editor. It pulls
 * grayscale frames from the `<video>`, diffs consecutive pairs, detects scene
 * cuts and click-like interactions, then resamples everything into the compact
 * `VisualAnalysis` persisted to Firestore.
 *
 * Everything runs on the main thread but is naturally cooperative: frame
 * extraction `await`s each seek, so the event loop is rarely blocked. We also
 * yield explicitly every BATCH_SIZE frames as a safety margin.
 */

import type { VisualAnalysis } from "../firebase/schema";
import {
  CvAbortError,
  type CvProgress,
  type RawFrameSignal,
  type RunVisualAnalysisOptions,
} from "./types";
import {
  extractFrames,
  sampleFpsFor,
  type ExtractedFrame,
} from "./frame-extractor";
import { diffFrames } from "./frame-diff";
import { visualDensity } from "./visual-density";
import { detectScenes } from "./scene-detect";
import { detectInteractions } from "./interaction";
import { detectRegions } from "./regions";
import {
  createCursorTracker,
  type CursorEstimate,
  type ChangeCluster,
} from "./cursor-track";
import { detectVisualInteractions } from "./visual-interactions";
import { resample, sampleRateFor } from "./resample";

const BATCH_SIZE = 20;

/** Re-exported so callers can `catch` it without importing `./types`. */
export { CvAbortError, CvTaintedError } from "./types";

/**
 * Engine-agnostic CV analysis. Consumes a stream of grayscale frames (produced
 * however the caller likes — by seeking a hidden `<video>`, or by decoding with
 * WebCodecs in a worker) and runs the full per-frame + post-processing pass,
 * returning a compact `VisualAnalysis`.
 *
 * Pure (no DOM): the frame *production* is the only engine-specific part, so
 * this function runs unchanged on the main thread (hidden-video engine) or
 * inside a Web Worker (WebCodecs engine).
 *
 * Windowing: when `startTime > 0` the produced `VisualAnalysis` is
 * WINDOW-LOCAL — every time is relative to `startTime` and the per-second
 * arrays are sized to the window. The orchestrator offsets it back to absolute
 * time at merge. `duration` is always the WHOLE-video duration so the fps and
 * sample rate stay consistent across chunks.
 */
export interface AnalyzeFrameStreamOptions {
  /** Whole-video duration (seconds) — drives fps + sample rate. */
  duration: number;
  /** Window start (absolute seconds). Default 0. */
  startTime?: number;
  /** Window end (absolute seconds). Default = duration. */
  endTime?: number;
  onProgress?: (p: CvProgress) => void;
  signal?: AbortSignal;
}

export async function analyzeFrameStream(
  frames: AsyncIterable<ExtractedFrame>,
  opts: AnalyzeFrameStreamOptions
): Promise<VisualAnalysis> {
  const startedAt = performance.now();
  const duration = opts.duration;
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video duration is unknown — cannot run visual analysis.");
  }
  const windowStart = Math.max(0, opts.startTime ?? 0);
  const windowEnd = Math.min(duration, opts.endTime ?? duration);
  const windowLen = Math.max(1 / sampleFpsFor(duration), windowEnd - windowStart);

  const fps = sampleFpsFor(duration);
  const expectedFrames = Math.max(1, Math.ceil(windowLen * fps));
  const report = (phase: CvProgress["phase"], done: number) =>
    opts.onProgress?.({ phase, done: Math.max(0, Math.min(1, done)) });

  const signals: RawFrameSignal[] = [];
  const blockDeltas: number[] = [];
  const times: number[] = [];
  // Visual editing engine (v3): per-frame cursor estimate + change clusters,
  // tracked incrementally so we never retain all detect frames.
  const cursors: CursorEstimate[] = [];
  const clusterSeq: ChangeCluster[][] = [];
  const tracker = createCursorTracker();

  let prevFrame: Uint8ClampedArray | null = null;
  let processed = 0;

  for await (const { t: absT, frame, detectFrame } of frames) {
    if (opts.signal?.aborted) throw new CvAbortError();

    // Localize to the window so the resampled arrays + sparse events are
    // window-relative (index 0 = the window's first second).
    const t = absT - windowStart;
    const density = visualDensity(frame);

    let centroid: RawFrameSignal["centroid"] = null;
    if (prevFrame) {
      const d = diffFrames(prevFrame, frame);
      centroid = d.centroid;
      signals.push({
        t,
        meanDelta: d.meanDelta,
        ssim: d.ssim,
        motionIntensity: d.motionIntensity,
        visualDensity: density,
        sceneChange: false, // filled in after the full pass
        centroid: d.centroid,
        gridDelta: d.gridDelta,
      });
      blockDeltas.push(d.blockMeanDelta);
    } else {
      // First frame has no predecessor — zeroed diff fields, real density.
      signals.push({
        t,
        meanDelta: 0,
        ssim: 1,
        motionIntensity: 0,
        visualDensity: density,
        sceneChange: false,
        centroid: null,
        gridDelta: new Float32Array(0),
      });
      blockDeltas.push(0);
    }
    times.push(t);

    // Cursor tracking (incremental) on the higher-res detect frame.
    const { cursor, clusters } = tracker.step(detectFrame, centroid);
    cursors.push(cursor);
    clusterSeq.push(clusters);

    prevFrame = frame;
    processed++;
    if (processed % BATCH_SIZE === 0) {
      report("decoding", processed / expectedFrames);
      // Cooperative yield — keep the UI responsive on slow-decode codecs.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (opts.signal?.aborted) throw new CvAbortError();
  report("analyzing", 0.9);

  // Scene detection over the illumination-tolerant block-delta sequence.
  const { sceneFlags, events: sceneChanges } = detectScenes(blockDeltas, times);
  for (let i = 0; i < signals.length; i++) signals[i].sceneChange = sceneFlags[i];

  // Click-like interaction inference over the motion sequence (legacy soft signal).
  const motionSeq = signals.map((s) => s.motionIntensity);
  const clickEvents = detectInteractions(motionSeq, times);

  // Visual editing engine: cursor-grounded clicks + UI regions (v3).
  const { inferredClicks, dwells } = detectVisualInteractions(
    cursors,
    clusterSeq,
    times,
    sceneChanges
  );
  const uiRegions = detectRegions({
    gridDeltas: signals.map((s) => s.gridDelta),
    times,
  });

  report("resampling", 0.97);
  const visualAnalysis = resample({
    signals,
    duration: windowLen,
    // Force the whole-video rate so windows merge cleanly.
    sampleRate: sampleRateFor(duration),
    sceneChanges,
    clickEvents,
    cursors,
    inferredClicks,
    dwells,
    uiRegions,
    computeMs: performance.now() - startedAt,
  });

  report("resampling", 1);
  return visualAnalysis;
}

/**
 * Run the full client-side CV pass over a video element (hidden-video engine).
 * Thin wrapper: produce frames by seeking, then `analyzeFrameStream`.
 *
 * @throws {CvAbortError}   if `opts.signal` aborts
 * @throws {CvTaintedError} if the video is cross-origin without CORS headers
 */
export async function runVisualAnalysis(
  video: HTMLVideoElement,
  opts: RunVisualAnalysisOptions = {}
): Promise<VisualAnalysis> {
  const duration =
    opts.duration && Number.isFinite(opts.duration) && opts.duration > 0
      ? opts.duration
      : video.duration;

  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video duration is unknown — cannot run visual analysis.");
  }

  const startTime = opts.startTime ?? 0;
  const endTime = opts.endTime ?? duration;

  const frames = extractFrames(video, duration, {
    signal: opts.signal,
    startTime,
    endTime,
    sourceCrop: opts.sourceCrop,
  });

  return analyzeFrameStream(frames, {
    duration,
    startTime,
    endTime,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });
}
