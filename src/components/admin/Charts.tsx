"use client";

/**
 * Lightweight, dependency-free SVG charts matching the glass design system
 * (violet→cyan gradients from globals.css tokens). Intentionally minimal —
 * just enough for the admin dashboard's timeseries and distributions.
 */

import * as React from "react";
import { cn } from "@/lib/cn";

export interface ChartPoint {
  label: string;
  value: number;
}

/** Area + line chart for a daily timeseries. Scales to its container width. */
export function LineChart({
  data,
  height = 160,
  className,
}: {
  data: ChartPoint[];
  height?: number;
  className?: string;
}) {
  const gradId = React.useId();
  if (!data.length) return null;

  const W = 600;
  const H = 200;
  const pad = 8;
  const max = Math.max(1, ...data.map((d) => d.value));
  const stepX = data.length > 1 ? (W - pad * 2) / (data.length - 1) : 0;
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const x = (i: number) => pad + i * stepX;

  const line = data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.value)}`).join(" ");
  const area = `${line} L ${x(data.length - 1)} ${H - pad} L ${x(0)} ${H - pad} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      className={cn("overflow-visible", className)}
      role="img"
      aria-label="Time series chart"
    >
      <defs>
        <linearGradient id={`area-${gradId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(139 92 246)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="rgb(139 92 246)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`line-${gradId}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgb(139 92 246)" />
          <stop offset="100%" stopColor="rgb(34 211 238)" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#area-${gradId})`} />
      <path
        d={line}
        fill="none"
        stroke={`url(#line-${gradId})`}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Horizontal bar list — good for distributions (formats, engines, plans). */
export function BarList({
  data,
  className,
  valueFormatter = (v) => v.toLocaleString("en-US"),
}: {
  data: ChartPoint[];
  className?: string;
  valueFormatter?: (v: number) => string;
}) {
  if (!data.length) return null;
  const max = Math.max(1, ...data.map((d) => d.value));
  const sorted = [...data].sort((a, b) => b.value - a.value);

  return (
    <div className={cn("space-y-2.5", className)}>
      {sorted.map((d) => (
        <div key={d.label} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="truncate text-white/80">{d.label}</span>
            <span className="ml-2 shrink-0 font-mono tabular-nums text-fog">
              {valueFormatter(d.value)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400"
              style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Tiny inline sparkline for metric cards. */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const gradId = React.useId();
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);
  const stepX = width / (values.length - 1);
  const pts = values
    .map((v, i) => `${i * stepX},${height - ((v - min) / span) * (height - 4) - 2}`)
    .join(" ");

  return (
    <svg width={width} height={height} className={className} aria-hidden>
      <defs>
        <linearGradient id={`spark-${gradId}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgb(139 92 246)" />
          <stop offset="100%" stopColor="rgb(34 211 238)" />
        </linearGradient>
      </defs>
      <polyline
        points={pts}
        fill="none"
        stroke={`url(#spark-${gradId})`}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
