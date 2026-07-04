"use client";

import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  Crop,
  Frame,
  Lightbulb,
  Loader2,
  SlidersHorizontal,
  Sparkles,
  Wand2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useMomentReview } from "./useMomentReview";

/**
 * Compact horizontal editor toolbar between the preview and the timeline.
 * Left: the real editing tools (each opens a temporary dialog/drawer — nothing
 * permanently eats preview width). Right: Previous / Next edit review
 * navigation with a "12 of 42" position readout.
 *
 * Marked as a dialog "hold" region so using a tool or the review nav never
 * dismisses the floating moment editor via its outside-press close.
 */
export function EditorToolbar({
  hasAnalysis,
  isAnalyzingNow,
  canAnalyze,
  analyzeTitle,
  cropEditing,
  onAnalyze,
  onToggleCrop,
  onCanvas,
  onEffects,
  onPresets,
  onInsights,
}: {
  hasAnalysis: boolean;
  isAnalyzingNow: boolean;
  canAnalyze: boolean;
  analyzeTitle?: string;
  cropEditing: boolean;
  onAnalyze: () => void;
  onToggleCrop: () => void;
  onCanvas: () => void;
  onEffects: () => void;
  onPresets: () => void;
  onInsights: () => void;
}) {
  const review = useMomentReview();

  return (
    <div
      data-editor-dialog-hold
      className="flex h-12 shrink-0 items-center gap-1 border-t border-white/[0.06] bg-surface/60 px-2 backdrop-blur-xl sm:px-3"
    >
      {/* ── Tools ── */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <ToolButton
          label={hasAnalysis ? "Re-analyze" : "AI edits"}
          title={analyzeTitle ?? (hasAnalysis ? "Re-run the AI analysis" : "Generate your AI edit")}
          onClick={onAnalyze}
          disabled={hasAnalysis ? isAnalyzingNow : !canAnalyze}
          emphasized={!hasAnalysis}
        >
          {isAnalyzingNow ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Sparkles size={15} />
          )}
        </ToolButton>
        <ToolButton
          label={cropEditing ? "Done cropping" : "Crop frame"}
          title="Crop the source frame (applies everywhere)"
          onClick={onToggleCrop}
          pressed={cropEditing}
        >
          <Crop size={15} />
        </ToolButton>
        <ToolButton label="Canvas" title="Output canvas — aspect, fit, background" onClick={onCanvas}>
          <Frame size={15} />
        </ToolButton>
        <ToolButton label="Effects" title="Global effects" onClick={onEffects}>
          <SlidersHorizontal size={15} />
        </ToolButton>

        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-white/[0.08]" />

        <ToolButton label="Presets" title="One-click looks & your saved presets" onClick={onPresets}>
          <Wand2 size={15} />
        </ToolButton>
        <ToolButton
          label="Insights"
          title="AI insights & suggestions"
          onClick={onInsights}
        >
          <Lightbulb size={15} />
        </ToolButton>
      </div>

      {/* ── Edit review navigation ── */}
      {review.total > 0 && (
        <div className="flex shrink-0 items-center gap-1 pl-2">
          <button
            type="button"
            onClick={review.goPrev}
            disabled={!review.hasPrev}
            aria-label="Previous edit"
            title="Previous edit"
            className={NAV_BTN}
          >
            <ChevronLeft size={15} />
          </button>
          <span className="min-w-16 px-1 text-center font-mono text-[11px] tabular-nums text-fog">
            {review.position
              ? `${review.position.index} of ${review.position.total}`
              : `${review.total} edits`}
          </span>
          <button
            type="button"
            onClick={review.goNext}
            disabled={!review.hasNext}
            aria-label="Next edit"
            title="Next edit"
            className={NAV_BTN}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

const NAV_BTN =
  "inline-flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-fog transition-colors duration-150 hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:pointer-events-none disabled:opacity-35";

function ToolButton({
  label,
  title,
  onClick,
  disabled,
  pressed,
  emphasized,
  children,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  /** Toggle-style tool (e.g. Crop frame) — reflects the active state. */
  pressed?: boolean;
  /** Primary-flavoured tool (the first-run Analyze CTA). */
  emphasized?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:pointer-events-none disabled:opacity-40",
        pressed
          ? "border border-violet-400/40 bg-violet-500/15 text-violet-200"
          : emphasized
            ? "border border-violet-400/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20"
            : "text-fog hover:bg-white/[0.04] hover:text-white"
      )}
    >
      {children}
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}
