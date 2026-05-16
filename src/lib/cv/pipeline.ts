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
import { extractFrames, sampleFpsFor } from "./frame-extractor";
import { diffFrames } from "./frame-diff";
import { visualDensity } from "./visual-density";
import { detectScenes } from "./scene-detect";
import { detectInteractions } from "./interaction";
import { resample } from "./resample";

const BATCH_SIZE = 20;

/** Re-exported so callers can `catch` it without importing `./types`. */
export { CvAbortError, CvTaintedError } from "./types";

/**
 * Run the full client-side CV pass over a video element.
 *
 * @throws {CvAbortError}   if `opts.signal` aborts
 * @throws {CvTaintedError} if the video is cross-origin without CORS headers
 */
export async function runVisualAnalysis(
  video: HTMLVideoElement,
  opts: RunVisualAnalysisOptions = {}
): Promise<VisualAnalysis> {
  const startedAt = performance.now();
  const duration =
    opts.duration && Number.isFinite(opts.duration) && opts.duration > 0
      ? opts.duration
      : video.duration;

  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video duration is unknown — cannot run visual analysis.");
  }

  const fps = sampleFpsFor(duration);
  const expectedFrames = Math.max(1, Math.ceil(duration * fps));
  const report = (phase: CvProgress["phase"], done: number) =>
    opts.onProgress?.({ phase, done: Math.max(0, Math.min(1, done)) });

  const signals: RawFrameSignal[] = [];
  const blockDeltas: number[] = [];
  const times: number[] = [];

  let prevFrame: Uint8ClampedArray | null = null;
  let processed = 0;

  for await (const { t, frame } of extractFrames(video, duration, opts.signal)) {
    if (opts.signal?.aborted) throw new CvAbortError();

    const density = visualDensity(frame);

    if (prevFrame) {
      const d = diffFrames(prevFrame, frame);
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

  // Click-like interaction inference over the motion sequence.
  const motionSeq = signals.map((s) => s.motionIntensity);
  const clickEvents = detectInteractions(motionSeq, times);

  report("resampling", 0.97);
  const visualAnalysis = resample({
    signals,
    duration,
    sceneChanges,
    clickEvents,
    computeMs: performance.now() - startedAt,
  });

  report("resampling", 1);
  return visualAnalysis;
}
