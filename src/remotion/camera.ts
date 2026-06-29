/**
 * CSS adapter that reproduces the canvas `composeFrame` transform chain
 * (src/lib/render/compose-frame.ts) using DOM layout + CSS transforms, so the
 * Remotion render pixel-matches the editor/browser export. Reuses the SAME pure
 * camera + timeline math (`resolveCameraFrame`, `canvasTranslateFor`,
 * `buildTimelineMap`) — there is no second camera implementation to drift.
 *
 * `composeFrame`'s chain (per output frame, for SOURCE time t):
 *   ctx.translate(canvasW/2 + base.offsetX, canvasH/2 + base.offsetY)
 *   ctx.scale(camera.scale)
 *   ctx.translate(tx, ty)                       // canvasTranslateFor(camera, drawW, drawH)
 *   ctx.drawImage(frame, sx,sy,sW,sH, -drawW/2,-drawH/2, drawW,drawH)   // 9-arg Frame Crop
 *
 * CSS equivalent: a `base.drawW × base.drawH` "camera group" element whose CENTER
 * sits at (canvasW/2 + base.offsetX, canvasH/2 + base.offsetY), with
 * `transform: scale(s) translate(tx,ty)` (origin center). CSS applies the list
 * right-to-left (translate then scale), so a point maps to `center + s*(t + p)`,
 * identical to the canvas chain. The 9-arg crop is reproduced by an oversized
 * `<OffthreadVideo>` inside an `overflow:hidden` group, offset so the crop
 * sub-rect fills the group.
 */
import type { CSSProperties } from "react";
import type { RenderRecipe } from "@/lib/render/recipe";
import { canvasTranslateFor, type CameraState } from "@/lib/timeline/camera";
import type { TimelineMap } from "@/lib/timeline/crop-speed";
import { coverFitDims } from "@/lib/timeline/cover";

/** Map an OUTPUT time (seconds) to the SOURCE time the editor/export samples,
 *  using the recipe's cut/speed timeline map. Identical to the browser loop. */
export function sourceTimeForOutput(map: TimelineMap, outputTime: number): number {
  const segs = map.segments;
  if (segs.length === 0) return outputTime;
  for (const s of segs) {
    if (outputTime >= s.outputStart && outputTime < s.outputEnd) {
      return s.sourceStart + (outputTime - s.outputStart) * s.speedMultiplier;
    }
  }
  // Past the last segment (final frame rounding) → clamp to its end.
  const last = segs[segs.length - 1]!;
  return last.sourceEnd;
}

/**
 * Style for the camera-group element. Reproduces
 * `translate(canvasW/2+offset) → scale(s) → translate(tx,ty)`. `overflow:hidden`
 * makes the group a crop viewport for the 9-arg Frame Crop below.
 */
export function cameraGroupStyle(recipe: RenderRecipe, camera: CameraState): CSSProperties {
  const { base, canvasW, canvasH } = recipe;
  const { tx, ty } = canvasTranslateFor(camera, base.drawW, base.drawH);
  const centerX = canvasW / 2 + base.offsetX;
  const centerY = canvasH / 2 + base.offsetY;
  return {
    position: "absolute",
    left: centerX - base.drawW / 2,
    top: centerY - base.drawH / 2,
    width: base.drawW,
    height: base.drawH,
    overflow: "hidden",
    transformOrigin: "center center",
    transform: `scale(${camera.scale}) translate(${tx}px, ${ty}px)`,
  };
}

/**
 * Style for the foreground `<OffthreadVideo>` inside the camera group: reproduces
 * the 9-arg `drawImage(frame, sx,sy,sW,sH, ..., drawW,drawH)`. The full source is
 * scaled by `drawW/sW` (== `drawH/sH`, aspect-preserving) and offset so the crop
 * sub-rect's top-left lands at the group origin. Identity when crop is inactive.
 */
export function croppedVideoStyle(recipe: RenderRecipe): CSSProperties {
  const { sourceRect, base, sourceWidth, sourceHeight } = recipe;
  const scaleX = base.drawW / sourceRect.sWidth;
  const scaleY = base.drawH / sourceRect.sHeight;
  return {
    position: "absolute",
    left: -sourceRect.sx * scaleX,
    top: -sourceRect.sy * scaleY,
    width: sourceWidth * scaleX,
    height: sourceHeight * scaleY,
    objectFit: "fill",
  };
}

/**
 * Style for the blurred Canvas-Fit background (`bgMode:"blur"`). Reproduces
 * `composeFrame`'s `drawCanvasBackground`: cover-fit the cropped source to the
 * whole canvas, overscale by 1.08 to hide the blur kernel's transparent edge,
 * `blur(40px) brightness(0.7)`. Drawn OUTSIDE the camera transform, behind the
 * foreground video. The 9-arg crop is reproduced by the same oversized-video offset.
 */
export function coverBlurStyle(recipe: RenderRecipe): CSSProperties {
  const { canvasW, canvasH, sourceRect, sourceWidth, sourceHeight } = recipe;
  const bg = coverFitDims(sourceRect.sWidth, sourceRect.sHeight, canvasW, canvasH);
  const k = 1.08;
  const drawW = bg.drawW * k;
  const drawH = bg.drawH * k;
  const scaleX = drawW / sourceRect.sWidth;
  const scaleY = drawH / sourceRect.sHeight;
  return {
    position: "absolute",
    left: canvasW / 2 - drawW / 2 - sourceRect.sx * scaleX,
    top: canvasH / 2 - drawH / 2 - sourceRect.sy * scaleY,
    width: sourceWidth * scaleX,
    height: sourceHeight * scaleY,
    objectFit: "fill",
    filter: "blur(40px) brightness(0.7)",
  };
}
