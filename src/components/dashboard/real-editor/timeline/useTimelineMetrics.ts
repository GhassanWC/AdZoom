"use client";

import * as React from "react";

/**
 * Timeline scale model. The lane layout stays percentage-based (pills position
 * with `left%` / `width%` inside a `width: zoom*100%` content element); this
 * hook derives the pixels-per-second that the ruler uses to pick tick density
 * and that "Fit to screen" resets.
 *
 * `pxPerSec` is measured from the content element via a `ResizeObserver`, so it
 * always agrees with the drag math (which reads the same element's width
 * mid-drag). Fit-to-screen is simply `zoom = 1` (content width === viewport
 * width → the whole video is visible); the caller resets `scrollLeft`.
 */
export const TIMELINE_MIN_ZOOM = 1;
export const TIMELINE_MAX_ZOOM = 8;
const ZOOM_STEP = 0.5;

const snapZoom = (z: number) => Math.round(z * 2) / 2;

export interface TimelineMetrics {
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  /** Measured pixels-per-second at the current zoom (0 before first measure). */
  pxPerSec: number;
  /** Measured content width in px (0 before first measure). */
  contentWidth: number;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Reset zoom to 1 so the entire timeline fits the viewport. */
  fitToScreen: () => void;
  minZoom: number;
  maxZoom: number;
}

export function useTimelineMetrics({
  total,
  contentRef,
}: {
  total: number;
  contentRef: React.RefObject<HTMLElement | null>;
}): TimelineMetrics {
  const [zoom, setZoom] = React.useState(1);
  const [contentWidth, setContentWidth] = React.useState(0);

  React.useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setContentWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // contentRef is a stable ref object; observe once.
  }, [contentRef]);

  const pxPerSec = total > 0 && contentWidth > 0 ? contentWidth / total : 0;

  const zoomIn = React.useCallback(
    () => setZoom((z) => Math.min(TIMELINE_MAX_ZOOM, snapZoom(z + ZOOM_STEP))),
    []
  );
  const zoomOut = React.useCallback(
    () => setZoom((z) => Math.max(TIMELINE_MIN_ZOOM, snapZoom(z - ZOOM_STEP))),
    []
  );
  const fitToScreen = React.useCallback(() => setZoom(1), []);

  return {
    zoom,
    setZoom,
    pxPerSec,
    contentWidth,
    zoomIn,
    zoomOut,
    fitToScreen,
    minZoom: TIMELINE_MIN_ZOOM,
    maxZoom: TIMELINE_MAX_ZOOM,
  };
}
