"use client";

/**
 * Loading / empty / error / partial-data states.
 *
 * The old set had one centred spinner (`LoadingPanel`) used by all eight pages,
 * and `ErrorPanel` accepted only a message — there was no retry affordance
 * anywhere in the admin, so any failed load was a dead end requiring a browser
 * reload. Skeletons here mirror the real layout so the page does not jump when
 * data lands, and every failure state carries an action.
 */

import * as React from "react";
import { AlertTriangle, Inbox, RefreshCw, DatabaseZap, Info } from "lucide-react";
import { cn } from "@/lib/cn";
import { AdminCard } from "./AdminCard";

/** One shimmering placeholder block. */
export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={cn("shimmer rounded-md bg-button-bg-soft", className)} style={style} aria-hidden />
  );
}

/** Matches the metric grid, so cards don't pop in at a different height. */
export function MetricGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <AdminCard key={i} className="flex items-start gap-3">
          <Skeleton className="size-8 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-2.5 w-24" />
          </div>
        </AdminCard>
      ))}
    </div>
  );
}

/** Matches a chart card. */
export function ChartSkeleton({ height = 180 }: { height?: number }) {
  return (
    <AdminCard pad="none" className="overflow-hidden">
      <div className="space-y-2 px-4 pb-3 pt-4">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-2.5 w-20" />
      </div>
      <div className="px-4 pb-4">
        <Skeleton className="w-full rounded-lg" style={{ height }} />
      </div>
    </AdminCard>
  );
}

/** Matches the data table, including its header row. */
export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <AdminCard pad="none" className="overflow-hidden">
      <div className="border-b border-border-soft bg-button-bg-soft/50 px-4 py-2.5">
        <div className="flex gap-4">
          {Array.from({ length: cols }, (_, i) => (
            <Skeleton key={i} className="h-2.5 flex-1" />
          ))}
        </div>
      </div>
      <div className="divide-y divide-border-soft">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex gap-4 px-4 py-3">
            {Array.from({ length: cols }, (_, c) => (
              <Skeleton key={c} className="h-3 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </AdminCard>
  );
}

/** Full-page first-load skeleton: metrics + charts + table. */
export function PageSkeleton({
  metrics = 4,
  charts = 2,
  table = true,
}: {
  metrics?: number;
  charts?: number;
  table?: boolean;
}) {
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading admin data…
      </span>
      <MetricGridSkeleton count={metrics} />
      {charts > 0 && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {Array.from({ length: charts }, (_, i) => (
            <ChartSkeleton key={i} />
          ))}
        </div>
      )}
      {table && <TableSkeleton />}
    </div>
  );
}

/**
 * Error state WITH a retry action — the absence of this is why a transient
 * Firestore hiccup used to strand the entire page.
 */
export function ErrorPanel({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <AdminCard
      role="alert"
      className={cn("flex flex-col items-center gap-3 py-10 text-center", className)}
    >
      <span className="grid size-10 place-items-center rounded-full border border-rose-400/25 bg-rose-500/10 text-rose-300">
        <AlertTriangle size={18} aria-hidden />
      </span>
      <div>
        <p className="text-sm font-medium text-text-primary">Couldn’t load this data</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-text-muted">{message}</p>
      </div>
      {onRetry && <RetryButton onClick={onRetry} label="Try again" />}
    </AdminCard>
  );
}

export function EmptyPanel({
  label,
  hint,
  className,
}: {
  label: string;
  hint?: string;
  className?: string;
}) {
  return (
    <AdminCard className={cn("flex flex-col items-center gap-2 py-10 text-center", className)}>
      <span className="grid size-10 place-items-center rounded-full border border-border-soft bg-button-bg-soft text-text-muted">
        <Inbox size={18} aria-hidden />
      </span>
      <p className="text-sm font-medium text-text-primary">{label}</p>
      {hint && <p className="max-w-md text-xs text-text-muted">{hint}</p>}
    </AdminCard>
  );
}

/**
 * Small inline empty state for a chart body. Previously copy-pasted verbatim
 * into four page files at two different heights.
 */
export function EmptyInline({ label = "No data in this range." }: { label?: string }) {
  return (
    <div className="grid h-32 place-items-center rounded-lg border border-dashed border-border-soft text-xs text-text-muted">
      {label}
    </div>
  );
}

/**
 * A composite Firestore index is deployed but still building — a friendly 200
 * state, not an error, because builds take minutes.
 */
export function IndexBuildingPanel({ onRetry }: { onRetry?: () => void }) {
  return (
    <AdminCard className="flex flex-col items-center gap-3 py-10 text-center">
      <span className="grid size-10 place-items-center rounded-full border border-amber-400/25 bg-amber-500/10 text-amber-300">
        <DatabaseZap size={18} aria-hidden />
      </span>
      <div>
        <p className="text-sm font-medium text-text-primary">Firestore indexes are building</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-text-muted">
          This view needs an index that isn’t ready yet. Building usually takes a few minutes
          after deploy — check back shortly.
        </p>
      </div>
      {onRetry && <RetryButton onClick={onRetry} label="Check again" />}
    </AdminCard>
  );
}

function RetryButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-2 rounded-full border border-border-strong bg-button-bg-soft px-4 text-xs font-medium text-text-primary transition-colors hover:bg-button-bg-soft-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
    >
      <RefreshCw size={14} aria-hidden />
      {label}
    </button>
  );
}

/**
 * Honest disclosure that a scan hit its cap, so the page's totals are a floor
 * rather than a total. The old dashboard truncated silently at 1000/5000 docs
 * and presented the result as complete.
 */
export function TruncationNotice({ scanned, className }: { scanned: number; className?: string }) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-500/[0.07] px-3 py-2 text-[11px] leading-snug text-amber-200/90",
        className
      )}
    >
      <Info size={13} className="mt-px shrink-0" aria-hidden />
      <span>
        Showing the most recent {scanned.toLocaleString("en-US")} records — this query hit its
        scan limit, so totals on this page are a minimum rather than a complete count. Narrow the
        date range for exact figures.
      </span>
    </div>
  );
}

/** Thin progress bar shown while refetching with data already on screen. */
export function RefreshingBar({ active }: { active: boolean }) {
  return (
    <div className="h-0.5 w-full overflow-hidden rounded-full" aria-hidden={!active}>
      {active && (
        <div className="shimmer h-full w-full rounded-full bg-violet-400/50" role="status" aria-label="Refreshing" />
      )}
    </div>
  );
}
