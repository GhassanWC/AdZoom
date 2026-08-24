"use client";

/**
 * PreviewOverlays — the live-preview renderer for the Phase-3 overlay edits
 * (captions / hook text / text overlays / callouts / blur / branding CTA /
 * transitions). It reuses the SAME pure draw functions the exporter runs
 * (`drawOutputOverlays` / `drawInCameraOverlays`), so what you see here is what
 * the export bakes in.
 *
 * The player draws the video with CSS transforms (not `composeFrame`), so rather
 * than re-deriving the base placement + camera math (a parity-risk), each canvas
 * is mounted at the SAME DOM level the compositor's two coordinate spaces live:
 *   • `PreviewInCameraOverlays` is mounted INSIDE the camera-transform wrapper
 *     (the element `useCinematicCamera` writes `transform` onto). The browser
 *     applies the base-placement + camera transforms to it exactly as it does to
 *     the video, so callout/blur track zoom/pan with zero math here.
 *   • `PreviewOutputOverlays` is mounted at the OUTPUT frame level (outside the
 *     camera), so captions/hook/text/CTA/transition stay pinned to the frame.
 * Each reads `video.currentTime` per frame for smooth, drift-free sync.
 */
import * as React from "react";
import {
  drawInCameraOverlays,
  drawOutputOverlays,
  hasOverlayMoments,
} from "@/lib/render/overlay-draw";
import type { DetectedMoment } from "@/lib/firebase/schema";

/**
 * `hasOverlayMoments`, memoized on the moments ARRAY IDENTITY.
 *
 * The predicate scans every moment, and it ran twice per frame (once per canvas)
 * — on a captioned recording that is hundreds of moments × 2 × 60Hz for an
 * answer that only changes when the timeline does. `previewMoments` is a stable
 * reference between edits (see context.tsx), so identity is the right key: a
 * one-entry cache turns the scan into a pointer compare.
 */
let overlayScanKey: DetectedMoment[] | null = null;
let overlayScanValue = false;
function hasOverlayMomentsCached(moments: DetectedMoment[]): boolean {
  if (moments !== overlayScanKey) {
    overlayScanKey = moments;
    overlayScanValue = hasOverlayMoments(moments);
  }
  return overlayScanValue;
}

/** Shared rAF canvas loop. `draw(ctx, t, boxW, boxH)` runs each frame (post DPR + clear). */
function useOverlayCanvas(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  momentsRef: React.MutableRefObject<DetectedMoment[]>,
  enabledRef: React.MutableRefObject<boolean>,
  draw: (ctx: CanvasRenderingContext2D, t: number, boxW: number, boxH: number) => void
) {
  React.useEffect(() => {
    let raf = 0;
    let lastW = 0;
    let lastH = 0;
    /** True once we've cleared for a state that draws nothing — see below. */
    let clearedWhileIdle = false;
    const tick = () => {
      const cv = canvasRef.current;
      const ctx = cv?.getContext("2d");
      if (!cv || !ctx) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // Decide whether this frame draws ANYTHING before measuring. `rect` below
      // is a forced synchronous layout, and it lands immediately after the
      // camera loop writes `transform` on this canvas's parent — so on a project
      // with no overlay edits we were paying two layout flushes per frame to
      // clear two canvases that were already empty.
      const willDraw = enabledRef.current && hasOverlayMomentsCached(momentsRef.current);
      if (!willDraw) {
        // Clear ONCE on the transition into idle, then go quiet. Skipping the
        // clear entirely would leave the last drawn frame stuck on screen.
        if (!clearedWhileIdle && (lastW || lastH)) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, cv.width, cv.height);
          clearedWhileIdle = true;
        }
        raf = requestAnimationFrame(tick);
        return;
      }
      clearedWhileIdle = false;

      const rect = cv.getBoundingClientRect();
      const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
      const boxW = Math.max(1, Math.round(rect.width));
      const boxH = Math.max(1, Math.round(rect.height));
      const pxW = Math.round(boxW * dpr);
      const pxH = Math.round(boxH * dpr);
      if (pxW !== lastW || pxH !== lastH) {
        cv.width = pxW;
        cv.height = pxH;
        lastW = pxW;
        lastH = pxH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, boxW, boxH);
      draw(ctx, videoRef.current?.currentTime ?? 0, boxW, boxH);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // draw is stable (defined per-component); refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef, videoRef]);
}

function useLiveRefs(moments: DetectedMoment[], enabled: boolean) {
  const momentsRef = React.useRef(moments);
  momentsRef.current = moments;
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  return { momentsRef, enabledRef };
}

/**
 * In-camera overlays (callout / blur). MOUNT INSIDE the camera-transform wrapper
 * so the parent CSS transform (base placement + zoom/pan) applies to this canvas
 * exactly as to the video — the box then equals the export's `base` placement.
 */
export function PreviewInCameraOverlays({
  videoRef,
  moments,
  enabled,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  moments: DetectedMoment[];
  enabled: boolean;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const { momentsRef, enabledRef } = useLiveRefs(moments, enabled);
  useOverlayCanvas(canvasRef, videoRef, momentsRef, enabledRef, (ctx, t, boxW, boxH) => {
    // Origin = placement centre (same convention as drawClickHighlight); the
    // parent wrapper already carries the camera transform.
    ctx.save();
    ctx.translate(boxW / 2, boxH / 2);
    drawInCameraOverlays(ctx, momentsRef.current, t, boxW, boxH);
    ctx.restore();
  });
  return (
    <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
  );
}

/**
 * Output-anchored overlays (captions / hook / text / CTA / transition). MOUNT at
 * the OUTPUT frame level (outside the camera) so they stay pinned to the frame.
 */
export function PreviewOutputOverlays({
  videoRef,
  moments,
  enabled,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  moments: DetectedMoment[];
  enabled: boolean;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const { momentsRef, enabledRef } = useLiveRefs(moments, enabled);
  useOverlayCanvas(canvasRef, videoRef, momentsRef, enabledRef, (ctx, t, boxW, boxH) => {
    drawOutputOverlays(ctx, momentsRef.current, t, { canvasW: boxW, canvasH: boxH });
  });
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[15] h-full w-full"
    />
  );
}
