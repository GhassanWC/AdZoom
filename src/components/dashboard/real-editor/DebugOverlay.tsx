"use client";

import * as React from "react";
import { Bug, X } from "lucide-react";
import { useEditorReal } from "./context";
import { cn } from "@/lib/cn";
import type { DetectedMoment, MomentProvenance } from "@/lib/firebase/schema";

/**
 * Developer / debug overlay — toggle with `Ctrl+Shift+D` or `?debug=1`.
 *
 * Read-only panel showing the canonical attention curve, selected moment's
 * confidence breakdown, and an event-timeline strip. Drives tuning + bug
 * reports without requiring DevTools spelunking.
 *
 * Excluded from production bundles by `NODE_ENV !== "production"`.
 */
export function DebugOverlay() {
  const { project, selectedMomentId, currentTime } = useEditorReal();
  const [open, setOpen] = React.useState(false);

  // Toggle hotkey + URL flag.
  React.useEffect(() => {
    const url = typeof window !== "undefined" ? new URL(window.location.href) : null;
    if (url?.searchParams.get("debug") === "1") setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The overlay is opened via Ctrl+Shift+D or ?debug=1. No floating
  // button — it cluttered the editor chrome.
  if (!open) return null;

  const analysis = project.analysis;
  const moments = analysis?.detectedMoments ?? [];
  const selected = moments.find((m) => m.id === selectedMomentId) ?? null;
  const curve = analysis?.attentionCurve ?? [];
  const sampleRate = analysis?.attentionSampleRate ?? 1;
  const total = project.duration ?? 0;

  return (
    <div className="fixed inset-x-3 bottom-3 z-50 max-h-[42vh] overflow-hidden rounded-xl border border-white/15 bg-ink/95 text-[12px] text-white shadow-cinematic backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2 text-fog">
          <Bug size={12} />
          <span className="font-semibold uppercase tracking-wider text-[10px]">
            Debug overlay
          </span>
          <span className="text-fog/70 text-[10px]">
            ({moments.length} moments · curve {curve.length} buckets @ {sampleRate}Hz)
          </span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-fog hover:text-white"
        >
          <X size={14} />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 overflow-auto p-3 md:grid-cols-2">
        {/* Attention curve, full-width sparkline with playhead. */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-fog">
            Attention curve
          </div>
          <AttentionStrip
            curve={curve}
            duration={total}
            currentTime={currentTime}
            moments={moments}
          />
          {curve.length === 0 && (
            <div className="mt-1 text-[10px] text-fog/70">
              No curve persisted — re-run analyze or rebalance.
            </div>
          )}
        </section>

        {/* Event timeline strip — colors moments by provenance. */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-fog">
            Moments by provenance
          </div>
          <EventStrip moments={moments} duration={total} currentTime={currentTime} />
          <ProvenanceLegend moments={moments} />
        </section>

        {/* Selected moment — full confidence breakdown. */}
        <section className="md:col-span-2 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-fog">
            Selected moment
          </div>
          {selected ? (
            <SelectedDetails moment={selected} />
          ) : (
            <div className="text-[11px] text-fog">No moment selected.</div>
          )}
        </section>
      </div>
    </div>
  );
}

const PROV_COLOR: Record<MomentProvenance, string> = {
  event: "rgb(52 211 153)",
  cv: "rgb(56 189 248)",
  ai: "rgb(167 139 250)",
  "ai-override": "rgb(232 121 249)",
  user: "rgb(252 211 77)",
};

function provenanceOf(m: DetectedMoment): MomentProvenance {
  if (m.provenance) return m.provenance;
  if (m.source === "user") return "user";
  return "ai";
}

function AttentionStrip({
  curve,
  duration,
  currentTime,
  moments,
}: {
  curve: number[];
  duration: number;
  currentTime: number;
  moments: DetectedMoment[];
}) {
  const w = 600;
  const h = 60;
  const pts: string[] = [];
  if (curve.length > 1) {
    const step = w / (curve.length - 1);
    for (let i = 0; i < curve.length; i++) {
      const v = curve[i] / 255;
      pts.push(`${(i * step).toFixed(1)},${(h - 2 - v * (h - 4)).toFixed(1)}`);
    }
  }
  const playX = duration > 0 ? (currentTime / duration) * w : 0;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      <rect x={0} y={0} width={w} height={h} fill="transparent" />
      {pts.length > 0 && (
        <polyline points={pts.join(" ")} fill="none" stroke="rgb(167 139 250)" strokeWidth="1" />
      )}
      {/* Vertical ticks at each kept moment, color-coded by provenance. */}
      {moments.map((m) => {
        const x = duration > 0 ? (m.startTime / duration) * w : 0;
        return (
          <line
            key={m.id}
            x1={x}
            x2={x}
            y1={h - 12}
            y2={h - 2}
            stroke={PROV_COLOR[provenanceOf(m)]}
            strokeWidth={1.5}
          />
        );
      })}
      <line x1={playX} x2={playX} y1={0} y2={h} stroke="rgba(255,255,255,0.6)" strokeWidth={1} />
    </svg>
  );
}

function EventStrip({
  moments,
  duration,
  currentTime,
}: {
  moments: DetectedMoment[];
  duration: number;
  currentTime: number;
}) {
  if (duration <= 0) return null;
  return (
    <div className="relative h-8 w-full overflow-hidden rounded border border-white/10 bg-black/30">
      {moments.map((m) => {
        const left = (m.startTime / duration) * 100;
        const width = Math.max(0.3, ((m.endTime - m.startTime) / duration) * 100);
        return (
          <span
            key={m.id}
            className="absolute inset-y-0 rounded-sm opacity-80"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              backgroundColor: PROV_COLOR[provenanceOf(m)],
            }}
            title={`${m.label} · ${provenanceOf(m)} · conf ${(
              (m.confidenceScore ?? 0) * 100
            ).toFixed(0)}`}
          />
        );
      })}
      <span
        className="absolute inset-y-0 w-px bg-white/80"
        style={{ left: `${(currentTime / duration) * 100}%` }}
      />
    </div>
  );
}

function ProvenanceLegend({ moments }: { moments: DetectedMoment[] }) {
  const counts: Record<MomentProvenance, number> = {
    event: 0,
    cv: 0,
    ai: 0,
    "ai-override": 0,
    user: 0,
  };
  for (const m of moments) counts[provenanceOf(m)] += 1;
  const total = moments.length;
  const aiShare =
    total > 0 ? ((counts.ai + counts["ai-override"]) / total) * 100 : 0;
  return (
    <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
      {(Object.keys(counts) as MomentProvenance[]).map((p) => (
        <span key={p} className="inline-flex items-center gap-1.5 text-fog">
          <span
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: PROV_COLOR[p] }}
          />
          {p}
          <span className="font-mono tabular-nums text-white/80">{counts[p]}</span>
        </span>
      ))}
      <span
        className={cn(
          "ml-auto rounded px-1.5 py-0.5 font-mono text-[10px]",
          aiShare > 15
            ? "bg-rose-500/20 text-rose-200"
            : "bg-emerald-500/15 text-emerald-200"
        )}
        title="AI quota (cap = 15%)"
      >
        AI {aiShare.toFixed(0)}%
      </span>
    </div>
  );
}

function SelectedDetails({ moment }: { moment: DetectedMoment }) {
  const p = provenanceOf(moment);
  return (
    <div className="grid grid-cols-2 gap-2 font-mono text-[10px] text-white/85">
      <Pair k="id" v={moment.id} />
      <Pair k="label" v={moment.label} />
      <Pair k="provenance" v={p} color={PROV_COLOR[p]} />
      <Pair
        k="confidenceScore"
        v={(moment.confidenceScore ?? moment.attentionScore ?? 0).toFixed(3)}
      />
      <Pair k="confidenceSource" v={moment.confidenceSource ?? "—"} />
      <Pair k="effectType" v={moment.effectType} />
      <Pair k="uiContext" v={moment.uiContext ?? "—"} />
      <Pair
        k="attentionScore"
        v={(moment.attentionScore ?? 0).toFixed(3)}
      />
      <Pair k="startTime" v={moment.startTime.toFixed(2)} />
      <Pair k="endTime" v={moment.endTime.toFixed(2)} />
      <Pair
        k="focusRegion"
        v={`${moment.focusRegion.x.toFixed(2)},${moment.focusRegion.y.toFixed(
          2
        )} ${moment.focusRegion.width.toFixed(2)}×${moment.focusRegion.height.toFixed(2)}`}
      />
      <Pair k="eventIds" v={(moment.eventIds ?? []).join(", ") || "—"} />
      <div className="col-span-2 whitespace-pre-wrap text-[11px] text-white">
        {moment.confidenceReason || moment.reason || "—"}
      </div>
    </div>
  );
}

function Pair({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-28 text-fog/70">{k}</span>
      <span className="truncate" style={color ? { color } : undefined}>
        {v}
      </span>
    </div>
  );
}
