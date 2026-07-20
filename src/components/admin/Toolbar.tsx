"use client";

/**
 * Filter controls, all on ONE control height.
 *
 * The old admin mixed heights in the same header row — `FilterSelect` was h-10,
 * the events input h-10, `DateRangeSelector` computed to ~36px and the load-more
 * button was h-9 — so Overview's control visibly sat shorter than every other
 * page's. Everything here is h-9.
 *
 * Focus states are also unified. Two of the three old controls signalled focus
 * with only a 1px 50%-alpha border shift; all of these use the same 2px violet
 * focus ring.
 */

import * as React from "react";
import { Search, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { RANGE_OPTIONS, type RangeKey } from "@/lib/admin/range";

const CONTROL =
  "h-9 rounded-lg border border-border-soft bg-button-bg-soft text-xs text-text-primary transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60";

/** Row wrapper — wraps on narrow screens instead of overflowing. */
export function Toolbar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  label,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search
        size={14}
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className={cn(CONTROL, "w-full pl-8 pr-8 placeholder:text-text-muted sm:w-56")}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}

export function FilterSelect({
  value,
  onChange,
  options,
  allLabel,
  label,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
  label: string;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className={cn(CONTROL, "px-2.5 capitalize", className)}
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

/**
 * Date range: quick presets plus an explicit custom from/to.
 *
 * Only Overview had any date control before; the list pages could not be scoped
 * at all. Explicit `from`/`to` take precedence over the preset server-side (see
 * lib/admin/params.ts), so setting either switches the control to "Custom".
 */
export function DateRangeFilter({
  range,
  from,
  to,
  onRangeChange,
  onFromChange,
  onToChange,
}: {
  range: RangeKey;
  from: string;
  to: string;
  onRangeChange: (r: RangeKey) => void;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
}) {
  const custom = Boolean(from || to);
  const [showCustom, setShowCustom] = React.useState(custom);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="radiogroup"
        aria-label="Date range"
        className="flex h-9 items-center gap-0.5 rounded-lg border border-border-soft bg-button-bg-soft p-0.5"
      >
        {RANGE_OPTIONS.map((o) => {
          const active = !custom && range === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                onFromChange("");
                onToChange("");
                setShowCustom(false);
                onRangeChange(o.value);
              }}
              className={cn(
                "h-8 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60",
                active
                  ? "bg-violet-500/15 text-violet-200"
                  : "text-text-muted hover:text-text-primary"
              )}
            >
              {o.label}
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={custom}
          onClick={() => setShowCustom((s) => !s)}
          className={cn(
            "h-8 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60",
            custom ? "bg-violet-500/15 text-violet-200" : "text-text-muted hover:text-text-primary"
          )}
        >
          Custom
        </button>
      </div>

      {showCustom && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => onFromChange(e.target.value)}
            aria-label="From date"
            className={cn(CONTROL, "px-2")}
          />
          <span className="text-xs text-text-muted">→</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => onToChange(e.target.value)}
            aria-label="To date"
            className={cn(CONTROL, "px-2")}
          />
          {custom && (
            <button
              type="button"
              onClick={() => {
                onFromChange("");
                onToChange("");
              }}
              className="text-xs text-text-muted underline-offset-2 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Refresh action. Every admin page has one now — none did before. */
export function RefreshButton({
  onClick,
  busy,
  updatedAt,
}: {
  onClick: () => void;
  busy?: boolean;
  updatedAt?: number | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label="Refresh data"
      title={updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : "Refresh data"}
      className={cn(CONTROL, "inline-flex items-center gap-1.5 px-2.5 disabled:opacity-60")}
    >
      <RefreshCw size={13} aria-hidden className={cn(busy && "animate-spin")} />
      <span className="hidden sm:inline">Refresh</span>
    </button>
  );
}
