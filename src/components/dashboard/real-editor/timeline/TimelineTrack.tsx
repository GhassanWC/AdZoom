"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import type { LucideIcon } from "lucide-react";
import type { TimelineTrackTone } from "./trackModel";

/**
 * A single timeline row. The pills + markers inside are absolutely positioned
 * by `left:%` / `width:%`; this component just provides the row container so
 * vertical containment is automatic (no more stacking everything onto one
 * lane). The orchestrator owns the left label gutter — `TimelineTrack` is
 * intentionally lane-only.
 */
export function TimelineTrack({
  height,
  className,
  children,
  ariaLabel,
  dimmed,
}: {
  height: number;
  className?: string;
  children: React.ReactNode;
  ariaLabel: string;
  /** Placeholder / read-only lanes render with a faint recessed surface. */
  dimmed?: boolean;
}) {
  return (
    <div
      role="row"
      aria-label={ariaLabel}
      className={cn(
        "relative border-b border-white/[0.04] last:border-b-0",
        dimmed && "bg-white/[0.012]",
        className
      )}
      style={{ height }}
    >
      {children}
    </div>
  );
}

const TONE_TINT: Record<TimelineTrackTone, string> = {
  violet: "text-violet-200",
  cyan: "text-cyan-200",
  amber: "text-amber-200",
  teal: "text-teal-200",
  rose: "text-rose-200",
  fog: "text-fog",
  sky: "text-sky-200",
  pink: "text-pink-200",
  blue: "text-blue-200",
  emerald: "text-emerald-200",
  orange: "text-orange-200",
  purple: "text-purple-200",
  lime: "text-lime-200",
  slate: "text-slate-200",
};

/**
 * The left-side label gutter shown alongside each track. Sits outside the
 * horizontally-scrolling lane area, so it's always visible regardless of
 * scroll position. Shows the label from `md` up; collapses to an icon (with a
 * title tooltip) on the narrowest gutters.
 */
export function TrackLabel({
  Icon,
  label,
  count,
  height,
  tone = "violet",
  comingSoon,
  note,
  trailing,
}: {
  Icon: LucideIcon;
  label: string;
  count?: number;
  height: number;
  tone?: TimelineTrackTone;
  comingSoon?: boolean;
  /** Subtle line shown in place of the count (e.g. "Disabled for this analysis"). */
  note?: string;
  /** Optional trailing control (e.g. an overlay lane's ⋯ menu). Shown on md+. */
  trailing?: React.ReactNode;
}) {
  const tint = comingSoon ? "text-fog/55" : TONE_TINT[tone];
  return (
    <div
      title={label}
      style={{ height }}
      className="flex items-center gap-2 border-b border-white/[0.04] pr-1 last:border-b-0"
    >
      <span
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.03] ring-1 ring-white/10",
          tint
        )}
      >
        <Icon size={13} />
      </span>
      <div className="hidden min-w-0 md:block">
        <div
          className={cn(
            "flex items-center gap-1 text-[11.5px] font-semibold leading-tight",
            tint
          )}
        >
          <span className="truncate">{label}</span>
        </div>
        {comingSoon ? (
          <div className="text-[9.5px] font-medium uppercase tracking-[0.12em] leading-tight text-fog/45">
            Soon
          </div>
        ) : note ? (
          <div
            title={note}
            className="truncate text-[9.5px] font-medium leading-tight text-fog/55"
          >
            {note}
          </div>
        ) : (
          typeof count === "number" && (
            <div className="font-mono text-[10px] leading-tight text-fog">
              {count}
            </div>
          )
        )}
      </div>
      {trailing && <div className="ml-auto hidden shrink-0 md:flex">{trailing}</div>}
    </div>
  );
}
