/**
 * FramevoComposition — the single Remotion composition shared by the editor's
 * @remotion/player preview and the server worker's renderMedia(). It compiles the
 * serialized recipe with `buildRenderRecipe` (the SAME function the browser
 * exporter uses) and stacks the layers in `composeFrame` order:
 *   black backdrop → Canvas-Fit background → video + camera (+ click highlight)
 *   → vignette → output overlays → watermark.
 */
import { useMemo } from "react";
import { AbsoluteFill } from "remotion";
import { buildRenderRecipe } from "@/lib/render/recipe";
import { VideoLayer } from "./layers/VideoLayer";
import {
  Background,
  Vignette,
  ClickHighlightOverlay,
  InCameraOverlaysLayer,
  OutputOverlaysLayer,
  WatermarkLayer,
} from "./layers/EffectsLayer";
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
        {/* In-camera Phase-3 overlays (callout / blur) — inside the camera group
            so they track the zoom, matching composeFrame's applyCameraFrame. */}
        <InCameraOverlaysLayer recipe={compiled} />
      </VideoLayer>
      {compiled.effects.vignette && <Vignette recipe={compiled} />}
      {/* Output-anchored Phase-3 overlays (captions / hook / text / CTA /
          transition) — outside the camera, after the vignette, matching
          composeFrame's ordering. */}
      <OutputOverlaysLayer recipe={compiled} />
      {/* Free-tier brand mark — LAST, so nothing can paint over it. Same
          position in the stack as composeFrame's `drawWatermark` call. */}
      <WatermarkLayer recipe={compiled} />
    </AbsoluteFill>
  );
}
