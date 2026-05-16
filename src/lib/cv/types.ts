/**
 * Internal working types for the client-side computer-vision pipeline.
 *
 * These are the *dense*, full-resolution signals produced per sampled frame.
 * `resample.ts` compresses them into the compact `VisualAnalysis` that gets
 * persisted to Firestore.
 */

/** Downscale resolution every frame is reduced to before analysis. */
export const FRAME_W = 128;
export const FRAME_H = 72;

/** Motion-centroid grid — 8×8 cells over the downscaled frame. */
export const GRID_COLS = 8;
export const GRID_ROWS = 8;
export const GRID_CELLS = GRID_COLS * GRID_ROWS;

/** Frames sampled per second of video (drops to 2 for long videos). */
export const SAMPLE_FPS = 4;
export const LONG_VIDEO_SECONDS = 360; // >6 min → 2 fps
export const SAMPLE_FPS_LONG = 2;

/** A single grayscale frame at FRAME_W × FRAME_H, one byte per pixel. */
export type GrayFrame = Uint8ClampedArray;

/** Normalized motion hotspot (0..1 within the frame). */
export interface Centroid {
  x: number;
  y: number;
}

/** Per-sampled-frame signal, full resolution (pre-downsample). */
export interface RawFrameSignal {
  /** Actual `video.currentTime` after the seek settled (seconds). */
  t: number;
  /** Mean absolute grayscale delta vs the previous frame (0..1). */
  meanDelta: number;
  /** Cheap pixel-similarity proxy = 1 - meanDelta (0..1). NOT true SSIM. */
  ssim: number;
  /** Fraction of pixels whose delta exceeded the motion threshold (0..1). */
  motionIntensity: number;
  /** Edge-energy estimate of how busy this frame is (0..1). */
  visualDensity: number;
  /** True if this frame is a detected scene cut. */
  sceneChange: boolean;
  /** Motion-weighted hotspot, or null if the frame was effectively static. */
  centroid: Centroid | null;
  /** 8×8 per-cell mean abs delta, row-major (0..1 each). */
  gridDelta: Float32Array;
}

/** Progress callback payload for the pipeline. */
export interface CvProgress {
  phase: "decoding" | "analyzing" | "resampling";
  /** 0..1 overall progress. */
  done: number;
}

export interface RunVisualAnalysisOptions {
  /** Video duration in seconds (from project metadata; falls back to video.duration). */
  duration?: number;
  onProgress?: (p: CvProgress) => void;
  signal?: AbortSignal;
}

/** Thrown when the pipeline is aborted via an AbortSignal. */
export class CvAbortError extends Error {
  constructor() {
    super("Visual analysis aborted");
    this.name = "CvAbortError";
  }
}

/** Thrown when the canvas is tainted (cross-origin video without CORS). */
export class CvTaintedError extends Error {
  constructor() {
    super("Video frames are not readable (canvas tainted — missing CORS headers)");
    this.name = "CvTaintedError";
  }
}
