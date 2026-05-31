"use client";

import * as React from "react";
import {
  ZoomIn,
  ZoomOut,
  HelpCircle,
  BarChart2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { fmt } from "./utils";

/**
 * Minimal timeline header.
 *
 * Default surface is intentionally quiet — title, single AI-health dot, zoom,
 * keyboard tips, current time. Every chip, sparkline, provenance counter,
 * balance/density/quiet badge, and CV toggle that used to live up here was
 * moved into the "Show analytics" Insights panel at the bottom of the
 * timeline (`RealTimeline.tsx`). Progressive disclosure: power users still
 * get the data with one click; first-time users see a calm editing surface.
 *
 * Why a header at all? Because zoom + playhead time are pure editing controls
 * (always visible in pro tools like Final Cut / Descript / Riverside) and the
 * single AI-health dot is the cheapest possible signal that "your timeline is
 * OK" without forcing the user to read three pills.
 */
export function TimelineHeader({
  health,
  zoom,
  onZoomOut,
  onZoomIn,
  currentTime,
  total,
  insightsOpen,
  onToggleInsights,
}: {
  /** Aggregated AI health — drives the single status dot. */
  health: TimelineHealth;
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  currentTime: number;
  total: number;
  insightsOpen: boolean;
  onToggleInsights: () => void;
}) {
  return (
    <div className="relative border-b border-white/[0.06] px-6 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* ── Identity ─────────────────────────────────────────────── */}
        <div className="flex min-w-0 items-center gap-2.5">
          <h3 className="font-display text-[15px] font-semibold tracking-tight text-white">
            Timeline
          </h3>
          <HealthDot health={health} />
        </div>

        {/* ── Tools ────────────────────────────────────────────────── */}
        <div className="flex items-center gap-1.5">
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/[0.025] p-1">
            <button
              type="button"
              aria-label="Zoom timeline out"
              onClick={onZoomOut}
              disabled={zoom <= 1}
              className="inline-flex size-7 items-center justify-center rounded-md text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white disabled:opacity-30"
            >
              <ZoomOut size={13} />
            </button>
            <span className="w-9 text-center font-mono text-[11px] tabular-nums text-fog">
              {zoom.toFixed(1)}×
            </span>
            <button
              type="button"
              aria-label="Zoom timeline in"
              onClick={onZoomIn}
              disabled={zoom >= 8}
              className="inline-flex size-7 items-center justify-center rounded-md text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white disabled:opacity-30"
            >
              <ZoomIn size={13} />
            </button>
          </div>

          <TipsPopover />

          <button
            type="button"
            onClick={onToggleInsights}
            aria-expanded={insightsOpen}
            title={insightsOpen ? "Hide analytics" : "Show analytics"}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-medium transition-colors duration-150",
              insightsOpen
                ? "border-violet-400/40 bg-violet-500/12 text-violet-100"
                : "border-white/10 bg-white/[0.025] text-fog hover:border-white/25 hover:text-white"
            )}
          >
            <BarChart2 size={12} />
            Insights
          </button>

          <span className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 font-mono text-[12px] font-medium tabular-nums text-white">
            {fmt(currentTime)}
            <span className="text-fog/70"> / {fmt(total)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Aggregated single-signal health used by the dot. */
export type TimelineHealth = "balanced" | "clustered" | "quiet" | "empty";

const HEALTH_PRESENTATION: Record<
  TimelineHealth,
  { dot: string; label: string; tooltip: string }
> = {
  balanced: {
    dot: "bg-emerald-400",
    label: "Balanced",
    tooltip:
      "Moments are well distributed and the density looks healthy. Open Insights for the full breakdown.",
  },
  clustered: {
    dot: "bg-amber-300",
    label: "Clustered",
    tooltip:
      "Several moments are bunched together. Open Insights to see distribution.",
  },
  quiet: {
    dot: "bg-amber-300",
    label: "Quiet sections",
    tooltip:
      "Parts of the video have no detected activity. Open Insights to find them.",
  },
  empty: {
    dot: "bg-white/30",
    label: "No moments",
    tooltip: "No moments on the timeline yet.",
  },
};

/**
 * The single AI-health pip the simplified header exposes. Replaces the old
 * Balanced + density + 1/4-quiet chip cluster. Hover for detail; click
 * "Insights" for the full panel.
 */
function HealthDot({ health }: { health: TimelineHealth }) {
  const cfg = HEALTH_PRESENTATION[health];
  return (
    <span
      title={cfg.tooltip}
      className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-2 py-[3px] text-[11px] font-medium text-fog"
    >
      <span className={cn("size-1.5 rounded-full", cfg.dot)} />
      <span>{cfg.label}</span>
    </span>
  );
}

const TIPS = [
  ["Drag a pill", "to move it"],
  ["Drag the edges", "to retime"],
  ["Click anywhere on the lane", "to seek"],
  ["Shift / ⌘ + click", "to multi-select"],
  ["Del / Backspace", "to remove selection"],
  ["⌘D", "to duplicate"],
  ["Esc", "to clear multi-select"],
] as const;

function TipsPopover() {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Timeline shortcuts"
        className={cn(
          "inline-flex size-8 items-center justify-center rounded-lg border text-fog transition-colors duration-150",
          open
            ? "border-violet-400/40 bg-violet-500/12 text-violet-100"
            : "border-white/10 bg-white/[0.025] hover:border-white/25 hover:text-white"
        )}
      >
        <HelpCircle size={13} />
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-40 w-72 overflow-hidden rounded-xl border border-white/10 bg-ink/95 shadow-cinematic backdrop-blur-xl">
          <div className="border-b border-white/[0.06] px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
            Shortcuts
          </div>
          <ul className="space-y-1.5 px-4 py-3 text-[12px]">
            {TIPS.map(([action, hint]) => (
              <li
                key={action}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="text-white/85">{action}</span>
                <span className="text-fog">{hint}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
