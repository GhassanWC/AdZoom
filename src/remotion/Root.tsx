/**
 * Remotion bundle entry point. `bundle({ entryPoint: '@/remotion/Root.tsx' })`
 * (the worker) and the Remotion Studio both load this. ONE composition, sized +
 * timed per-job via `calculateMetadata` from the recipe in inputProps.
 *
 * `defaultProps` is a harmless placeholder so the Studio/`selectComposition` can
 * mount the component before real inputProps arrive (the worker always passes the
 * job's real recipe + src to `selectComposition`/`renderMedia`).
 */
import { Composition, registerRoot } from "remotion";
import { DEFAULT_EFFECTS_SETTINGS, type SerializedRenderRecipe } from "@/lib/firebase/schema";
import { FramevoComposition } from "./FramevoComposition";
import { FRAMEVO_COMPOSITION_ID, resolveFramevoMetadata, type FramevoCompositionProps } from "./types";

const PLACEHOLDER_RECIPE: SerializedRenderRecipe = {
  sourceWidth: 1920,
  sourceHeight: 1080,
  fps: 30,
  resolution: "1080p",
  format: "Source",
  sourceDuration: 1,
  moments: [],
  effects: DEFAULT_EFFECTS_SETTINGS,
  applyWatermark: false,
};

const PLACEHOLDER_PROPS: FramevoCompositionProps = {
  recipe: PLACEHOLDER_RECIPE,
  src: "",
  audioMode: "source",
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id={FRAMEVO_COMPOSITION_ID}
      component={FramevoComposition}
      durationInFrames={30}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={PLACEHOLDER_PROPS}
      calculateMetadata={({ props }: { props: FramevoCompositionProps }) => resolveFramevoMetadata(props)}
    />
  );
};

registerRoot(RemotionRoot);
