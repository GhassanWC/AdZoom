/**
 * The desktop export's recipe snapshot — pure, so it can be unit-tested against
 * the cloud and in-browser engines (see tests/desktop-export-parity.test.ts).
 *
 * This module contains NO rendering logic on purpose. It only assembles the
 * inputs `buildRenderRecipe` takes, in exactly the shape
 * `POST /api/export/cloud` stores on a cloud job. Everything downstream — the
 * geometry, the timeline map, which overlay draws when — is decided by the
 * shared render core, once, for every engine.
 */
import type {
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
  SerializedRenderRecipe,
  SourceCrop,
  VisualAnalysis,
} from "@/lib/firebase/schema";

export interface DesktopExportInput {
  projectId: string;
  projectTitle: string;
  /** Opaque local-media handle; the main process maps it to a validated path. */
  mediaId: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceDuration: number;
  moments: DetectedMoment[];
  effects: EffectsSettings;
  visualAnalysis?: VisualAnalysis;
  sourceCrop?: SourceCrop | null;
  applyWatermark: boolean;
  resolution: "720p" | "1080p" | "4K";
  fps: 30 | 60;
  format: ExportFormat;
}

/** Serialize the recipe inputs — byte-identical to what a cloud job stores. */
export function serializeRecipeInput(input: DesktopExportInput): SerializedRenderRecipe {
  return {
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    fps: input.fps,
    resolution: input.resolution,
    format: input.format,
    sourceDuration: input.sourceDuration,
    moments: input.moments,
    effects: input.effects,
    sourceCrop: input.sourceCrop ?? null,
    applyWatermark: input.applyWatermark,
    ...(input.visualAnalysis != null ? { visualAnalysis: input.visualAnalysis } : {}),
  };
}
