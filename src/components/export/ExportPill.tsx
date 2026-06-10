"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Loader2,
  Download,
  X,
  CheckCircle2,
  AlertCircle,
  Ban,
} from "lucide-react";
import { useExport } from "./ExportProvider";

/**
 * Floating export pill — bottom-right, session-level (rendered by the
 * ExportProvider in the Shell). Shows live progress while an export renders in
 * the background, then a Download button when ready. Click the body to open the
 * Exports page. Mirrors `ProcessingMiniPill`.
 */
export function ExportPill() {
  const { job, isExporting, cancelExport, clearJob, downloadCurrent } =
    useExport();
  const router = useRouter();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  if (!mounted || !job) return null;

  const pct = Math.round((job.progress || 0) * 100);
  const stageLabel =
    job.status === "preparing"
      ? "Preparing export…"
      : job.status === "rendering"
        ? "Rendering export…"
        : job.status === "uploading"
          ? "Saving export…"
          : job.status === "completed"
            ? "Export ready"
            : job.status === "canceled"
              ? "Export canceled"
              : "Export failed";

  const tone =
    job.status === "completed"
      ? "border-emerald-400/40 hover:border-emerald-400/60"
      : job.status === "failed"
        ? "border-rose-400/40 hover:border-rose-400/60"
        : job.status === "canceled"
          ? "border-white/15 hover:border-white/25"
          : "border-violet-400/30 hover:border-violet-400/50";

  const Icon =
    job.status === "completed"
      ? CheckCircle2
      : job.status === "failed"
        ? AlertCircle
        : job.status === "canceled"
          ? Ban
          : Loader2;

  const iconTone =
    job.status === "completed"
      ? "bg-emerald-500/15 text-emerald-300"
      : job.status === "failed"
        ? "bg-rose-500/15 text-rose-300"
        : job.status === "canceled"
          ? "bg-white/[0.06] text-fog"
          : "bg-violet-500/15 text-violet-300";

  return createPortal(
    <AnimatePresence>
      <motion.div
        key={job.id}
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.96 }}
        transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
        onClick={() => router.push("/dashboard/exports")}
        role="button"
        tabIndex={0}
        className={`fixed bottom-5 right-5 z-[116] flex w-80 cursor-pointer items-center gap-3 rounded-xl border bg-surface/95 p-3 text-left shadow-cinematic backdrop-blur-xl transition-colors duration-200 ${tone}`}
        aria-label="Open exports"
      >
        <span
          className={`inline-flex size-9 shrink-0 items-center justify-center rounded-lg ${iconTone}`}
        >
          <Icon
            size={15}
            className={isExporting ? "animate-spin" : undefined}
          />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-semibold text-white">
              {stageLabel}
            </span>
            {isExporting && (
              <span className="font-mono text-[10px] tabular-nums text-fog">
                {pct}%
              </span>
            )}
          </div>

          {isExporting ? (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-200"
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
          ) : (
            <div className="mt-0.5 truncate text-[10px] text-fog">
              {job.status === "failed"
                ? job.error || "Something went wrong."
                : job.projectTitle}
            </div>
          )}
        </div>

        {/* Action — Cancel while running, Download/Dismiss when settled. */}
        {isExporting ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              cancelExport();
            }}
            className="shrink-0 rounded-md border border-white/10 bg-white/[0.02] px-2 py-1 text-[11px] font-medium text-fog transition-colors hover:border-rose-300/40 hover:text-rose-200"
          >
            Cancel
          </button>
        ) : job.status === "completed" ? (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                downloadCurrent();
              }}
              aria-label="Download export"
              className="inline-flex size-8 items-center justify-center rounded-md border border-emerald-400/30 bg-emerald-400/10 text-emerald-300 transition-colors hover:bg-emerald-400/20"
            >
              <Download size={14} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                clearJob();
              }}
              aria-label="Dismiss"
              className="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] text-fog transition-colors hover:text-white"
            >
              <X size={13} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              clearJob();
            }}
            aria-label="Dismiss"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] text-fog transition-colors hover:text-white"
          >
            <X size={13} />
          </button>
        )}
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}
