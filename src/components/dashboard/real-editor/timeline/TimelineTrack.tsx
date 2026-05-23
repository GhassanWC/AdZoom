"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import type { LucideIcon } from "lucide-react";

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
}: {
  height: number;
  className?: string;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <div
      role="row"
      aria-label={ariaLabel}
      className={cn(
        "relative border-b border-white/[0.04] last:border-b-0",
        className
      )}
      style={{ height }}
    >
      {children}
    </div>
  );
}

/**
 * The left-side label gutter shown alongside each track. Sits outside the
 * horizontally-scrolling lane area, so it's always visible regardless of
 * scroll position. Collapses to icon-only on small screens.
 */
export function TrackLabel({
  Icon,
  label,
  count,
  height,
  tone,
}: {
  Icon: LucideIcon;
  label: string;
  count?: number;
  height: number;
  tone?: "violet" | "cyan" | "fog";
}) {
  const tint =
    tone === "cyan"
      ? "text-cyan-200"
      : tone === "fog"
        ? "text-fog"
        : "text-violet-200";
  return (
    <div
      style={{ height }}
      className="flex items-center gap-2 border-b border-white/[0.04] pr-3 last:border-b-0"
    >
      <span
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.03] ring-1 ring-white/10",
          tint
        )}
      >
        <Icon size={13} />
      </span>
      <div className="hidden min-w-0 lg:block">
        <div className={cn("text-[11.5px] font-semibold leading-tight", tint)}>
          {label}
        </div>
        {typeof count === "number" && (
          <div className="font-mono text-[10px] leading-tight text-fog">
            {count}
          </div>
        )}
      </div>
    </div>
  );
}
