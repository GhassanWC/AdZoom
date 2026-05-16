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
  const { project, processingMinimized, setProcessingMinimized } =
    useEditorReal();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!processingMinimized) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [processingMinimized]);

  if (!mounted) return null;

  const visible = processingMinimized && isProcessing(project.status);

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

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.button
          initial={{ opacity: 0, y: 12, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.96 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          onClick={() => setProcessingMinimized(false)}
          className="fixed bottom-5 right-5 z-[115] flex w-72 items-center gap-3 rounded-xl border border-violet-400/30 bg-surface/95 p-3 text-left shadow-cinematic backdrop-blur-xl transition-colors duration-200 hover:border-violet-400/50"
          aria-label="Re-open processing details"
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
                {project.analysis?.stage ?? "Analyzing"}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-fog">
                {fmtElapsed(elapsedMs)}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400"
                style={{ width: `${pct * 100}%` }}
              />
            </div>
            <div className="mt-1 truncate text-[10px] text-fog">
              {project.title}
            </div>
          </div>
          <Maximize2 size={12} className="shrink-0 text-fog" />
        </motion.button>
      )}
    </AnimatePresence>,
    document.body
  );
}
