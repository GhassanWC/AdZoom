"use client";

import { cn } from "@/lib/cn";
import { RANGE_OPTIONS, type RangeKey } from "@/lib/admin/range";

/** Compact horizontal range toggle (today / 7d / 30d / all). */
export function DateRangeSelector({
  value,
  onChange,
  className,
}: {
  value: RangeKey;
  onChange: (v: RangeKey) => void;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Date range"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.02] p-0.5",
        className
      )}
    >
      {RANGE_OPTIONS.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-150",
              selected
                ? "bg-violet-500/20 text-white"
                : "text-fog hover:text-white"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
