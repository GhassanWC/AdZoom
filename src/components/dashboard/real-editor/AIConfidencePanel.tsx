"use client";

import * as React from "react";
import {
  Brain,
  Activity,
  Scissors,
  Gauge,
  Layers,
  MousePointerClick,
  Cpu,
  Sparkles,
} from "lucide-react";
import { useEditorReal } from "./context";
import { cn } from "@/lib/cn";
import { dequantizeArray } from "@/lib/cv/resample";

/**
 * AI analysis summary — the "AI says…" hero panel. Tells the user, in human
 * terms, what the hybrid engine found and how confident it is.
 */
export function AIConfidencePanel() {
  const { project } = useEditorReal();
  const analysis = project.analysis;
  const va = project.visualAnalysis;
  const moments = analysis?.detectedMoments ?? [];

  const stats = React.useMemo(() => {
    const motion = dequantizeArray(va?.motion);
    const peakMotion = motion.length ? Math.max(...motion) : 0;
    const avgMotion = motion.length
      ? motion.reduce((a, b) => a + b, 0) / motion.length
      : 0;

    const avgAttention = moments.length
      ? moments.reduce(
          (a, m) => a + (m.attentionScore ?? m.importance ?? 0.5),
          0
        ) / moments.length
      : 0;

    const fusedMoments = moments.filter(
      (m) => typeof m.attentionFactors?.semanticWeight === "number"
    ).length;

    // Composite engagement score — what's the upside of these edits?
    // Weighted blend: 60% attention strength, 40% activity coverage.
    const engagement = Math.round((avgAttention * 0.6 + peakMotion * 0.4) * 100);

    return {
      peakMotion,
      avgMotion,
      avgAttention,
      fusedMoments,
      engagement,
      sceneChanges: va?.sceneChanges.length ?? 0,
      clickEvents: va?.clickEvents.length ?? 0,
      computeMs: va?.computeMs ?? 0,
      hasCv: Boolean(va && va.sampleCount > 0),
    };
  }, [va, moments]);

  const analyzed = analysis?.status === "complete" && moments.length > 0;

  if (!analyzed) {
    return (
      <div className="glass relative overflow-hidden rounded-2xl p-6">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-12 right-0 h-40 w-56 bg-[radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.18),transparent_65%)] blur-2xl"
        />
        <div className="relative">
          <div className="inline-flex size-11 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/20">
            <Brain size={18} />
          </div>
          <h3 className="mt-4 font-display text-base font-semibold text-white">
            AI analysis
          </h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-fog">
            Run <strong className="text-white">Analyze with AI</strong> to generate a
            first-draft edit. The hybrid engine measures real motion, scene cuts,
            and fused attention scoring — your timeline is just a refinement away.
          </p>
        </div>
      </div>
    );
  }

  // Confidence band — how trustworthy the auto-edit feels in plain language.
  const conf = stats.engagement;
  const confBand =
    conf >= 70 ? "high" : conf >= 45 ? "balanced" : "exploratory";
  const confTone =
    conf >= 70
      ? "text-emerald-300"
      : conf >= 45
      ? "text-violet-200"
      : "text-amber-200";
  const confLabel =
    confBand === "high"
      ? "High confidence draft"
      : confBand === "balanced"
      ? "Balanced draft"
      : "Light-touch draft";

  return (
    <div className="glass relative overflow-hidden rounded-2xl">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 -left-8 h-48 w-80 bg-[radial-gradient(ellipse_at_top_left,rgba(139,92,246,0.18),transparent_60%)] blur-2xl"
      />

      {/* Hero */}
      <div className="relative px-6 pb-5 pt-6">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-9 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/25">
            <Brain size={16} />
          </span>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
              AI analysis
            </div>
            <div className={cn("text-[12px] font-medium", confTone)}>
              {confLabel}
            </div>
          </div>
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold",
              stats.hasCv
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                : "border-white/10 bg-white/[0.03] text-fog"
            )}
          >
            <Cpu size={11} />
            {stats.hasCv ? "Hybrid · Gemini + CV" : "Gemini only"}
          </span>
        </div>

        {/* Engagement headline */}
        <div className="mt-5 flex items-end gap-3">
          <div className="font-display text-5xl font-semibold leading-none tabular-nums text-white">
            {stats.engagement}
          </div>
          <div className="pb-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
              Engagement score
            </div>
            <div className="text-[12px] text-fog">
              {moments.length} edit{moments.length === 1 ? "" : "s"} suggested
            </div>
          </div>
          <Sparkles
            size={16}
            className="ml-auto mb-2 text-violet-300 opacity-80"
            aria-hidden
          />
        </div>

        {/* Engagement bar */}
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-500 via-violet-400 to-cyan-400 transition-[width] duration-500"
            style={{ width: `${Math.max(2, Math.min(100, stats.engagement))}%` }}
          />
        </div>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 gap-2.5 px-6 pb-5">
        <StatTile
          icon={<Activity size={14} />}
          label="Motion peak"
          value={`${Math.round(stats.peakMotion * 100)}%`}
          sub={`avg ${Math.round(stats.avgMotion * 100)}%`}
          tone={stats.hasCv ? "violet" : "muted"}
          bar={stats.peakMotion}
        />
        <StatTile
          icon={<Scissors size={14} />}
          label="Scene cuts"
          value={String(stats.sceneChanges)}
          sub={stats.hasCv ? "on-device" : "no CV"}
          tone={stats.sceneChanges > 0 ? "amber" : "muted"}
        />
        <StatTile
          icon={<Gauge size={14} />}
          label="Avg attention"
          value={`${Math.round(stats.avgAttention * 100)}`}
          sub="fused / 100"
          tone="emerald"
          bar={stats.avgAttention}
        />
        <StatTile
          icon={<Layers size={14} />}
          label="Moments"
          value={String(moments.length)}
          sub={
            stats.fusedMoments > 0
              ? `${stats.fusedMoments} CV-fused`
              : "Gemini only"
          }
          tone="violet"
        />
      </div>

      {/* Footer */}
      <div className="relative border-t border-white/[0.06] px-6 py-4">
        {stats.hasCv && (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fog">
            <span className="inline-flex items-center gap-1.5">
              <MousePointerClick size={11} className="text-cyan-300" />
              {stats.clickEvents} click-like event
              {stats.clickEvents === 1 ? "" : "s"}
            </span>
            <span className="font-mono">
              frame scan {(stats.computeMs / 1000).toFixed(1)}s
            </span>
          </div>
        )}
        <p className="text-[12px] leading-relaxed text-fog">
          {stats.hasCv
            ? "Motion, scene changes, and visual density are measured from the actual video. Gemini supplies meaning; CV corroborates and refines timing."
            : "This project was analyzed without an on-device CV pass — scores are Gemini estimates only. Re-analyze to enable hybrid scoring."}
        </p>
      </div>
    </div>
  );
}

const TONE_CLASS: Record<string, { ring: string; icon: string; bar: string }> = {
  violet: {
    ring: "border-violet-400/20",
    icon: "text-violet-300",
    bar: "bg-violet-500/70",
  },
  emerald: {
    ring: "border-emerald-400/20",
    icon: "text-emerald-300",
    bar: "bg-emerald-400/70",
  },
  amber: {
    ring: "border-amber-400/20",
    icon: "text-amber-300",
    bar: "bg-amber-400/70",
  },
  muted: {
    ring: "border-white/10",
    icon: "text-fog",
    bar: "bg-white/20",
  },
};

function StatTile({
  icon,
  label,
  value,
  sub,
  tone,
  bar,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone: "violet" | "emerald" | "amber" | "muted";
  bar?: number;
}) {
  const t = TONE_CLASS[tone];
  return (
    <div className={cn("rounded-xl border bg-white/[0.02] px-3.5 py-3", t.ring)}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-fog">
        <span className={t.icon}>{icon}</span>
        {label}
      </div>
      <div className="mt-1.5 font-display text-2xl font-semibold tabular-nums text-white">
        {value}
      </div>
      <div className="text-[11px] text-fog">{sub}</div>
      {typeof bar === "number" && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className={cn("h-full rounded-full", t.bar)}
            style={{ width: `${Math.max(2, Math.min(100, bar * 100))}%` }}
          />
        </div>
      )}
    </div>
  );
}
