/**
 * The ISOLATED Editframe adapter (required-named `buildEditframeComposition`).
 *
 * It reuses Framevo's SHARED render core — `buildRenderRecipe` — with the exact
 * same inputs the export panel assembles for the cloud exporter, so the recipe
 * (and therefore every rendered pixel: cuts, speed, zoom, crop, captions,
 * overlays, callouts, transitions, highlights, blur, vignette, branding, the
 * timeline map, watermark) is byte-identical to the Cloud/Remotion output.
 *
 * It deliberately does NOT re-apply the layer/enabled gate: the caller passes
 * the SAME already-gated `moments` it hands the cloud exporter (`visibleMoments`
 * + clip materialization run upstream in the panel). Re-gating here would risk a
 * divergence from cloud — the whole point of this bridge is parity.
 *
 * Pure: no DOM, no mediabunny, no side effects — unit-testable against the cloud
 * recipe.
 */
import { buildRenderRecipe } from "@/lib/render/recipe";
import type {
  EditframePlan,
  EditframeProjectInput,
  EditframeTimelineInput,
} from "./types";

export function buildEditframeComposition(
  project: EditframeProjectInput,
  timeline: EditframeTimelineInput
): EditframePlan {
  const recipe = buildRenderRecipe({
    sourceWidth: project.width,
    sourceHeight: project.height,
    fps: timeline.fps,
    resolution: timeline.resolution,
    format: timeline.format,
    sourceDuration: timeline.sourceDuration,
    moments: timeline.moments,
    effects: project.effects,
    visualAnalysis: project.visualAnalysis,
    sourceCrop: project.sourceCrop ?? null,
    applyWatermark: project.applyWatermark,
    debugBorders: false,
  });

  return {
    sourceUrl: project.originalVideoUrl,
    projectId: project.id,
    projectTitle: project.title,
    resolution: timeline.resolution,
    fps: timeline.fps,
    recipe,
    outputFormat: timeline.outputFormat,
  };
}
