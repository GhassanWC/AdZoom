"use client";

import * as React from "react";
import {
  Sparkles,
  Loader2,
  Crop,
  Frame,
  SlidersHorizontal,
  Captions as CaptionsIcon,
  CheckCircle2,
  Wand2,
  Lightbulb,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useEditorReal, type RightTool } from "./context";
import {
  resolveAiCaptionStatus,
  projectSourceFingerprint,
} from "@/lib/analysis/ai-caption-status";

/**
 * The far-right vertical tool rail (replaces the old horizontal EditorToolbar
 * row). A single "Re-analyze" AI action sits at the top, separated from the
 * five docked-inspector tools (Canvas / Effects / Captions / Presets /
 * Insights) — clicking one toggles its floating panel; the active tool is the
 * one purple item. Crop is DIFFERENT: it has no side panel — it edits directly
 * on the preview (CropEditorOverlay's own floating control bar), so its button
 * toggles `cropEditing` instead of `activeTool`, and closes any open dock panel
 * on entry so the two editing surfaces never overlap. Uses horizontal space
 * only — the preview + timeline keep their full height.
 */
export function EditorToolRail({
  hasAnalysis,
  isAnalyzingNow,
  canAnalyze,
  analyzeTitle,
  onReanalyze,
}: {
  hasAnalysis: boolean;
  isAnalyzingNow: boolean;
  canAnalyze: boolean;
  analyzeTitle?: string;
  onReanalyze: () => void;
}) {
  const {
    project,
    activeTool,
    setActiveTool,
    cropEditing,
    openCropEditor,
    closeCropEditor,
  } = useEditorReal();

  const captions = resolveAiCaptionStatus({
    moments: project.analysis?.detectedMoments,
    transcript: project.analysis?.transcript,
    currentSourceFingerprint: projectSourceFingerprint(project),
  });
  const captionIcon =
    captions.state === "processing" ? (
      <Loader2 size={17} className="animate-spin" />
    ) : captions.state === "generated" ? (
      <CheckCircle2 size={17} />
    ) : (
      <CaptionsIcon size={17} />
    );

  const toggle = (t: RightTool) => setActiveTool(activeTool === t ? null : t);

  const toggleCrop = () => {
    if (cropEditing) {
      closeCropEditor();
    } else {
      // Mutually exclusive with the docked panels — crop's own floating
      // control bar lives on the preview and shouldn't compete with a panel.
      setActiveTool(null);
      openCropEditor();
    }
  };

  return (
    <nav
      aria-label="Editor tools"
      // Hold region so clicking a tool doesn't dismiss the floating inspector.
      data-editor-dialog-hold
      className="flex w-14 shrink-0 flex-col items-stretch gap-1 border-l border-white/[0.06] bg-surface/60 px-1.5 py-2 backdrop-blur-xl"
    >
      {/* AI action — separated from the persistent tools. */}
      <RailButton
        label={hasAnalysis ? "Re-analyze" : "AI edit"}
        title={
          analyzeTitle ??
          (hasAnalysis ? "Re-run the AI analysis" : "Generate your AI edit")
        }
        onClick={onReanalyze}
        disabled={hasAnalysis ? isAnalyzingNow : !canAnalyze}
        icon={
          isAnalyzingNow ? (
            <Loader2 size={17} className="animate-spin" />
          ) : (
            <Sparkles size={17} />
          )
        }
      />

      <span aria-hidden className="mx-2 my-1 h-px shrink-0 bg-white/[0.08]" />

      <RailButton label="Crop" title="Crop the source frame (applies everywhere)" icon={<Crop size={17} />} active={cropEditing} onClick={toggleCrop} />
      <RailButton label="Canvas" title="Output canvas — aspect, fit, background" icon={<Frame size={17} />} active={activeTool === "canvas"} onClick={() => toggle("canvas")} />
      <RailButton label="Effects" title="Global effects" icon={<SlidersHorizontal size={17} />} active={activeTool === "effects"} onClick={() => toggle("effects")} />
      <RailButton label="Captions" title="AI captions" icon={captionIcon} active={activeTool === "captions"} onClick={() => toggle("captions")} />
      <RailButton label="Presets" title="One-click looks & your saved presets" icon={<Wand2 size={17} />} active={activeTool === "presets"} onClick={() => toggle("presets")} />
      <RailButton label="Insights" title="AI insights & suggestions" icon={<Lightbulb size={17} />} active={activeTool === "insights"} onClick={() => toggle("insights")} />
    </nav>
  );
}

function RailButton({
  label,
  title,
  icon,
  active,
  disabled,
  onClick,
}: {
  label: string;
  title?: string;
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cn(
        "group flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[9.5px] font-medium leading-tight transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:pointer-events-none disabled:opacity-35",
        active
          ? "bg-violet-500/20 text-violet-100 ring-1 ring-violet-400/30"
          : "text-fog hover:bg-white/[0.04] hover:text-white"
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="w-full truncate text-center">{label}</span>
    </button>
  );
}
