"use client";

import { cn } from "@/lib/cn";

export type TagTone = "violet" | "emerald" | "rose" | "amber" | "cyan" | "neutral";

const toneStyles: Record<TagTone, string> = {
  violet: "border-violet-400/30 bg-violet-400/10 text-violet-200",
  emerald: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  rose: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  amber: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  cyan: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  neutral: "border-white/10 bg-white/[0.03] text-fog",
};

export function Tag({
  label,
  tone = "neutral",
  className,
}: {
  label: string;
  tone?: TagTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        toneStyles[tone],
        className
      )}
    >
      {label}
    </span>
  );
}

/** Map a plan tier to a tag tone. */
export function planTone(plan: string | null | undefined): TagTone {
  if (plan === "pro") return "violet";
  if (plan === "creator") return "cyan";
  return "neutral";
}

/** Map a project/export/analysis/subscription status to a tag tone. */
export function statusTone(status: string | null | undefined): TagTone {
  switch (status) {
    case "ready":
    case "complete":
    case "completed":
    case "analyzed":
    case "exported":
    case "active":
    case "on_trial":
      return "emerald";
    case "failed":
    case "cancelled":
    case "expired":
    case "unpaid":
      return "rose";
    case "running":
    case "analyzing":
    case "exporting":
    case "cv-running":
    case "permitted":
      return "violet";
    case "past_due":
    case "paused":
      return "amber";
    default:
      return "neutral";
  }
}
