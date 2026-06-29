/**
 * Shared types + metadata resolver for the Framevo Remotion composition.
 *
 * This file is imported by BOTH the Next.js editor (the @remotion/player preview)
 * AND the server worker's Remotion bundle, so it must stay DOM/Remotion-only:
 * NO `server-only`, NO `next/*`, NO node imports. `buildRenderRecipe` and the
 * timeline/camera helpers it pulls in are all pure TS (verified), so they bundle
 * cleanly under Remotion's webpack.
 */
import type { SerializedRenderRecipe } from "@/lib/firebase/schema";
import { buildRenderRecipe } from "@/lib/render/recipe";

/** Global audio mode for the export. "source" keeps the recording's audio
 *  (per-section speed `audioMode:"mute"` still mutes those ranges); "muted"
 *  silences the whole export. */
export type FramevoAudioMode = "source" | "muted";

/**
 * Input props for `<FramevoComposition>`. MUST be JSON-serializable for SSR.
 * `recipe` is the exact `SerializedRenderRecipe` already stored on the export-job
 * doc (so preview + export compile identically via `buildRenderRecipe`). `src` is
 * the video source for `<OffthreadVideo>` — a `file://` path in the worker, a URL
 * (or object URL) in the browser preview.
 */
// NOTE: a `type` alias (not `interface`) so it satisfies Remotion's
// `Record<string, unknown>` inputProps constraint (interfaces lack an implicit
// index signature; type aliases get one for this assignability check).
export type FramevoCompositionProps = {
  recipe: SerializedRenderRecipe;
  src: string;
  audioMode?: FramevoAudioMode;
};

/** Composition id registered in `Root.tsx` and selected by the worker. */
export const FRAMEVO_COMPOSITION_ID = "Framevo";

/**
 * Derive Remotion composition metadata (size/fps/duration) from the recipe.
 * Used by `<Composition calculateMetadata>` so ONE composition adapts to every
 * job's output canvas + length. Mirrors the recipe's resolved `canvasW/canvasH`,
 * `fps`, and cut/speed-aware `outputDuration`.
 */
export function resolveFramevoMetadata(props: FramevoCompositionProps): {
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
} {
  const recipe = buildRenderRecipe({ ...props.recipe, debugBorders: false });
  const fps = recipe.fps;
  return {
    fps,
    width: recipe.canvasW,
    height: recipe.canvasH,
    durationInFrames: Math.max(1, Math.round(recipe.outputDuration * fps)),
  };
}
