"use client";

import * as React from "react";

interface Props {
  /** 8-bit quantized attention curve (0..255). */
  curve?: number[];
  /** Total duration in seconds — drives the optional time-window crop. */
  duration?: number;
  /** Visual height in CSS px of the SVG. */
  height?: number;
  /** Show subtle baseline + tick grid behind the curve. */
  showGrid?: boolean;
  /** Optional className for absolute positioning. */
  className?: string;
  /** Optional cropped window (start..end seconds) — for per-pill sparklines. */
  window?: { start: number; end: number };
  /** Visual style preset. */
  variant?: "full" | "compact" | "spark";
}

/**
 * Smooth, GPU-friendly attention waveform. Renders as a filled area chart
 * with a glowing stroke — used both as a wide layer behind the timeline
 * track and as a per-pill micro-sparkline.
 */
export function AttentionWaveform({
  curve,
  duration,
  height = 88,
  showGrid = false,
  className,
  window: win,
  variant = "full",
}: Props) {
  if (!curve || curve.length === 0) {
    if (variant === "full") {
      return (
        <div
          className={className}
          style={{
            height,
            backgroundImage:
              "radial-gradient(ellipse at center, rgba(139,92,246,0.06), transparent 70%)",
          }}
          aria-hidden
        />
      );
    }
    return null;
  }

  // Subset the curve to the requested window when relevant.
  let samples = curve;
  if (win && duration && duration > 0) {
    const startIdx = Math.max(
      0,
      Math.floor((win.start / duration) * curve.length)
    );
    const endIdx = Math.min(
      curve.length,
      Math.ceil((win.end / duration) * curve.length)
    );
    samples = endIdx > startIdx + 1 ? curve.slice(startIdx, endIdx) : curve;
  }

  const w = 1000; // virtual viewport — scales with viewBox
  const h = variant === "spark" ? 32 : 100;
  const stepX = samples.length > 1 ? w / (samples.length - 1) : w;
  const peak = Math.max(1, ...samples);

  // Build a smoothed path using Catmull-Rom → cubic Bézier so the line
  // doesn't look noisy. For short curves we just draw straight segments.
  const pts: Array<[number, number]> = samples.map((v, i) => {
    const x = i * stepX;
    const y = h - (v / peak) * (h - 2) - 1;
    return [x, y];
  });

  let line = "";
  if (pts.length === 1) {
    line = `M0,${pts[0][1]} L${w},${pts[0][1]}`;
  } else {
    line = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? p2;
      const t = 0.18;
      const cp1x = p1[0] + (p2[0] - p0[0]) * t;
      const cp1y = p1[1] + (p2[1] - p0[1]) * t;
      const cp2x = p2[0] - (p3[0] - p1[0]) * t;
      const cp2y = p2[1] - (p3[1] - p1[1]) * t;
      line += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(
        2
      )},${cp2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
    }
  }

  const area = `${line} L${w},${h} L0,${h} Z`;

  const gradId = React.useId();
  const glowId = React.useId();

  if (variant === "spark") {
    return (
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className={className}
        style={{ height, width: "100%" }}
        aria-hidden
      >
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(196,181,253,0.85)" />
            <stop offset="100%" stopColor="rgba(139,92,246,0.05)" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradId})`} />
        <path
          d={line}
          fill="none"
          stroke="rgba(221,214,254,0.95)"
          strokeWidth="1.6"
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height, width: "100%", display: "block" }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgba(167,139,250,0.55)" />
          <stop offset="40%" stopColor="rgba(139,92,246,0.28)" />
          <stop offset="100%" stopColor="rgba(76,29,149,0)" />
        </linearGradient>
        <filter id={glowId} x="-5%" y="-30%" width="110%" height="160%">
          <feGaussianBlur stdDeviation="1.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {showGrid && (
        <g aria-hidden>
          {[0.25, 0.5, 0.75].map((p) => (
            <line
              key={p}
              x1={w * p}
              x2={w * p}
              y1={0}
              y2={h}
              stroke="rgba(255,255,255,0.04)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1={0}
            x2={w}
            y1={h - 1}
            y2={h - 1}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )}

      <path d={area} fill={`url(#${gradId})`} />
      <path
        d={line}
        fill="none"
        stroke="rgba(221,214,254,0.85)"
        strokeWidth="1.4"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#${glowId})`}
      />
    </svg>
  );
}
