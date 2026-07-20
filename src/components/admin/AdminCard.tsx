"use client";

/**
 * The admin design primitives — ONE spec per role.
 *
 * The audit found the same visual role implemented three or four different ways
 * across the admin pages: card padding was p-4 / p-5 / p-6 depending on the
 * file, the micro-label above a value came in three type specs, icon chips came
 * in four size/radius combinations, and `DataTable` hand-rolled its own card
 * shell so tables silently lacked the hover border every other card had.
 *
 * Everything below is built from these primitives so that can't recur. All
 * colours use the SEMANTIC tokens (`text-text-primary`, `border-border-soft`,
 * `bg-surface`), which flip correctly in light mode — the old admin used raw
 * `text-white` / `text-fog` and was effectively dark-only.
 */

import * as React from "react";
import { cn } from "@/lib/cn";

/** The single card shell. `pad` picks the ONE compact padding scale. */
export function AdminCard({
  className,
  pad = "md",
  interactive = false,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  pad?: "none" | "sm" | "md";
  interactive?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border-soft bg-surface/70 shadow-[0_1px_2px_rgba(0,0,0,0.18)] backdrop-blur-sm",
        interactive && "transition-colors duration-200 hover:border-border-strong",
        pad === "sm" && "p-3.5",
        pad === "md" && "p-4",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * THE micro-label spec — the uppercase caption above a metric value, a chart
 * title's eyebrow and a table column header all use this exact style.
 */
export function MicroLabel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted",
        className
      )}
    >
      {children}
    </span>
  );
}

/** THE icon chip spec — size-8 / rounded-lg, glyphs rendered at 15px. */
export function IconChip({
  tone = "default",
  className,
  children,
}: {
  tone?: "default" | "accent" | "good" | "warn" | "bad";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg border",
        tone === "default" && "border-border-soft bg-button-bg-soft text-text-muted",
        tone === "accent" && "border-violet-400/25 bg-violet-500/10 text-violet-300",
        tone === "good" && "border-emerald-400/25 bg-emerald-500/10 text-emerald-300",
        tone === "warn" && "border-amber-400/25 bg-amber-500/10 text-amber-300",
        tone === "bad" && "border-rose-400/25 bg-rose-500/10 text-rose-300",
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * A titled section (charts, tables, grouped lists).
 *
 * `caveat` exists because several admin numbers are legitimately partial — a
 * scan that hit its cap, or a metric Firestore can only approximate. Rather
 * than silently presenting those as exact (which is what the old sampled charts
 * did), the caveat renders as a footnote under the title.
 */
export function SectionCard({
  title,
  subtitle,
  total,
  caveat,
  action,
  className,
  bodyClassName,
  children,
}: {
  title: string;
  subtitle?: string;
  total?: React.ReactNode;
  caveat?: string;
  action?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <AdminCard pad="none" className={cn("flex flex-col overflow-hidden", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pb-3 pt-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            {total != null && (
              <span className="text-sm tabular-nums text-text-secondary">{total}</span>
            )}
          </div>
          {subtitle && <p className="mt-0.5 text-xs text-text-muted">{subtitle}</p>}
          {caveat && <p className="mt-1 text-[11px] leading-snug text-amber-300/80">{caveat}</p>}
        </div>
        {action}
      </div>
      <div className={cn("px-4 pb-4", bodyClassName)}>{children}</div>
    </AdminCard>
  );
}

/** Page-level heading. Compact, with a slot for the toolbar. */
export function AdminPageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-xl font-semibold tracking-tight text-text-primary sm:text-2xl">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
