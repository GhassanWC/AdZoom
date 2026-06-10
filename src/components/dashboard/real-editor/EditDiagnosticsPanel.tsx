"use client";

/**
 * Edit-diagnostics panel — the per-recording answer to "out of N meaningful
 * interactions, how many did Framevo actually edit?". Reads the consolidated
 * `analysis.editDiagnostics` record (built server-side in the analyze route)
 * and renders the funnel, coverage, a bottleneck verdict, and a per-moment
 * drill-down table. Reporting-only — it never mutates the project.
 *
 * Mounted behind the `?debug=1` gate in RealEditor (internal/dev-only).
 */

import * as React from "react";
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Gauge,
} from "lucide-react";
import { useEditorReal } from "./context";
import { Stat } from "./diag-bits";
import {
  BOTTLENECK_LABEL,
  classifyBottleneck,
} from "@/lib/diagnostics/edit-diagnostics";
import type { EditDiagnostics } from "@/lib/firebase/schema";

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function coverageTone(cov: number): "ok" | "warn" | "error" {
  if (cov >= 0.7) return "ok";
  if (cov >= 0.4) return "warn";
  return "error";
}

export function EditDiagnosticsPanel() {
  const { project } = useEditorReal();
  const [open, setOpen] = React.useState(true);
  // Internal/dev-only: same gate as DebugOverlay (Ctrl+Shift+D or ?debug=1).
  const [enabled, setEnabled] = React.useState(false);
  React.useEffect(() => {
    const url =
      typeof window !== "undefined" ? new URL(window.location.href) : null;
    if (url?.searchParams.get("debug") === "1") setEnabled(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setEnabled((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const diag = project.analysis?.editDiagnostics;
  const clickPipeline = project.analysis?.clickPipeline;
  const externalCapture =
    clickPipeline?.scope === "external" ||
    (clickPipeline?.attemptedLoad === false && !!clickPipeline);

  if (!enabled) return null;

  return (
    <section className="glass rounded-2xl border border-white/10 bg-ink/40 p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-violet-300" />
          <h3 className="font-display text-[15px] font-semibold text-white">
            Edit Coverage
          </h3>
          {diag && (
            <span
              className={
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider " +
                (coverageTone(diag.coverageAdjusted) === "ok"
                  ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
                  : coverageTone(diag.coverageAdjusted) === "warn"
                    ? "border-amber-400/30 bg-amber-500/10 text-amber-200"
                    : "border-rose-400/30 bg-rose-500/10 text-rose-200")
              }
            >
              <Gauge size={10} />
              {pct(diag.coverageAdjusted)} coverage
            </span>
          )}
        </div>
        {open ? (
          <ChevronUp size={16} className="text-fog" />
        ) : (
          <ChevronDown size={16} className="text-fog" />
        )}
      </button>

      {open && (
        <div className="mt-4 space-y-5">
          {!diag && (
            <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-fog">
              No edit-coverage diagnostics on this project yet. Run analyze to
              populate.
            </p>
          )}

          {diag && externalCapture && diag.totalInteractions === 0 && (
            <p className="rounded-lg border border-amber-400/30 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-amber-100">
              External-capture recording — no <code>interactions.json</code> was
              available, so interaction counts are zero. Coverage is computed
              from CV/AI candidates only and is not directly comparable to
              in-tab recordings.
            </p>
          )}

          {diag && <DiagBody diag={diag} />}

          <div className="text-[11px] leading-relaxed text-fog/70">
            Coverage = important moments that landed on the timeline ÷ important
            moments detected. <strong>Adjusted</strong> excludes correct-by-design
            drops (rapid-click collapse, de-dupe, quota); <strong>Raw</strong> is
            the literal ratio. Computed{" "}
            {new Date(diag?.computedAt ?? 0).toLocaleString()}.
          </div>
        </div>
      )}
    </section>
  );
}

function DiagBody({ diag }: { diag: EditDiagnostics }) {
  const verdict = classifyBottleneck(diag);
  return (
    <div className="space-y-5">
      {/* Headline interaction + detection counts */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Clicks" value={String(diag.totalClicks)} />
        <Stat label="Scroll" value={String(diag.totalScroll)} />
        <Stat label="Hover" value={String(diag.totalHover)} />
        <Stat label="Navigation" value={String(diag.navScene)} />
        <Stat
          label="Important moments"
          value={String(diag.importantDetected)}
        />
      </div>
      <div className="text-[11px] text-fog/70">
        Navigation = {diag.navScene} scene change
        {diag.navScene === 1 ? "" : "s"} · {diag.navClick} nav-tier click
        {diag.navClick === 1 ? "" : "s"}
      </div>

      {/* Generation → application + coverage */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="AI edits generated"
          value={String(diag.aiProposed)}
        />
        <Stat
          label="Edits applied"
          value={String(diag.timelineApplied)}
          tone={diag.timelineApplied > 0 ? "ok" : "error"}
        />
        <Stat
          label="Coverage (adjusted)"
          value={pct(diag.coverageAdjusted)}
          tone={coverageTone(diag.coverageAdjusted)}
        />
        <Stat label="Coverage (raw)" value={pct(diag.coverageRaw)} />
      </div>

      {/* Visual editing engine (v3) — what the CV engine produced. */}
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="Cursor track"
          value={diag.cursorTrackFound ? "found" : "none"}
          tone={diag.cursorTrackFound ? "ok" : "warn"}
        />
        <Stat
          label="Visual clicks"
          value={String(diag.inferredClickCount ?? 0)}
        />
        <Stat label="CV moments" value={String(diag.cvMomentsEmitted ?? 0)} />
      </div>

      {/* Effect-type mix on the final timeline (CV classifier output). */}
      {diag.effectDistribution && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          <Stat label="Zoom" value={String(diag.effectDistribution.zoom ?? 0)} />
          <Stat
            label="Click"
            value={String(diag.effectDistribution["click-highlight"] ?? 0)}
          />
          <Stat
            label="Focus"
            value={String(diag.effectDistribution["cursor-focus"] ?? 0)}
          />
          <Stat label="Crop" value={String(diag.effectDistribution.crop ?? 0)} />
          <Stat
            label="Speed"
            value={String(diag.effectDistribution["speed-up"] ?? 0)}
          />
        </div>
      )}

      {/* Funnel bar */}
      <FunnelBar diag={diag} />

      {/* Drop split */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat
          label="Intentional drops"
          value={String(diag.intentionalDrops)}
        />
        <Stat
          label="Suppressed (lost) drops"
          value={String(diag.suppressedDrops)}
          tone={diag.suppressedDrops > 0 ? "warn" : "ok"}
        />
        <Stat
          label="Empty quartiles"
          value={String(diag.quartileLeftEmpty)}
          tone={diag.quartileLeftEmpty > 0 ? "warn" : "ok"}
        />
      </div>

      {/* Bottleneck verdict */}
      <div className="rounded-lg border border-violet-400/20 bg-violet-500/[0.06] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-violet-200">
            Likely bottleneck
          </span>
          <span className="text-[13px] font-semibold text-white">
            {BOTTLENECK_LABEL[verdict.kind]}
          </span>
        </div>
        <p className="mt-1 text-[12px] text-fog">{verdict.evidence}</p>
      </div>

      {/* Drill-down table */}
      <details open>
        <summary className="cursor-pointer text-[12px] text-white">
          Per-moment drill-down ({diag.rows.length} row
          {diag.rows.length === 1 ? "" : "s"})
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto rounded border border-white/10">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-ink/95 text-fog">
              <tr>
                <th className="px-2 py-1.5">t</th>
                <th className="px-2 py-1.5">detected</th>
                <th className="px-2 py-1.5">score</th>
                <th className="px-2 py-1.5">AI?</th>
                <th className="px-2 py-1.5">applied?</th>
                <th className="px-2 py-1.5">reason</th>
              </tr>
            </thead>
            <tbody className="text-white/85">
              {diag.rows.map((r) => (
                <tr key={r.id} className="border-t border-white/5">
                  <td className="px-2 py-1.5 font-mono">{r.ts.toFixed(1)}s</td>
                  <td className="px-2 py-1.5">{r.detectedEvent}</td>
                  <td className="px-2 py-1.5 font-mono">
                    {r.importanceScore.toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5">{r.aiGenerated ? "Yes" : "No"}</td>
                  <td className="px-2 py-1.5">
                    <span
                      className={
                        r.timelineApplied
                          ? "text-emerald-300"
                          : "text-rose-300"
                      }
                    >
                      {r.timelineApplied ? "Yes" : "No"}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-[10px] text-fog">
                    {r.timelineApplied ? (
                      "—"
                    ) : (
                      <span className="flex items-center gap-1">
                        {r.dropClass && (
                          <span
                            className={
                              "rounded px-1 py-0.5 text-[9px] uppercase tracking-wider " +
                              (r.dropClass === "suppressed"
                                ? "bg-rose-500/15 text-rose-300"
                                : "bg-white/10 text-fog")
                            }
                          >
                            {r.dropClass}
                          </span>
                        )}
                        <span className="font-mono">
                          {r.rejectedReason ?? "spacing/de-dupe"}
                        </span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Simple CSS-only comparison bar of the four funnel stages (no deps). */
function FunnelBar({ diag }: { diag: EditDiagnostics }) {
  const stages: Array<{ label: string; value: number; color: string }> = [
    {
      label: "Interactions",
      value: diag.totalInteractions,
      color: "bg-cyan-500/70",
    },
    {
      label: "Important",
      value: diag.importantDetected,
      color: "bg-violet-500/70",
    },
    {
      label: "Generated",
      value: diag.candidatesProposed,
      color: "bg-indigo-500/70",
    },
    {
      label: "Applied",
      value: diag.timelineApplied,
      color: "bg-emerald-500/70",
    },
  ];
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="space-y-1.5">
      {stages.map((s) => (
        <div key={s.label} className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-[11px] text-fog">{s.label}</span>
          <div className="h-3 flex-1 overflow-hidden rounded bg-white/[0.04]">
            <div
              className={`h-full rounded ${s.color}`}
              style={{ width: `${(s.value / max) * 100}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right text-[11px] font-mono text-white/85">
            {s.value}
          </span>
        </div>
      ))}
    </div>
  );
}
