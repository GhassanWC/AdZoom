"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  align?: "left" | "right" | "center";
  /** Render value in a monospaced cell (ids, numbers). */
  mono?: boolean;
  className?: string;
}

/**
 * Generic, horizontally-scrollable data table styled to match the glass
 * design system. Used by every admin list page.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  minWidth = 640,
  className,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  minWidth?: number;
  className?: string;
}) {
  return (
    <div className={cn("glass overflow-hidden rounded-2xl", className)}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" style={{ minWidth }}>
          <thead>
            <tr className="border-b border-white/[0.06]">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    "px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-fog",
                    c.align === "right"
                      ? "text-right"
                      : c.align === "center"
                        ? "text-center"
                        : "text-left"
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={rowKey(row, i)}
                className="border-b border-white/[0.04] transition-colors duration-150 last:border-0 hover:bg-white/[0.02]"
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "px-4 py-3 align-middle text-white/85",
                      c.align === "right"
                        ? "text-right"
                        : c.align === "center"
                          ? "text-center"
                          : "text-left",
                      c.mono && "font-mono text-xs tabular-nums",
                      c.className
                    )}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
