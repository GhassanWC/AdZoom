"use client";

import { cn } from "@/lib/cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  /** Optional pill shown after the label (e.g. "Recommended"). */
  badge?: string;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  ariaLabel?: string;
  className?: string;
}

/**
 * A vertical radio group — a stack of selectable rows, each with a label,
 * optional description, and a selected dot. Styled to match `Toggle`
 * (violet accent when selected, `text-fog` descriptions). Used for choices
 * where the options need explaining, not a compact horizontal segment.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("space-y-2", className)}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink",
              selected
                ? "border-violet-500/45 bg-violet-500/[0.08]"
                : "border-white/10 bg-white/[0.02] hover:border-white/20"
            )}
          >
            <span
              aria-hidden
              className={cn(
                "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-150",
                selected ? "border-violet-400 bg-violet-500/30" : "border-white/20"
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full bg-violet-200 transition-opacity duration-150",
                  selected ? "opacity-100" : "opacity-0"
                )}
              />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-white/90">{opt.label}</span>
                {opt.badge && (
                  <span className="rounded-full border border-violet-400/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-200">
                    {opt.badge}
                  </span>
                )}
              </span>
              {opt.description && (
                <span className="mt-0.5 block text-xs leading-relaxed text-fog">
                  {opt.description}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
