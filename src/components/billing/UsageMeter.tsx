"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export type MeterTone = "ok" | "warn" | "danger";

interface Props {
  label: string;
  /** Pre-formatted readout, e.g. `"12 / 150 min"` or `"426 MB / 50 GB"`. */
  valueText: string;
  /** 0..1 fill. Clamped; non-finite is treated as full (uncapped allowances). */
  fraction: number;
  /** Left footnote — what the number means ("138 min left"). */
  note: string;
  /** Right footnote — when the allowance refills. Omit for non-periodic meters. */
  resetNote?: string | null;
  tone?: MeterTone;
  loading?: boolean;
  className?: string;
}

/**
 * A plan-allowance meter.
 *
 * Deliberately COMPACT: the previous billing layout stretched three of these
 * to equal height in a CSS grid, so each one carried ~60px of content in a
 * ~250px card. Sized by content, three meters read as one row of facts
 * instead of three mostly-empty panels.
 *
 * The numbers themselves are always passed in from the shared usage hooks —
 * never computed here — so a meter can't drift from the limit the server
 * enforces.
 */
export function UsageMeter({
  label,
  valueText,
  fraction,
  note,
  resetNote,
  tone = "ok",
  loading = false,
  className,
}: Props) {
  const pct = Number.isFinite(fraction) ? Math.min(100, Math.max(0, fraction * 100)) : 100;
  // A hair of fill at 0% so the bar reads as a track with a start, not as an
  // empty rule the user might mistake for a loading state.
  const width = pct > 0 && pct < 1.5 ? 1.5 : pct;

  return (
    <div className={cn("glass rounded-2xl p-5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-white">{label}</span>
        <span
          className={cn(
            "font-mono text-xs tabular-nums",
            tone === "danger" ? "text-rose-300" : tone === "warn" ? "text-amber-200" : "text-fog"
          )}
        >
          {loading ? "—" : valueText}
        </span>
      </div>

      <div
        className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={loading ? undefined : Math.round(pct)}
        aria-valuetext={loading ? "Loading" : valueText}
      >
        {loading ? (
          <div className="shimmer h-full w-full" />
        ) : (
          <div
            data-tone={tone}
            className="usage-bar h-full rounded-full transition-[width] duration-500 ease-[var(--ease-out)]"
            style={{ width: `${width}%` }}
          />
        )}
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-3 text-[11px]">
        <span
          className={cn(
            "min-w-0 truncate",
            tone === "danger" ? "text-rose-300" : tone === "warn" ? "text-amber-200" : "text-fog"
          )}
        >
          {loading ? "Loading…" : note}
        </span>
        {resetNote && !loading && (
          <span className="shrink-0 text-fog/80">{resetNote}</span>
        )}
      </div>
    </div>
  );
}
