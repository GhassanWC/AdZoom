"use client";

import * as React from "react";
import {
  Sparkles,
  Loader2,
  Crop,
  Frame,
  Captions as CaptionsIcon,
  CheckCircle2,
  LayoutTemplate,
  Lightbulb,
  Scissors,
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
  isAnalyzingNow,
  analyzeTitle,
}: {
  isAnalyzingNow: boolean;
  /** Why analysis can't run, when it can't — shown on the AI button. */
  analyzeTitle?: string;
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
      <Loader2 size={24} className="animate-spin" />
    ) : captions.state === "generated" ? (
      <CheckCircle2 size={24} />
    ) : (
      <CaptionsIcon size={24} />
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
      {/* The AI action — separated from the persistent tools.
          It opens the CHAT, not the options dialog. Asking for an edit is now a
          sentence, and the dialog full of toggles is what sits behind the chat's
          ⚙ for the times you want to set something exactly. Never disabled: a
          conversation you can't open in order to read what it did last time is
          not much of a conversation. */}
      <RailButton
        label="AI"
        title={analyzeTitle ?? "Edit with AI — ask for a change in plain English"}
        onClick={() => toggle("ai-chat")}
        active={activeTool === "ai-chat"}
        icon={
          isAnalyzingNow ? (
            <Loader2 size={24} className="animate-spin" />
          ) : (
            <Sparkles size={24} />
          )
        }
      />

      <span aria-hidden className="mx-2 my-1 h-px shrink-0 bg-white/[0.08]" />

      {/* No Director button: the Director is not a tool you open, it's the final
          stage of the analysis the AI action above starts. Its brief lives at the
          top of that dialog (AnalysisOptionsModal → DirectorBriefFields). */}
      <RailButton label="Crop" title="Crop the source frame (applies everywhere)" icon={<Crop size={24} />} active={cropEditing} onClick={toggleCrop} />
      <RailButton label="Clips" title="AI-generated short clips from this video" icon={<Scissors size={24} />} active={activeTool === "clips"} onClick={() => toggle("clips")} />
      <RailButton label="Canvas" title="Output canvas — aspect, fit, background" icon={<Frame size={24} />} active={activeTool === "canvas"} onClick={() => toggle("canvas")} />
      <RailButton label="Captions" title="AI captions" icon={captionIcon} active={activeTool === "captions"} onClick={() => toggle("captions")} />
      {/* ONE presets button. It holds the library (a designed caption / title /
          hook / CTA / transition, dropped on the timeline as a real edit) AND the
          whole-recording Looks, which used to be a second button of their own.
          No Effects button either: those sliders were global, and they're now on
          the edit you select — see MomentInspector's EffectMotionControls. */}
      <RailButton label="Presets" title="Presets & Looks — captions, titles, hooks, CTAs, transitions, and one-click looks" icon={<LayoutTemplate size={24} />} active={activeTool === "presets-library"} onClick={() => toggle("presets-library")} />
      <RailButton label="Insights" title="AI insights & suggestions" icon={<Lightbulb size={24} />} active={activeTool === "insights"} onClick={() => toggle("insights")} />
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
      // Labels are gone from the rail, so the tooltip (and aria-label) now carry
      // the tool's name for discoverability. Fall back to the label if no
      // dedicated title was supplied.
      title={title ?? label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cn(
        "group flex items-center justify-center rounded-lg py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:pointer-events-none disabled:opacity-35",
        // Colour/ring carry the active highlight; transform carries the press.
        // Named properties only — `transition-all` here would also animate the
        // icon swap (the captions icon morphs between states) into a smear.
        "fv-press-sm transition-[background-color,color,box-shadow] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
        active
          ? "bg-violet-500/20 text-violet-100 ring-1 ring-violet-400/30"
          : "text-fog hover:bg-white/[0.04] hover:text-white"
      )}
    >
      <span className="shrink-0">{icon}</span>
    </button>
  );
}
