"use client";

import * as React from "react";
import {
  Film,
  Activity,
  AlertTriangle,
  ZoomIn,
  ZoomOut,
  Bug,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { fmt } from "./utils";
import { PROVENANCE_PRESENTATION } from "./constants";
import { AttentionWaveform } from "./AttentionWaveform";

/**
 * Cinematic timeline header. Three zones:
 *   • Identity   — film glyph, title, live provenance counters.
 *   • Intelligence — attention sparkline + balance/density badges.
 *   • Tools — zoom controls, CV toggle, tips, time readout.
 *
 * Visual hierarchy is intentionally stronger than before: larger title,
 * thicker dividers between zones, and the attention readout is promoted
 * from a tooltip to a first-class chip with a live sparkline.
 */
export function TimelineHeader({
  aiCount,
  userCount,
  eventCount,
  cvCount,
  distScore,
  isClustered,
  densityPerMin,
  emptyQuartiles,
  showBalanceBadge,
  showDensityBadge,
  zoom,
  onZoomOut,
  onZoomIn,
  showCvDebugToggle,
  cvDebug,
  onToggleCvDebug,
  currentTime,
  total,
  attentionCurve,
}: {
  aiCount: number;
  userCount: number;
  eventCount?: number;
  cvCount?: number;
  distScore: number;
  isClustered: boolean;
  densityPerMin: number;
  emptyQuartiles: number;
  showBalanceBadge: boolean;
  showDensityBadge: boolean;
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  showCvDebugToggle: boolean;
  cvDebug: boolean;
  onToggleCvDebug: () => void;
  currentTime: number;
  total: number;
  attentionCurve?: number[];
}) {
  const provenanceEntries = [
    { key: "event" as const, count: eventCount ?? 0 },
    { key: "cv" as const, count: cvCount ?? 0 },
    { key: "ai" as const, count: aiCount },
    { key: "user" as const, count: userCount },
  ].filter((e) => e.count > 0);

  return (
    <div className="relative overflow-hidden border-b border-white/[0.08] px-6 py-4">
      {/* aurora */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 left-12 h-40 w-1/2 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.18),transparent_70%)] blur-3xl"
      />

      <div className="relative flex flex-wrap items-center justify-between gap-4">
        {/* ── Identity ───────────────────────────────────────────── */}
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="relative inline-flex size-11 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/30 to-violet-600/10 text-violet-100 ring-1 ring-violet-300/30 shadow-[0_8px_24px_-14px_rgba(139,92,246,0.7)]">
            <Film size={18} />
            <span
              aria-hidden
              className="absolute -inset-px rounded-2xl bg-gradient-to-br from-white/10 to-transparent opacity-60"
            />
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5">
              <h3 className="font-display text-[18px] font-semibold tracking-tight text-white">
                Timeline
              </h3>
              <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-fog/70">
                Attention-driven
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {provenanceEntries.length === 0 ? (
                <span className="text-[12px] text-fog">
                  No moments yet.
                </span>
              ) : (
                provenanceEntries.map((e) => (
                  <ProvenanceCounter
                    key={e.key}
                    kind={e.key}
                    count={e.count}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {/* ── Intelligence ───────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          {attentionCurve && attentionCurve.length > 0 && (
            <AttentionBadge curve={attentionCurve} />
          )}
          {showBalanceBadge && (
            <span
              title={`Distribution score: ${(distScore * 100).toFixed(
                0
              )}/100. Higher = more evenly spread.`}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[11.5px] font-medium",
                isClustered
                  ? "border-amber-400/40 bg-amber-500/[0.08] text-amber-100"
                  : "border-emerald-400/35 bg-emerald-400/[0.08] text-emerald-100"
              )}
            >
              <Activity size={12} />
              <span>
                {isClustered ? "Clustered" : "Balanced"}
                <span className="ml-1 font-mono tabular-nums opacity-80">
                  {(distScore * 100).toFixed(0)}
                </span>
              </span>
            </span>
          )}
          {showDensityBadge && (
            <span className="hidden rounded-xl border border-white/10 bg-white/[0.025] px-2.5 py-1.5 font-mono text-[11px] tabular-nums text-fog md:inline-flex">
              {densityPerMin.toFixed(1)}/min
            </span>
          )}
          {emptyQuartiles > 0 && (
            <span
              title="Some quartiles of the video have no detected activity"
              className="inline-flex items-center gap-1.5 rounded-xl border border-amber-400/40 bg-amber-500/[0.08] px-2.5 py-1.5 text-[11.5px] font-medium text-amber-100"
            >
              <AlertTriangle size={12} />
              {emptyQuartiles}/4 quiet
            </span>
          )}

          <span aria-hidden className="hidden h-7 w-px bg-white/10 lg:block" />

          <div className="hidden items-center gap-0.5 rounded-xl border border-white/10 bg-white/[0.025] p-1 sm:inline-flex">
            <button
              type="button"
              aria-label="Zoom timeline out"
              onClick={onZoomOut}
              disabled={zoom <= 1}
              className="inline-flex size-7 items-center justify-center rounded-lg text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white disabled:opacity-30"
            >
              <ZoomOut size={13} />
            </button>
            <span className="w-10 text-center font-mono text-[11px] tabular-nums text-fog">
              {zoom.toFixed(1)}×
            </span>
            <button
              type="button"
              aria-label="Zoom timeline in"
              onClick={onZoomIn}
              disabled={zoom >= 8}
              className="inline-flex size-7 items-center justify-center rounded-lg text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white disabled:opacity-30"
            >
              <ZoomIn size={13} />
            </button>
          </div>

          {showCvDebugToggle && (
            <button
              type="button"
              onClick={onToggleCvDebug}
              title="Toggle CV debug signals"
              className={cn(
                "hidden items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[11.5px] font-medium transition-colors duration-150 sm:inline-flex",
                cvDebug
                  ? "border-violet-400/45 bg-violet-500/15 text-violet-100"
                  : "border-white/10 bg-white/[0.025] text-fog hover:border-white/25 hover:text-white"
              )}
            >
              <Bug size={12} />
              CV
            </button>
          )}

          <TipsPopover />

          <span className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-[12px] font-medium tabular-nums text-white">
            {fmt(currentTime)}
            <span className="text-fog/70"> / {fmt(total)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function ProvenanceCounter({
  kind,
  count,
}: {
  kind: keyof typeof PROVENANCE_PRESENTATION;
  count: number;
}) {
  const p = PROVENANCE_PRESENTATION[kind];
  return (
    <span
      title={p.blurb}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[10.5px] font-semibold leading-none",
        p.chip
      )}
    >
      <p.Icon size={10} strokeWidth={2.5} />
      <span className="font-mono tabular-nums">{count}</span>
      <span className="opacity-80">{p.short}</span>
    </span>
  );
}

function AttentionBadge({ curve }: { curve: number[] }) {
  const peak = curve.length > 0 ? Math.max(...curve) / 255 : 0;
  return (
    <span
      title="Attention curve — the canonical importance signal that drives moment selection."
      className="inline-flex items-center gap-2 rounded-xl border border-violet-400/35 bg-violet-500/[0.08] px-3 py-1.5"
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-200">
        Attention
      </span>
      <span className="block w-[88px]">
        <AttentionWaveform
          curve={curve}
          variant="spark"
          height={20}
          className="text-violet-200"
        />
      </span>
      <span className="font-mono text-[10.5px] tabular-nums text-violet-100/90">
        {Math.round(peak * 100)}
      </span>
    </span>
  );
}

const TIPS = [
  ["Drag a pill", "to move it"],
  ["Drag the edges", "to retime"],
  ["Click anywhere on the lane", "to seek"],
  ["Shift / ⌘ + click", "to multi-select"],
  ["Del / Backspace", "to remove selection"],
  ["⌘D", "to duplicate"],
  ["Esc", "to clear multi-select"],
] as const;

function TipsPopover() {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Timeline tips"
        className={cn(
          "inline-flex size-8 items-center justify-center rounded-xl border text-fog transition-colors duration-150",
          open
            ? "border-violet-400/45 bg-violet-500/15 text-violet-100"
            : "border-white/10 bg-white/[0.025] hover:border-white/25 hover:text-white"
        )}
      >
        <HelpCircle size={13} />
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-40 w-72 overflow-hidden rounded-2xl border border-white/10 bg-ink/95 shadow-cinematic backdrop-blur-xl">
          <div className="border-b border-white/[0.06] px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
            Timeline tips
          </div>
          <ul className="space-y-1.5 px-4 py-3 text-[12px]">
            {TIPS.map(([action, hint]) => (
              <li
                key={action}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="text-white/85">{action}</span>
                <span className="text-fog">{hint}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
