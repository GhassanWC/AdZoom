"use client";

/**
 * Framevo AI — the WORKING state (approved rule 9).
 *
 * The run's progress lives HERE, in the same surface the user asked from — no
 * bouncing through a full-screen modal. Steps + labels come from the existing
 * builders (`buildProgressSteps`), the fraction from the extracted shared
 * formula (`lib/framevo-ai/progress`), the feed from `friendlyActivityFeed` —
 * derivation reused, not duplicated. Closing the panel keeps the global mini
 * pill, which reopens Framevo AI.
 */
import * as React from "react";
import { Loader2, Sparkles, Clock } from "lucide-react";
import { cn } from "@/lib/cn";
import { useEditorReal } from "./context";
import {
  buildProgressSteps,
  countGeneratedEdits,
  friendlyActivityFeed,
  editsProgressLine,
} from "@/lib/analysis-progress";
import { fmtElapsed } from "@/lib/analysis-stages";
import { activeStepIndex, progressFraction } from "@/lib/framevo-ai/progress";
import { hasDirectorBrief } from "@/lib/director/types";
import type { AnalysisOptions } from "@/lib/analysis/engine-layers";

export function FramevoAIWorking() {
  const { project, cvProgress, chunkedJob, cancelAnalyze, selectedVideoType } =
    useEditorReal();
  const analysis = project.analysis;
  const runOptions = (analysis?.lastRunOptions as AnalysisOptions | undefined) ?? undefined;

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedMs = analysis?.startedAt ? Math.max(0, now - analysis.startedAt) : 0;

  const directing =
    hasDirectorBrief(project.directorBrief) && runOptions?.applyDirectorBrief !== false;
  const steps = React.useMemo(
    () => buildProgressSteps({ videoType: selectedVideoType, options: runOptions, directing }),
    [selectedVideoType, runOptions, directing]
  );
  const job =
    chunkedJob && (chunkedJob.status === "running" || chunkedJob.status === "queued")
      ? chunkedJob
      : null;
  const pct = job
    ? Math.max(0.02, job.progress)
    : progressFraction({
        status: project.status,
        cvProgress,
        elapsedMs,
        estimateSeconds: analysis?.estimateSeconds,
      });
  const activeIdx = activeStepIndex(pct, steps);
  const editsCount = countGeneratedEdits(analysis?.detectedMoments);
  const feed = React.useMemo(
    () => friendlyActivityFeed(analysis?.activity ?? []).slice(-6),
    [analysis?.activity]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-200 ring-1 ring-violet-400/25">
            <Loader2 size={14} className="animate-spin" />
          </span>
          <div className="min-w-0">
            <p className="text-[13.5px] font-semibold text-white">
              Framevo AI is editing your video
            </p>
            <p className="text-[11.5px] text-fog">
              {job
                ? `Chunk ${Math.min(job.completedCount + 1, job.chunkCount)} of ${job.chunkCount} · ${editsProgressLine(editsCount)}`
                : "You can keep working — the timeline fills in as edits land."}
            </p>
          </div>
        </div>

        {/* The step checklist — the same builders the product has always used. */}
        <ul className="space-y-2">
          {steps.map((s, i) => {
            const done = i < activeIdx;
            const active = i === activeIdx;
            return (
              <li key={s.id} className="flex items-center gap-2.5 text-[12.5px]">
                <span
                  className={cn(
                    "inline-flex size-4 shrink-0 items-center justify-center rounded-full border",
                    done && "border-emerald-400/50 bg-emerald-500/15 text-emerald-300",
                    active && "border-violet-400/60 bg-violet-500/15 text-violet-200",
                    !done && !active && "border-white/15 text-fog/50"
                  )}
                >
                  {done ? "✓" : active ? <Loader2 size={9} className="animate-spin" /> : "○"}
                </span>
                <span
                  className={cn(
                    done && "text-white/85",
                    active && "font-medium text-white",
                    !done && !active && "text-fog/60"
                  )}
                >
                  {s.label}
                </span>
              </li>
            );
          })}
        </ul>

        {feed.length > 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-fog">
              Activity
            </p>
            <ul className="space-y-1">
              {feed.map((a, i) => (
                <li
                  key={`${a.ts}-${i}`}
                  className={cn(
                    "truncate text-[11.5px]",
                    a.kind === "warn" || a.kind === "error" ? "text-amber-200" : "text-fog"
                  )}
                  title={a.label}
                >
                  {a.label}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-white/[0.06] p-3">
        <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-500"
            style={{ width: `${Math.max(2, pct * 100)}%` }}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-fog">
            <Clock size={10} className="text-violet-300" />
            <span className="font-mono tabular-nums">{fmtElapsed(elapsedMs)}</span>
            <Sparkles size={10} className="ml-1 text-violet-300" />
            {editsCount > 0 ? `${editsCount} edit${editsCount === 1 ? "" : "s"} so far` : "Working…"}
          </span>
          <button
            type="button"
            onClick={() => void cancelAnalyze()}
            className="rounded-lg border border-rose-400/30 bg-rose-500/[0.06] px-2.5 py-1 text-[11.5px] text-rose-200 transition-colors hover:border-rose-400/50 hover:bg-rose-500/[0.12]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
