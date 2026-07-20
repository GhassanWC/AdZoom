"use client";

/**
 * The shared admin table.
 *
 * Fixes carried over from the audit:
 *  • STICKY HEADER — column names stay visible while scrolling a long page.
 *  • KEYBOARD-OPERABLE ROWS. Clickable rows previously attached `onClick` to a
 *    bare `<tr>` with no tabIndex, role or key handler, so the Projects page's
 *    entire video-preview feature was unreachable without a mouse. Rows now
 *    render as real buttons when interactive.
 *  • `scope="col"` on headers and a `<caption>`, so screen readers announce
 *    column context per cell instead of reading a flat grid.
 *  • A SCROLL AFFORDANCE. Tables still scroll horizontally on mobile (that is
 *    the right call over truncation), but the first column is sticky so the
 *    identifying value never scrolls out of view, and an edge fade signals
 *    there is more to the right.
 *  • It is built on `AdminCard`, so tables finally share the border, radius and
 *    shadow of every other card instead of hand-rolling their own shell.
 */

import * as React from "react";
import { cn } from "@/lib/cn";
import { AdminCard } from "./AdminCard";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  align?: "left" | "right" | "center";
  /** Render in a monospaced cell (ids, hashes). */
  mono?: boolean;
  /** Hide below the `sm` breakpoint — for secondary columns on mobile. */
  hideOnMobile?: boolean;
  className?: string;
  headerClassName?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowLabel,
  minWidth = 720,
  caption,
  className,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Accessible name for an interactive row, e.g. `(r) => \`Open ${r.title}\``. */
  rowLabel?: (row: T) => string;
  minWidth?: number;
  caption: string;
  className?: string;
}) {
  const interactive = Boolean(onRowClick);

  return (
    <AdminCard pad="none" className={cn("relative overflow-hidden", className)}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" style={{ minWidth }}>
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur">
            <tr className="border-b border-border-soft">
              {columns.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    "whitespace-nowrap px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted",
                    c.align === "right" && "text-right",
                    c.align === "center" && "text-center",
                    c.align !== "right" && c.align !== "center" && "text-left",
                    // The first column stays put while the rest scrolls.
                    i === 0 && "sticky left-0 z-20 bg-surface/95 backdrop-blur",
                    c.hideOnMobile && "hidden sm:table-cell",
                    c.headerClassName
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-soft">
            {rows.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  key={key}
                  className={cn(
                    "group transition-colors duration-150",
                    interactive
                      ? "cursor-pointer hover:bg-button-bg-soft focus-within:bg-button-bg-soft"
                      : "hover:bg-button-bg-soft/60"
                  )}
                  onClick={interactive ? () => onRowClick?.(row) : undefined}
                >
                  {columns.map((c, i) => (
                    <td
                      key={c.key}
                      className={cn(
                        "px-4 py-2.5 align-middle text-text-secondary",
                        c.align === "right" && "text-right",
                        c.align === "center" && "text-center",
                        c.mono && "font-mono text-xs",
                        // Sticky first column carries its own background so the
                        // scrolled content passes underneath, not through it.
                        i === 0 &&
                          "sticky left-0 z-10 bg-surface/95 backdrop-blur group-hover:bg-[color-mix(in_srgb,var(--color-surface)_95%,white_5%)]",
                        c.hideOnMobile && "hidden sm:table-cell",
                        c.className
                      )}
                    >
                      {/* The interactive affordance lives on a real button in
                          the first cell, so the row is reachable and activatable
                          by keyboard rather than mouse-only. */}
                      {i === 0 && interactive ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRowClick?.(row);
                          }}
                          className="block w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
                          aria-label={rowLabel?.(row)}
                        >
                          {c.render(row)}
                        </button>
                      ) : (
                        c.render(row)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Edge fade: signals horizontal overflow without occluding content. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface to-transparent sm:hidden"
      />
    </AdminCard>
  );
}

/** Two-line cell: a primary value with a muted secondary line beneath. */
export function CellStack({
  primary,
  secondary,
  title,
}: {
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-text-primary">{primary}</div>
      {secondary != null && (
        <div className="truncate text-xs text-text-muted">{secondary}</div>
      )}
    </div>
  );
}
