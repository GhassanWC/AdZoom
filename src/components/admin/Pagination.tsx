"use client";

/**
 * Page-based pagination.
 *
 * The old admin used a "Load more" button driven by opaque Firestore cursors,
 * which meant you could only ever go forward, never jump, and never see how
 * much data there was. Because every list route now derives its page from one
 * scanned window (see lib/admin/scan.ts), an exact page count is available —
 * so this shows real position ("Page 2 of 7") and an accurate record range.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { PAGE_SIZES } from "@/lib/admin/params";

export function Pagination({
  page,
  pageCount,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  className,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  className?: string;
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-text-muted",
        className
      )}
    >
      <div className="flex items-center gap-3">
        <span aria-live="polite" className="tabular-nums">
          {total === 0 ? (
            "No records"
          ) : (
            <>
              <span className="text-text-secondary">
                {first.toLocaleString("en-US")}–{last.toLocaleString("en-US")}
              </span>{" "}
              of {total.toLocaleString("en-US")}
            </>
          )}
        </span>
        {onPageSizeChange && (
          <label className="flex items-center gap-1.5">
            <span className="sr-only">Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-7 rounded-md border border-border-soft bg-button-bg-soft px-1.5 text-xs text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
              aria-label="Rows per page"
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s} / page
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <PageButton
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          label="Previous page"
        >
          <ChevronLeft size={14} aria-hidden />
        </PageButton>
        <span className="px-1.5 tabular-nums text-text-secondary">
          Page {page} of {Math.max(1, pageCount)}
        </span>
        <PageButton
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          label="Next page"
        >
          <ChevronRight size={14} aria-hidden />
        </PageButton>
      </div>
    </nav>
  );
}

function PageButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid size-7 place-items-center rounded-md border border-border-soft bg-button-bg-soft text-text-secondary transition-colors hover:bg-button-bg-soft-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-button-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
    >
      {children}
    </button>
  );
}
