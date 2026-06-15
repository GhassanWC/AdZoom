"use client";

import { cn } from "@/lib/cn";

export interface FilterOption {
  value: string;
  label: string;
}

/** Compact styled native select for table filters. Empty value = "All". */
export function FilterSelect({
  value,
  onChange,
  options,
  allLabel = "All",
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: FilterOption[];
  allLabel?: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-10 rounded-full border border-white/10 bg-white/[0.02] px-4 text-sm text-white/90 outline-none focus:border-violet-500/50",
        className
      )}
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
