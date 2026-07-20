"use client";

/**
 * Compact metric tile.
 *
 * Two things it deliberately does that the old one did not:
 *
 * • `value == null` renders an em-dash, not 0. A failed count aggregation used
 *   to be coerced to 0 and shown next to a populated chart — the single most
 *   misleading thing the old dashboard did. "No answer" and "zero" must look
 *   different.
 *
 * • `caveat` marks a number as partial (scan cap hit, derived proxy) right on
 *   the card. Previously, sample-limited values sat in the same row as exact
 *   counts with identical styling and no disclosure at all.
 *
 * The dead `spark` prop is gone: no page ever passed it, and `Sparkline`
 * rendered without a viewBox so the stretched polyline would have been clipped.
 */

import * as React from "react";
import { cn } from "@/lib/cn";
import { AdminCard, IconChip, MicroLabel } from "./AdminCard";

export type MetricTone = "default" | "accent" | "good" | "warn" | "bad";

export function MetricCard({
  label,
  value,
  sub,
  caveat,
  icon,
  tone = "default",
  className,
}: {
  label: string;
  /** Pre-formatted value, or null for "no data" (renders "—"). */
  value: React.ReactNode;
  sub?: string;
  caveat?: string;
  icon?: React.ReactNode;
  tone?: MetricTone;
  className?: string;
}) {
  return (
    <AdminCard interactive className={cn("flex items-start gap-3", className)}>
      {icon && <IconChip tone={tone}>{icon}</IconChip>}
      <div className="min-w-0 flex-1">
        <MicroLabel>{label}</MicroLabel>
        <div
          className={cn(
            "mt-1 font-display text-2xl font-semibold leading-none tracking-tight tabular-nums",
            tone === "bad" ? "text-rose-300" : "text-text-primary"
          )}
        >
          {value ?? "—"}
        </div>
        {sub && <p className="mt-1.5 truncate text-xs text-text-muted" title={sub}>{sub}</p>}
        {caveat && (
          <p className="mt-1 text-[11px] leading-snug text-amber-300/80">{caveat}</p>
        )}
      </div>
    </AdminCard>
  );
}

/**
 * Responsive metric grid — steps 1 → 2 → 4 columns. The old grid jumped
 * straight from 2 to 4 with no intermediate step, so at 375px two `text-3xl`
 * numbers and an icon shared one row and long values wrapped.
 */
export function MetricGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}
