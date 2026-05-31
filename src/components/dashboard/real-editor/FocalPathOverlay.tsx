"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import type { DetectedMoment } from "@/lib/firebase/schema";

/**
 * Renders the camera path of a moment as a thin polyline through its
 * keyframe centers, with a small dot at each keyframe. Purely visual — no
 * interaction, no pointer-events. Lives in the same coordinate space as
 * the EditableFocusBox (wrapper-relative percentages of the video frame).
 *
 * Only renders when the moment has ≥ 2 keyframes — a single-keyframe
 * moment is functionally static and showing a one-point "path" is noise.
 *
 * Why an overlay and not a debug toggle: a keyframe path is an explicit
 * editorial choice (or an AI-generated cursor follow). Hiding it would
 * make the user wonder where the camera will actually move. Keeping it on
 * by default matches Final Cut's keyframe-path visualisation.
 */
export function FocalPathOverlay({
  moment,
  className,
}: {
  moment: DetectedMoment;
  className?: string;
}) {
  const keyframes = moment.keyframes;
  if (!keyframes || keyframes.length < 2) return null;

  // Sort by t so the polyline plays in the correct order regardless of
  // how the user added the keyframes.
  const sorted = [...keyframes].sort((a, b) => a.t - b.t);
  const points = sorted
    .map((k) => `${(k.x * 100).toFixed(2)},${(k.y * 100).toFixed(2)}`)
    .join(" ");

  return (
    <svg
      aria-hidden
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className={cn(
        "pointer-events-none absolute inset-0 z-20 size-full",
        className
      )}
    >
      {/* The path itself — stroke width is in viewBox units so it stays
          thin across resize. vectorEffect: non-scaling-stroke keeps the
          line from squashing when the wrapper isn't square. */}
      <polyline
        points={points}
        fill="none"
        stroke="rgb(196 181 253)" // violet-300
        strokeOpacity="0.85"
        strokeWidth="0.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ vectorEffect: "non-scaling-stroke", strokeWidth: 1.5 }}
      />
      {sorted.map((k, i) => (
        <circle
          key={i}
          cx={k.x * 100}
          cy={k.y * 100}
          r={0.5}
          fill="rgb(139 92 246)" // violet-500
          style={{ vectorEffect: "non-scaling-stroke" }}
        />
      ))}
    </svg>
  );
}
