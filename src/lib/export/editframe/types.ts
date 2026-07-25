/**
 * Shared types for the Editframe BETA browser export engine.
 *
 * This engine is an ADDITIONAL, opt-in export path that renders every enabled
 * Framevo edit through Framevo's own shared compositor (`composeFrame`) and uses
 * Editframe's browser stack (`mediabunny`) purely as the H.264 decoder/encoder —
 * so the output matches the Cloud/Remotion export by construction. It never
 * touches the existing Cloud Run / Cloud Tasks / Remotion / Firestore-job
 * pipeline, and it deducts no billing/usage.
 *
 * Type-only module: safe to import anywhere (no DOM, no mediabunny).
 */
import type { RenderRecipe } from "@/lib/render/recipe";
import type {
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
  SourceCrop,
  VisualAnalysis,
} from "@/lib/firebase/schema";

/** Editframe beta exports at 720p or 1080p only (no 4K) — requirement #5. */
export type EditframeResolution = "720p" | "1080p";

/** Static, project-scoped inputs for `buildEditframeComposition`. */
export interface EditframeProjectInput {
  id: string;
  title: string;
  originalVideoUrl: string;
  /** Source (recording) pixel dimensions. */
  width: number;
  height: number;
  effects: EffectsSettings;
  sourceCrop?: SourceCrop | null;
  visualAnalysis?: VisualAnalysis;
  /**
   * Free-tier watermark. Derived from the plan tier for the beta (this path
   * makes no server permit call), and drawn by the shared `composeFrame`
   * watermark layer exactly like every other engine.
   */
  applyWatermark: boolean;
}

/** Timeline/output inputs for `buildEditframeComposition`. */
export interface EditframeTimelineInput {
  /**
   * Layer-gated + clip-materialized moments — the SAME array the panel hands the
   * cloud exporter (`serverInput.moments`). Passing the identical list is what
   * guarantees byte-for-byte parity, so the adapter must NOT re-gate them.
   */
  moments: DetectedMoment[];
  /** Full SOURCE duration in seconds (pre cuts/speed). */
  sourceDuration: number;
  resolution: EditframeResolution;
  fps: 30 | 60;
  format: ExportFormat;
  /** Human label for the job/UI, e.g. "9:16 · Fit · 1080p · 30fps". */
  outputFormat: string;
}

/** The isolated, serializable render spec the browser engine consumes. */
export interface EditframePlan {
  sourceUrl: string;
  projectId: string;
  projectTitle: string;
  resolution: EditframeResolution;
  fps: 30 | 60;
  /** Fully-resolved Framevo render recipe (dims, timeline map, camera/overlay inputs). */
  recipe: RenderRecipe;
  /** Human label for the job/UI. */
  outputFormat: string;
}

export interface EditframeProgress {
  /** 0..1 overall render progress. */
  percent: number;
  currentFrame: number;
  totalFrames: number;
  /** Rough remaining-time estimate in ms (once a few frames are timed). */
  etaMs?: number;
}
