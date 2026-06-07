import type { VisualAnalysis } from "../../firebase/schema";

/**
 * The CV engine abstraction. Both the WebCodecs engine (primary) and the
 * hidden-`<video>` engine (fallback) satisfy this interface, so the chunk
 * orchestrator is engine-agnostic — promoting WebCodecs is a selection change,
 * not an orchestration rewrite.
 */

export type CvEngineKind = "webcodecs" | "hidden-video";

/**
 * Resolved video source for an engine. WebCodecs needs the raw bytes (to demux
 * + decode); the hidden-video engine needs a playable URL.
 */
export interface CvSource {
  /** Original video URL (used by the hidden-video engine and as a byte source). */
  url: string;
  mimeType?: string;
}

export interface CvChunkRequest {
  /** Absolute window start (seconds). */
  startTime: number;
  /** Absolute window end (seconds). */
  endTime: number;
  /** Whole-video duration (seconds) — keeps fps + sample rate consistent. */
  duration: number;
  /** 0..1 within this chunk. */
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}

export interface CvChunkEngine {
  readonly kind: CvEngineKind;
  /**
   * Analyze one chunk window and return its WINDOW-LOCAL `VisualAnalysis`
   * (times relative to `startTime`). The orchestrator offsets it to absolute
   * time at merge.
   */
  analyzeChunk(req: CvChunkRequest): Promise<VisualAnalysis>;
  /** Release any held resources (hidden video element, workers, decoders). */
  dispose(): void;
}
