/**
 * FramevoComposition — the single Remotion composition shared by the editor's
 * @remotion/player preview and the server worker's renderMedia(). It compiles the
 * serialized recipe with `buildRenderRecipe` (the SAME function the browser
 * exporter uses) and stacks the layers in `composeFrame` order:
 *   black backdrop → Canvas-Fit background → video + camera (+ click highlight) → vignette.
 */
import { useMemo } from "react";
import { AbsoluteFill } from "remotion";
import { buildRenderRecipe } from "@/lib/render/recipe";
import { VideoLayer } from "./layers/VideoLayer";
import { Background, Vignette, ClickHighlightOverlay } from "./layers/EffectsLayer";
import type { FramevoCompositionProps } from "./types";

export function FramevoComposition({
  recipe,
  src,
  audioMode = "source",
}: FramevoCompositionProps): React.JSX.Element {
  const compiled = useMemo(
    () => buildRenderRecipe({ ...recipe, debugBorders: false }),
    [recipe]
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden" }}>
      <Background recipe={compiled} />
      <VideoLayer recipe={compiled} src={src} audioMode={audioMode}>
        <ClickHighlightOverlay recipe={compiled} />
      </VideoLayer>
      {compiled.effects.vignette && <Vignette recipe={compiled} />}
    </AbsoluteFill>
  );
}
