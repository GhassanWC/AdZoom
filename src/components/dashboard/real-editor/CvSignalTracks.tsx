"use client";

import * as React from "react";
import { Activity, Gauge, Scissors, MousePointerClick } from "lucide-react";
import { cn } from "@/lib/cn";
import { dequantizeArray } from "@/lib/cv/resample";
import type { VisualAnalysis } from "@/lib/firebase/schema";

/**
 * Developer debug view of the raw CV signals, time-aligned under the timeline.
 * Shows the measured motion curve, the fused attention curve, scene-change
 * markers, and inferred click-like events. Toggled by the editor's CV-debug
 * switch.
 */
export function CvSignalTracks({
  visualAnalysis,
  duration,
  currentTime,
  onSeek,
}: {
  visualAnalysis: VisualAnalysis;
  duration: number;
  currentTime: number;
  onSeek: (t: number) => void;
}) {
  const va = visualAnalysis;
  const motion = React.useMemo(() => dequantizeArray(va.motion), [va.motion]);
  const attention = React.useMemo(
    () => dequantizeArray(va.attentionCurve),
    [va.attentionCurve]
  );
  const total = duration > 0 ? duration : va.sampleCount / va.sampleRate;
  const playheadPct = total > 0 ? (currentTime / total) * 100 : 0;

  const seekFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    if (total <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - r.left) / r.width;
    onSeek(Math.max(0, Math.min(total, pct * total)));
  };

  return (
    <div className="mt-3 rounded-lg border border-violet-400/20 bg-violet-500/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between text-[10px] text-fog">
        <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-[0.16em] text-violet-200">
          <Activity size={10} />
          CV debug signals
        </span>
        <span className="font-mono">
          {va.sampleCount} samples @ {va.sampleRate}Hz · scan{" "}
          {(va.computeMs / 1000).toFixed(1)}s
        </span>
      </div>

      <div className="space-y-2">
        <CurveTrack
          label="Motion"
          icon={<Activity size={9} />}
          values={motion}
          color="#A78BFA"
          fill="rgba(139,92,246,0.18)"
          playheadPct={playheadPct}
          onSeek={seekFromEvent}
        />
        <CurveTrack
          label="Attention"
          icon={<Gauge size={9} />}
          values={attention}
          color="#34D399"
          fill="rgba(52,211,153,0.16)"
          playheadPct={playheadPct}
          onSeek={seekFromEvent}
        />
        <EventTrack
          label="Scenes"
          icon={<Scissors size={9} />}
          events={va.sceneChanges}
          total={total}
          color="bg-amber-400"
          playheadPct={playheadPct}
          onSeek={seekFromEvent}
        />
        <EventTrack
          label="Clicks"
          icon={<MousePointerClick size={9} />}
          events={va.clickEvents}
          total={total}
          color="bg-cyan-400"
          playheadPct={playheadPct}
          onSeek={seekFromEvent}
        />
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-fog/75">
        Motion + scenes are measured from real frames. Clicks are inferred from
        motion spikes (heuristic — can misfire on scroll/drag). Centroid path is
        drawn over the video preview.
      </p>
    </div>
  );
}

function TrackLabel({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <span className="flex w-16 shrink-0 items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-fog">
      {icon}
      {label}
    </span>
  );
}

function CurveTrack({
  label,
  icon,
  values,
  color,
  fill,
  playheadPct,
  onSeek,
}: {
  label: string;
  icon: React.ReactNode;
  values: number[];
  color: string;
  fill: string;
  playheadPct: number;
  onSeek: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const n = values.length;
  // Build an SVG polyline in a 0..n × 0..100 viewBox, stretched to fit.
  const points = n
    ? values.map((v, i) => `${i},${100 - Math.max(0, Math.min(1, v)) * 100}`)
    : [];
  const area =
    n > 0
      ? `0,100 ${points.join(" ")} ${n - 1},100`
      : "";

  return (
    <div className="flex items-center gap-2">
      <TrackLabel icon={icon} label={label} />
      <div
        className="relative h-9 flex-1 cursor-pointer overflow-hidden rounded bg-white/[0.02]"
        onClick={onSeek}
      >
        {n > 0 ? (
          <svg
            viewBox={`0 0 ${Math.max(1, n - 1)} 100`}
            preserveAspectRatio="none"
            className="h-full w-full"
          >
            <polygon points={area} fill={fill} />
            <polyline
              points={points.join(" ")}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <div className="grid h-full place-items-center text-[9px] text-fog/60">
            no data
          </div>
        )}
        <span
          className="pointer-events-none absolute inset-y-0 w-px bg-white/80"
          style={{ left: `${playheadPct}%` }}
        />
      </div>
    </div>
  );
}

function EventTrack({
  label,
  icon,
  events,
  total,
  color,
  playheadPct,
  onSeek,
}: {
  label: string;
  icon: React.ReactNode;
  events: { t: number; strength: number }[];
  total: number;
  color: string;
  playheadPct: number;
  onSeek: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <TrackLabel icon={icon} label={label} />
      <div
        className="relative h-5 flex-1 cursor-pointer overflow-hidden rounded bg-white/[0.02]"
        onClick={onSeek}
      >
        {events.length === 0 && (
          <div className="grid h-full place-items-center text-[9px] text-fog/50">
            none detected
          </div>
        )}
        {events.map((e, i) => {
          const left = total > 0 ? (e.t / total) * 100 : 0;
          return (
            <span
              key={`${e.t}-${i}`}
              title={`${label} @ ${e.t.toFixed(1)}s · strength ${(
                e.strength * 100
              ).toFixed(0)}%`}
              className={cn(
                "absolute inset-y-1 w-0.5 -translate-x-1/2 rounded-full",
                color
              )}
              style={{
                left: `${left}%`,
                opacity: 0.4 + Math.min(1, e.strength) * 0.6,
              }}
            />
          );
        })}
        <span
          className="pointer-events-none absolute inset-y-0 w-px bg-white/80"
          style={{ left: `${playheadPct}%` }}
        />
      </div>
    </div>
  );
}
