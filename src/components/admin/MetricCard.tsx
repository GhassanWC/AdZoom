"use client";

import * as React from "react";
import { GlassCard } from "@/components/ui/GlassCard";
import { cn } from "@/lib/cn";
import { Sparkline } from "./Charts";

/** Single headline metric tile. */
export function MetricCard({
  label,
  value,
  sub,
  icon,
  spark,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  spark?: number[];
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneText =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-200"
        : tone === "bad"
          ? "text-rose-300"
          : "text-white";

  return (
    <GlassCard padded={false} className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-fog">
            {label}
          </div>
          <div className={cn("mt-2 font-display text-3xl font-semibold tabular-nums", toneText)}>
            {value}
          </div>
          {sub && <div className="mt-1 text-xs text-fog">{sub}</div>}
        </div>
        {icon && (
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-violet-300">
            {icon}
          </span>
        )}
      </div>
      {spark && spark.length > 1 && (
        <div className="mt-3">
          <Sparkline values={spark} width={220} height={32} className="w-full" />
        </div>
      )}
    </GlassCard>
  );
}
