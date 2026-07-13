"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * A single timeline row, and the ONLY thing a timeline row is: a strip of time.
 * The pills + markers inside are absolutely positioned by `left:%` / `width:%`;
 * this component just provides the row container so vertical containment is
 * automatic (no more stacking everything onto one lane).
 *
 * There is no companion `TrackLabel` any more — the left classifier gutter it
 * used to fill (icon · name · count · ⋯) has been deleted, and the row starts at
 * x=0. The lane's identity lives in `ariaLabel`, which costs no pixels.
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
