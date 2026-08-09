"use client";

import * as React from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

interface Props {
  icon: React.ReactNode;
  title: string;
  description: string;
  /** Right-aligned verb ("Update", "View"). Rendered as a pill, not a button. */
  actionLabel: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  /** Muted treatment for destructive-ish rows (cancel). */
  tone?: "default" | "quiet";
  className?: string;
}

/**
 * One line of the "Payment & invoices" card — the whole row is the target.
 *
 * Why the entire row and not just a trailing button: managing billing is
 * something people do rarely and anxiously, usually while annoyed about a
 * charge. A 56px-tall click target that reads "Payment method — update the
 * card we charge →" removes every bit of guesswork about where to click.
 *
 * Every row leaves the app (Lemon Squeezy hosts these pages), so each one
 * carries an outbound arrow and says so in its accessible name.
 */
export function BillingActionRow({
  icon,
  title,
  description,
  actionLabel,
  onClick,
  loading = false,
  disabled = false,
  tone = "default",
  className,
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-label={`${title} — ${actionLabel} (opens in your browser)`}
      className={cn(
        "group flex w-full items-center gap-3.5 rounded-xl px-3 py-3 text-left transition-colors duration-200",
        "hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60",
        "disabled:pointer-events-none disabled:opacity-50",
        className
      )}
    >
      <span
        className={cn(
          "inline-flex size-9 shrink-0 items-center justify-center rounded-lg border transition-colors duration-200",
          tone === "quiet"
            ? "border-white/[0.06] bg-white/[0.02] text-fog"
            : "border-white/10 bg-white/[0.04] text-white group-hover:border-violet-400/40 group-hover:text-violet-300"
        )}
      >
        {loading ? <Loader2 size={15} className="animate-spin" /> : icon}
      </span>

      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm font-medium", tone === "quiet" ? "text-white/75" : "text-white")}>
          {title}
        </span>
        <span className="mt-0.5 block truncate text-xs text-fog">{description}</span>
      </span>

      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-white/80",
          "transition-colors duration-200 group-hover:border-white/20 group-hover:text-white"
        )}
      >
        {loading ? "Opening…" : actionLabel}
        <ArrowUpRight size={12} className="opacity-70" />
      </span>
    </button>
  );
}
