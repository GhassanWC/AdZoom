/**
 * EffectsLayer — the non-video layers of `composeFrame`, reproduced for Remotion:
 *   • Background  — solid/dark/light Canvas-Fit fill (blur is a blurred video copy
 *                   handled in VideoLayer). Outside the camera, behind the video.
 *   • Vignette    — soft radial dark edge. Outside the camera, in front.
 *   • ClickHighlightOverlay — the ring/pulse/burst, drawn on a `<canvas>` that
 *                   REUSES `drawClickHighlight` verbatim (guaranteed parity). It is
 *                   placed INSIDE the camera group (see VideoLayer children) so the
 *                   parent CSS scale magnifies it with the zoom, exactly like the
 *                   canvas exporter draws it inside the camera transform.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { RenderRecipe } from "@/lib/render/recipe";
import { resolveCameraFrame } from "@/lib/timeline/camera";
import { buildTimelineMap } from "@/lib/timeline/crop-speed";
import { drawClickHighlight } from "@/lib/timeline/click-highlight";
import { buildOutputFrameSegments, sourceTimeForFrame } from "../camera";

export function Background({ recipe }: { recipe: RenderRecipe }): React.JSX.Element | null {
  if (!recipe.bgActive || recipe.bgMode === "blur") return null;
  const color =
    recipe.bgMode === "solid"
      ? recipe.backgroundColor || "#000000"
      : recipe.bgMode === "light"
        ? "#f5f5f5"
        : "#0a0a0a"; // "dark"
  return <AbsoluteFill style={{ backgroundColor: color }} />;
}

export function Vignette({ recipe }: { recipe: RenderRecipe }): React.JSX.Element {
  const { canvasW, canvasH } = recipe;
  const inner = Math.min(canvasW, canvasH) * 0.6;
  const outer = Math.max(canvasW, canvasH) / 2;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at 50% 50%, rgba(0,0,0,0) ${inner}px, rgba(0,0,0,0.25) ${outer}px)`,
      }}
    />
  );
}

export function ClickHighlightOverlay({ recipe }: { recipe: RenderRecipe }): React.JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const ref = useRef<HTMLCanvasElement | null>(null);
  const { base, canvasW, effects } = recipe;
  const segments = useMemo(
    () => buildOutputFrameSegments(buildTimelineMap(recipe.moments, recipe.sourceDuration), fps, durationInFrames),
    [recipe, fps, durationInFrames]
  );

  // Draw synchronously before paint so Remotion's frame capture includes it.
  useLayoutEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!effects.clickHighlights) return;
    const sourceTime = sourceTimeForFrame(segments, frame, fps, recipe.sourceDuration);
    const { moment } = resolveCameraFrame(recipe.moments, sourceTime, { autoZoom: effects.autoZoom });
    if (!moment || moment.effectType !== "click-highlight") return;
    const dur = Math.max(0.1, moment.endTime - moment.startTime);
    ctx.save();
    ctx.translate(base.drawW / 2, base.drawH / 2);
    drawClickHighlight(
      ctx,
      {
        cx: moment.focusRegion.x + moment.focusRegion.width / 2,
        cy: moment.focusRegion.y + moment.focusRegion.height / 2,
        progress: Math.max(0, Math.min(1, (sourceTime - moment.startTime) / dur)),
        style: effects.clickHighlightStyle,
        sizePct: effects.clickHighlightSize,
      },
      base.drawW,
      base.drawH,
      canvasW
    );
    ctx.restore();
  }, [frame, fps, segments, recipe, base, canvasW, effects]);

  if (!effects.clickHighlights) return null;
  return (
    <canvas
      ref={ref}
      width={Math.max(1, Math.round(base.drawW))}
      height={Math.max(1, Math.round(base.drawH))}
      style={{ position: "absolute", left: 0, top: 0, width: base.drawW, height: base.drawH }}
    />
  );
}
