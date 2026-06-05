"use client";

/**
 * CV tuning panel — dev-only (?debug=1). Surfaces the visual editing engine's
 * output so a real-footage tuning pass doesn't require guessing:
 *   • logs a `[cv]` summary to the console,
 *   • renders a dev test checklist (auto pass/warn from the data),
 *   • exports the full CV diagnostics as JSON.
 *
 * Reporting-only. No algorithm changes, no customer-facing UI.
 */

import * as React from "react";
import { Bug, ChevronDown, ChevronUp, Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useEditorReal } from "./context";
import { useDebugParam } from "./use-debug-param";
import { buildCvDebugReport, type CvDebugReport } from "@/lib/diagnostics/cv-debug";

type CheckState = "pass" | "warn" | "unknown";

function checkRow(label: string, state: CheckState, detail: string) {
  return { label, state, detail };
}

export function CvDebugPanel() {
  const { project } = useEditorReal();
  const enabled = useDebugParam();
  const [open, setOpen] = React.useState(true);
  const loggedSig = React.useRef<string | null>(null);

  const report: CvDebugReport | null = React.useMemo(
    () => buildCvDebugReport(project),
    [project]
  );

  // Log the `[cv]` summary once per analysis (keyed on computeMs + counts).
  React.useEffect(() => {
    if (!enabled || !report) return;
    const sig = JSON.stringify(report.summary);
    if (loggedSig.current === sig) return;
    loggedSig.current = sig;
    // eslint-disable-next-line no-console
    console.groupCollapsed(`[cv] visual engine — ${project.id}`);
    // eslint-disable-next-line no-console
    console.table(report.summary);
    // eslint-disable-next-line no-console
    console.log("[cv] visualAnalysis meta", report.visualAnalysisMeta);
    // eslint-disable-next-line no-console
    console.log(
      `[cv] cursorTrack=${report.cursorTrack.length} dwells=${report.dwells.length} inferredClicks=${report.inferredClicks.length} sceneChanges=${report.sceneChanges.length} rejectedCV=${report.rejected.length}`
    );
    // eslint-disable-next-line no-console
    console.groupEnd();
  }, [enabled, report, project.id]);

  if (!enabled) return null;

  const onDownload = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cv-diagnostics-${project.id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const s = report?.summary;
  const checks = s
    ? [
        checkRow(
          "Cursor detected?",
          s.cursorTrackFound ? "pass" : "warn",
          `avg confidence ${(s.cursorConfidenceAvg * 100).toFixed(0)}%`
        ),
        checkRow(
          "Clicks inferred?",
          s.inferredClicksCount > 0 ? "pass" : "warn",
          `${s.inferredClicksCount} clicks · ${s.dwellCount} dwells`
        ),
        checkRow(
          "Focus boxes tight?",
          s.cvMomentsKept === 0
            ? "unknown"
            : s.avgFocusRegionSize < 0.25
              ? "pass"
              : "warn",
          `avg area ${s.avgFocusRegionSize.toFixed(3)} over ${s.cvMomentsKept} CV moments`
        ),
        checkRow(
          "Generic 0.42 box avoided?",
          s.genericBoxCount === 0 ? "pass" : "warn",
          s.genericBoxCount === 0 ? "none" : `${s.genericBoxCount} generic boxes`
        ),
        checkRow(
          "CPU time acceptable?",
          s.computeMs <= 0 ? "unknown" : s.computeMs < 15000 ? "pass" : "warn",
          `${(s.computeMs / 1000).toFixed(1)}s for a ${s.durationSec.toFixed(0)}s video`
        ),
      ]
    : [];

  const dotClass = (state: CheckState) =>
    state === "pass"
      ? "bg-emerald-400"
      : state === "warn"
        ? "bg-amber-400"
        : "bg-white/30";

  return (
    <section className="glass rounded-2xl border border-white/10 bg-ink/40 p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-2">
          <Bug size={14} className="text-cyan-300" />
          <h3 className="font-display text-[15px] font-semibold text-white">
            CV Tuning (dev)
          </h3>
          {s && (
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-wider text-fog">
              v{s.version ?? "?"} · {s.detectResolution}
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
        <div className="mt-4 space-y-4">
          {!report && (
            <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-fog">
              No visual analysis on this project yet. Run analyze, then reopen
              with <code>?debug=1</code>.
            </p>
          )}

          {report && s && (
            <>
              {/* Summary grid */}
              <div className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-3">
                <SummaryStat label="Cursor track" value={s.cursorTrackFound ? "found" : "none"} />
                <SummaryStat label="Cursor conf" value={`${(s.cursorConfidenceAvg * 100).toFixed(0)}%`} />
                <SummaryStat label="Inferred clicks" value={String(s.inferredClicksCount)} />
                <SummaryStat label="Dwells" value={String(s.dwellCount)} />
                <SummaryStat label="CV emitted" value={String(s.cvMomentsEmitted)} />
                <SummaryStat label="CV kept" value={String(s.cvMomentsKept)} />
                <SummaryStat label="CV rejected" value={String(s.rejectedCvMoments)} />
                <SummaryStat label="Avg box area" value={s.avgFocusRegionSize.toFixed(3)} />
                <SummaryStat label="Compute" value={`${(s.computeMs / 1000).toFixed(1)}s`} />
              </div>

              {/* Dev test checklist */}
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fog">
                  Tuning checklist
                </div>
                <ul className="space-y-1.5">
                  {checks.map((c) => (
                    <li key={c.label} className="flex items-center gap-2 text-[12px]">
                      <span className={`size-2 shrink-0 rounded-full ${dotClass(c.state)}`} />
                      <span className="text-white/85">{c.label}</span>
                      <span className="ml-auto font-mono text-[11px] text-fog">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={<Download size={12} />}
                  onClick={onDownload}
                >
                  Download CV diagnostics (JSON)
                </Button>
                <span className="text-[11px] text-fog/70">
                  Overlay (cursor dots / click markers / focus boxes / scene badge)
                  is drawn on the player while <code>?debug=1</code> is active.
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-fog">{label}</div>
      <div className="font-mono text-[13px] font-semibold text-white">{value}</div>
    </div>
  );
}
