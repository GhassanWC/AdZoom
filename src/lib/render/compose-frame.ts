/**
 * composeFrame — the single, DOM-agnostic per-frame compositor shared by the
 * browser exporter and the server worker. Given a 2D context, a drawable frame
 * source, a `RenderRecipe`, and the SOURCE timestamp the frame was decoded at,
 * it paints exactly the layers the export bakes in:
 *
 *   1. Black backdrop          — every frame, before the video.
 *   2. Canvas-Fit background   — blur/solid/dark/light, only when the placement
 *                                leaves empty space (Fit / Manual letterbox).
 *   3. Source video + camera   — `drawImage` inside the per-moment camera
 *                                transform (zoom/pan), 9-arg Frame-Crop source rect.
 *   4. Click highlight         — INSIDE the camera transform (scales with zoom),
 *                                only for an active `click-highlight` moment.
 *   5. Vignette                — OUTSIDE the camera transform, anchored to the
 *                                output frame (opt-in).
 *   6. Watermark               — OUTSIDE the camera transform (free tier only;
 *                                paid cloud exports never set `applyWatermark`).
 *
 * The ONLY difference between the browser and worker render paths is what they
 * pass as `frame` (an `HTMLVideoElement` vs a decoded-frame canvas) and the
 * `sourceTime` (the live `video.currentTime` vs a value computed off the
 * timeline map). Everything baked into the file flows through here.
 *
 * `ctx` is typed against the DOM `CanvasRenderingContext2D`; the worker passes
 * `@napi-rs/canvas`'s API-compatible context cast to this type at the boundary.
 * Context-level configuration (alpha, image smoothing) is the CALLER's job so
 * each environment can match the other — this function never mutates smoothing.
 */
import { resolveCameraFrame, canvasTranslateFor } from "@/lib/timeline/camera";
import { coverFitDims } from "@/lib/timeline/cover";
import { drawClickHighlight } from "@/lib/timeline/click-highlight";
import { resolveClickHighlight } from "./click-highlight";
import { drawInCameraOverlays, drawOutputOverlays } from "./overlay-draw";
import type { BackgroundMode } from "@/lib/firebase/schema";
import type { RenderRecipe } from "./recipe";

/**
 * Composite ONE output frame onto `ctx`. `frame` is any `CanvasImageSource`
 * (browser: the `<video>`; worker: a canvas holding the decoded source frame).
 * `sourceTime` is the SOURCE timestamp the frame represents — the caller owns
 * the output→source time mapping (browser: real-time playback; worker: the
 * recipe's timeline map).
 */
export function composeFrame(
  ctx: CanvasRenderingContext2D,
  frame: CanvasImageSource,
  recipe: RenderRecipe,
  sourceTime: number
): void {
  const { canvasW, canvasH, bgActive, bgMode, backgroundColor, sourceRect, effects, moments, applyWatermark, debugBorders } = recipe;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Canvas-Fit background — fills the whole frame behind the (crisp) video when
  // the placement leaves empty space. Drawn OUTSIDE the camera, before the
  // source, so the foreground paints over it.
  if (bgActive) {
    drawCanvasBackground(
      ctx,
      frame,
      bgMode,
      backgroundColor,
      canvasW,
      canvasH,
      sourceRect.sx,
      sourceRect.sy,
      sourceRect.sWidth,
      sourceRect.sHeight
    );
  }

  applyCameraFrame(ctx, frame, recipe, sourceTime);

  if (debugBorders) drawDebugCanvasBorder(ctx, canvasW, canvasH);

  // Vignette + watermark sit OUTSIDE the camera transform so they stay anchored
  // to the output frame (not zooming with the video).
  if (effects.vignette) drawVignette(ctx, canvasW, canvasH);

  // Phase-3 output-anchored overlays (captions / hook text / text overlays /
  // branding CTA / transition). Drawn AFTER the vignette so text stays crisp,
  // BEFORE the watermark so the brand mark stays topmost.
  drawOutputOverlays(ctx, moments, sourceTime, { canvasW, canvasH });

  if (applyWatermark) drawWatermark(ctx, canvasW, canvasH);
}

/**
 * Apply the moment-aware camera transform for the given SOURCE time, draw the
 * video frame, and draw any in-camera overlays. The transform chain
 * (translate→scale→translate→drawImage→overlays) lives here in ONE place.
 * Identity outside moments — the same chain runs so the source is always centred.
 */
function applyCameraFrame(
  ctx: CanvasRenderingContext2D,
  frame: CanvasImageSource,
  recipe: RenderRecipe,
  t: number
): void {
  const { moments, effects, canvasW, canvasH, base, sourceRect, debugBorders } = recipe;

  // Single source of truth — same call the preview makes. Returns the moment's
  // camera state OR identity when no moment overlaps.
  const { camera, moment } = resolveCameraFrame(moments, t, {
    autoZoom: effects.autoZoom,
  });
  const { tx, ty } = canvasTranslateFor(camera, base.drawW, base.drawH);

  // The Canvas-Fit base placement (`base.offsetX/Y`) shifts the placement centre
  // — Smart-Fit pan / Manual drag / Fit letterbox. The per-moment camera (scale
  // + tx/ty) then composes relative to the placed source.
  ctx.save();
  ctx.translate(canvasW / 2 + base.offsetX, canvasH / 2 + base.offsetY);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(tx, ty);
  // 9-arg source rect: only the Frame Crop sub-rectangle is sampled, so
  // cropped-out areas never reach the canvas.
  ctx.drawImage(
    frame,
    sourceRect.sx,
    sourceRect.sy,
    sourceRect.sWidth,
    sourceRect.sHeight,
    -base.drawW / 2,
    -base.drawH / 2,
    base.drawW,
    base.drawH
  );

  // DEBUG: RED border = the video's drawImage destination bounds. Line width is
  // divided by scale so it renders ~4px regardless of zoom.
  if (debugBorders) {
    ctx.lineWidth = 4 / camera.scale;
    ctx.strokeStyle = "rgba(255,0,0,0.95)";
    ctx.strokeRect(-base.drawW / 2, -base.drawH / 2, base.drawW, base.drawH);
  }

  // Click-highlight overlay — drawn INSIDE the camera transform so the
  // ring/pulse/burst scales with the zoom, matching the preview where the CSS
  // scale on the wrapper magnifies the highlight's child span. The style/size
  // come from the SHARED resolver (this click's own look, falling back to the
  // project's), which the preview and Remotion call too — so per-edit clicks
  // can't render one way here and another there.
  const click = resolveClickHighlight(moment, effects);
  if (click && moment) {
    const dur = Math.max(0.1, moment.endTime - moment.startTime);
    drawClickHighlight(
      ctx,
      {
        cx: moment.focusRegion.x + moment.focusRegion.width / 2,
        cy: moment.focusRegion.y + moment.focusRegion.height / 2,
        progress: Math.max(0, Math.min(1, (t - moment.startTime) / dur)),
        style: click.style,
        sizePct: click.sizePct,
      },
      base.drawW,
      base.drawH,
      canvasW
    );
  }

  // Phase-3 in-camera overlays (callout / blur-redaction) — drawn INSIDE the
  // camera transform (origin = placement centre, same convention as the click
  // highlight) so they track the video content as it zooms/pans.
  drawInCameraOverlays(ctx, moments, t, base.drawW, base.drawH);

  ctx.restore();
}

/**
 * Canvas-Fit background — fills the WHOLE output frame behind the (crisp) source
 * video whenever the placement leaves empty space (Fit always; Manual when
 * scaled below cover; Smart-Fit's blur fallback). Drawn OUTSIDE the camera
 * transform, before the video, so the foreground paints over it.
 *
 *  - "blur"  → the same frame, cover-placed + Gaussian-blurred + dimmed,
 *              overscaled to hide the blur kernel's transparent edge.
 *  - "solid" → `backgroundColor` (defaults to black).
 *  - "dark"  → near-black; "light" → near-white.
 */
function drawCanvasBackground(
  ctx: CanvasRenderingContext2D,
  frame: CanvasImageSource,
  bgMode: BackgroundMode,
  backgroundColor: string | undefined,
  canvasW: number,
  canvasH: number,
  sourceX: number,
  sourceY: number,
  sourceW: number,
  sourceH: number
): void {
  if (bgMode === "blur") {
    const bg = coverFitDims(sourceW, sourceH, canvasW, canvasH);
    const k = 1.08; // overscale to hide the blur kernel's transparent edge
    ctx.save();
    ctx.filter = "blur(40px) brightness(0.7)";
    // 9-arg source rect — crop the blurred backdrop to the same sub-rectangle so
    // cropped-out areas can't smear into the letterbox area.
    ctx.drawImage(
      frame,
      sourceX,
      sourceY,
      sourceW,
      sourceH,
      canvasW / 2 - (bg.drawW * k) / 2,
      canvasH / 2 - (bg.drawH * k) / 2,
      bg.drawW * k,
      bg.drawH * k
    );
    ctx.filter = "none";
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.fillStyle =
    bgMode === "solid"
      ? backgroundColor || "#000000"
      : bgMode === "light"
        ? "#f5f5f5"
        : "#0a0a0a"; // "dark"
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.restore();
}

/**
 * Soft radial dark fade at the frame edges — the canvas equivalent of the
 * preview's CSS radial-gradient vignette. Drawn AFTER the camera transform so it
 * anchors to the output frame and doesn't zoom with the video. Opt-in.
 */
function drawVignette(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number
): void {
  const gradient = ctx.createRadialGradient(
    canvasW / 2,
    canvasH / 2,
    Math.min(canvasW, canvasH) * 0.6,
    canvasW / 2,
    canvasH / 2,
    Math.max(canvasW, canvasH) / 2
  );
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,0.25)");
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.restore();
}

/**
 * DEBUG: BLUE border = the canvas (export frame) bounds. Drawn OUTSIDE the
 * camera transform so it's always flush to the encoded frame edges.
 */
function drawDebugCanvasBorder(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number
): void {
  const lw = 4;
  ctx.save();
  ctx.lineWidth = lw;
  ctx.strokeStyle = "rgba(0,120,255,0.95)";
  ctx.strokeRect(lw / 2, lw / 2, canvasW - lw, canvasH - lw);
  ctx.restore();
}

/**
 * Draw the free-tier watermark in the bottom-right corner. Sized relative to the
 * canvas height so it reads at any resolution. NOTE: this is rendered by the
 * client for browser exports; a tampered client could omit it. Paid cloud
 * exports never set `applyWatermark`, so the worker never draws it.
 */
function drawWatermark(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number
): void {
  const fontSize = Math.max(18, Math.round(canvasH * 0.024));
  const padX = Math.round(fontSize * 0.9);
  const padY = Math.round(fontSize * 0.45);
  const text = "Made with Framevo";

  ctx.save();
  ctx.font = `600 ${fontSize}px -apple-system, "Segoe UI", system-ui, sans-serif`;
  const textW = ctx.measureText(text).width;
  const boxW = textW + padX * 2;
  const boxH = fontSize + padY * 2;
  const x = canvasW - boxW - Math.round(canvasH * 0.035);
  const y = canvasH - boxH - Math.round(canvasH * 0.035);
  const r = boxH / 2;

  // Backdrop pill — translucent black for contrast.
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + boxW - r, y);
  ctx.arcTo(x + boxW, y, x + boxW, y + r, r);
  ctx.lineTo(x + boxW, y + boxH - r);
  ctx.arcTo(x + boxW, y + boxH, x + boxW - r, y + boxH, r);
  ctx.lineTo(x + r, y + boxH);
  ctx.arcTo(x, y + boxH, x, y + boxH - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill();

  // Subtle violet dot to match brand.
  ctx.fillStyle = "rgba(196,181,253,1)";
  const dotR = Math.round(fontSize * 0.32);
  ctx.beginPath();
  ctx.arc(x + padX + dotR / 2, y + boxH / 2, dotR / 2, 0, Math.PI * 2);
  ctx.fill();

  // Text.
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padX + dotR + Math.round(fontSize * 0.45), y + boxH / 2);

  ctx.restore();
}
