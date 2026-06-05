"use client";

/**
 * Shared presentational bits for the editor diagnostics panels
 * (`ClickPipelinePanel`, `EditDiagnosticsPanel`). Extracted so both panels
 * render identical stat cards / fields / stages without duplication.
 */

import * as React from "react";

export type DiagTone = "ok" | "warn" | "error";

/** Large headline stat card. */
export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: DiagTone;
}) {
  const toneBg =
    tone === "error"
      ? "border-rose-400/30 bg-rose-500/10"
      : tone === "warn"
        ? "border-amber-400/30 bg-amber-500/10"
        : tone === "ok"
          ? "border-emerald-400/30 bg-emerald-500/10"
          : "border-white/10 bg-white/[0.03]";
  return (
    <div className={`rounded-lg border px-3 py-2 ${toneBg}`}>
      <div className="text-[10px] uppercase tracking-wider text-fog">
        {label}
      </div>
      <div className="text-[18px] font-semibold text-white">{value}</div>
    </div>
  );
}

/** Label/value row used inside a Stage. */
export function Field({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: DiagTone;
}) {
  const toneColor =
    tone === "error"
      ? "text-rose-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "ok"
          ? "text-emerald-300"
          : "text-white/85";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] text-fog">{label}</span>
      <span
        className={`text-[12px] ${toneColor} ${
          mono ? "font-mono text-[11px]" : ""
        } break-all text-right`}
      >
        {value}
      </span>
    </div>
  );
}

/** Numbered, titled section with an optional right-aligned status. */
export function Stage({
  n,
  title,
  right,
  tone,
  children,
}: {
  n: number;
  title: string;
  right?: string;
  tone?: DiagTone;
  children: React.ReactNode;
}) {
  const toneColor =
    tone === "error"
      ? "text-rose-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "ok"
          ? "text-emerald-300"
          : "text-fog";
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-5 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-[10px] font-semibold text-fog">
            {n}
          </span>
          <h4 className="text-[13px] font-semibold text-white">{title}</h4>
        </div>
        {right && (
          <span className={`text-[11px] uppercase tracking-wider ${toneColor}`}>
            {right}
          </span>
        )}
      </div>
      <div className="mt-2 space-y-1.5">{children}</div>
    </div>
  );
}
