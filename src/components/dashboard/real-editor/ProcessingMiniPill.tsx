"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, Maximize2, Sparkles } from "lucide-react";
import { useEditorReal } from "./context";
import {
  ANALYSIS_STAGES,
  fmtElapsed,
  isProcessing,
} from "@/lib/analysis-stages";
import { countGeneratedEdits } from "@/lib/analysis-progress";

/**
 * Tiny pill that appears in the bottom-right when the user minimizes the
 * processing overlay. Click to re-open the full overlay.
 *
 * Lives inside the editor (so it dies when the user leaves the page), which
 * matches what we can guarantee — analysis itself is server-side and Firestore-
 * driven, so leaving the editor doesn't stop it; coming back rehydrates the
 * pill from project state.
 */
export function ProcessingMiniPill() {
  const { project, activeTool, setActiveTool, chunkedJob } = useEditorReal();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  // FRAMEVO AI UNIFICATION (rule 9): progress lives in the Framevo AI panel;
  // this pill covers a CLOSED panel while a run is live and reopens the panel.
  const panelOpen = activeTool === "ai-chat";

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (panelOpen) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [panelOpen]);

  if (!mounted) return null;

  // Completion detection mirrors the overlay — hide the pill the instant the run
  // is done even if `project.status` lags or was transiently reset.
  const analysis = project.analysis;
  const allChunksDone =
    !!chunkedJob &&
    chunkedJob.chunkCount > 0 &&
    chunkedJob.completedCount >= chunkedJob.chunkCount;
  const lastActivityComplete = (analysis?.activity ?? []).some((a) =>
    a.text?.includes("Analysis complete")
  );
  const momentsPresent = (analysis?.detectedMoments?.length ?? 0) > 0;
  const done =
    analysis?.status === "complete" ||
    chunkedJob?.status === "complete" ||
    (allChunksDone && momentsPresent && lastActivityComplete);

  const visible = !panelOpen && isProcessing(project.status) && !done;

  const stageIdx = Math.max(
    0,
    ANALYSIS_STAGES.findIndex((s) => s.id === project.status)
  );
  const pct =
    project.analysis?.estimateSeconds && project.analysis.startedAt
      ? Math.min(
          0.97,
          (now - project.analysis.startedAt) /
            (project.analysis.estimateSeconds * 1000)
        )
      : (stageIdx + 1) / ANALYSIS_STAGES.length;

  const elapsedMs = project.analysis?.startedAt
    ? now - project.analysis.startedAt
    : 0;

  // Chunked analysis overrides the stage text + progress with live chunk state.
  const job =
    chunkedJob && (chunkedJob.status === "running" || chunkedJob.status === "queued")
      ? chunkedJob
      : null;
  const chunkSizeSuffix =
    job && job.chunkSize > 0
      ? ` · ${job.chunkMode === "custom" ? "custom " : ""}${job.chunkSize}s chunks`
      : "";
  const stageText = job
    ? `Chunk ${Math.min(job.completedCount + 1, job.chunkCount)} of ${job.chunkCount}${chunkSizeSuffix}`
    : "Generating your AI edit";
  const pctFinal = job ? Math.max(0.02, job.progress) : pct;
  const editCount = countGeneratedEdits(analysis?.detectedMoments);
  const subtitle = job
    ? editCount > 0
      ? `${editCount} edit${editCount === 1 ? "" : "s"} so far · editable now`
      : "Preparing your selected AI edits…"
    : project.title;

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.button
          initial={{ opacity: 0, y: 12, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.96 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          onClick={() => setActiveTool("ai-chat")}
          // Pops in from 0.96 (never from nothing) so it reads as arriving over
          // the preview rather than being teleported in.
          className="fv-pop-in fv-press fixed bottom-5 right-5 z-[115] flex w-72 items-center gap-3 rounded-xl border border-violet-400/30 bg-surface/95 p-3 text-left shadow-cinematic backdrop-blur-xl transition-[border-color,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-violet-400/50"
          aria-label="Open Framevo AI"
        >
          <span className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
            <Loader2 size={14} className="animate-spin" />
            <Sparkles
              size={9}
              className="absolute -right-1 -top-1 rounded-full bg-violet-500 p-0.5 text-white"
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-semibold text-white">
                {stageText}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-fog">
                {fmtElapsed(elapsedMs)}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400"
                style={{ width: `${pctFinal * 100}%` }}
              />
            </div>
            <div className="mt-1 truncate text-[10px] text-fog">
              {subtitle}
            </div>
          </div>
          <Maximize2 size={12} className="shrink-0 text-fog" />
        </motion.button>
      )}
    </AnimatePresence>,
    document.body
  );
}
