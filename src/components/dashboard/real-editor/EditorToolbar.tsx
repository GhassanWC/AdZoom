"use client";

import {
  Zap,
  Target,
  MousePointer2,
  FastForward,
  Diamond,
  Copy,
  Trash2,
  Plus,
  Sparkles,
  Move3D,
} from "lucide-react";
import { useEditorReal } from "./context";
import { seedKeyframes } from "@/lib/timeline/camera";
import { cn } from "@/lib/cn";

/**
 * Floating professional edit toolbar. The "real editing tool" surface — every
 * manual action is one tap away. AI is a first-draft assistant; the toolbar is
 * the user's editing surface.
 */
export function EditorToolbar() {
  const {
    addMomentAtPlayhead,
    selectedMomentId,
    project,
    duplicateMoment,
    deleteMoment,
    updateMoment,
    currentTime,
  } = useEditorReal();

  const moments = project.analysis?.detectedMoments ?? [];
  const selected = moments.find((m) => m.id === selectedMomentId) ?? null;
  const userCount = moments.filter((m) => m.source === "user").length;
  const aiCount = moments.length - userCount;

  const onAddKeyframe = () => {
    if (!selected) return;
    const dur = Math.max(0.1, selected.endTime - selected.startTime);
    const lt = Math.max(0, Math.min(1, (currentTime - selected.startTime) / dur));
    const cx = selected.focusRegion.x + selected.focusRegion.width / 2;
    const cy = selected.focusRegion.y + selected.focusRegion.height / 2;
    const scale = Math.max(
      0.2,
      Math.min(1, selected.intensity ?? selected.recommendedIntensity ?? 0.7)
    );
    const existing = selected.keyframes ?? [];
    // If keyframes exist already, drop one at the current playhead; otherwise
    // seed a classic punch-in across the moment.
    const next =
      existing.length > 0
        ? [
            ...existing.filter((k) => Math.abs(k.t - lt) > 0.02),
            {
              t: Math.round(lt * 1000) / 1000,
              x: Math.round(cx * 1000) / 1000,
              y: Math.round(cy * 1000) / 1000,
              scale: Math.round(scale * 1000) / 1000,
              ease: "ease-in-out" as const,
            },
          ].sort((a, b) => a.t - b.t)
        : seedKeyframes(selected);
    void updateMoment(selected.id, { keyframes: next });
  };

  return (
    <div className="glass relative overflow-hidden rounded-2xl">
      {/* subtle violet aurora */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-12 left-1/4 h-24 w-2/3 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.12),transparent_70%)] blur-2xl"
      />

      <div className="relative flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2 pr-1">
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
            <Move3D size={13} />
          </span>
          <div className="leading-tight">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
              Edit toolbar
            </div>
            <div className="text-[11px] text-white/85">
              <span className="text-violet-200">{aiCount}</span> AI ·{" "}
              <span className="text-cyan-200">{userCount}</span> yours
            </div>
          </div>
        </div>

        <span aria-hidden className="hidden h-8 w-px bg-white/[0.08] sm:block" />

        {/* Quick-add cluster — manual edits the AI didn't draft */}
        <div className="flex flex-wrap items-center gap-1.5">
          <ToolButton
            primary
            Icon={Plus}
            label="Add"
            tip="Insert a new edit at the playhead"
          />
          <ToolButton
            Icon={Zap}
            label="Zoom"
            tip="Cinematic zoom into a region"
            onClick={() => addMomentAtPlayhead("zoom")}
          />
          <ToolButton
            Icon={MousePointer2}
            label="Focus"
            tip="Soft focus on a region"
            onClick={() => addMomentAtPlayhead("cursor-focus")}
          />
          <ToolButton
            Icon={Target}
            label="Click"
            tip="Click highlight"
            onClick={() => addMomentAtPlayhead("click-highlight")}
          />
          <ToolButton
            Icon={MousePointer2}
            label="Cursor"
            tip="Lock the camera to cursor motion"
            onClick={() => addMomentAtPlayhead("cursor-focus")}
          />
          <ToolButton
            Icon={FastForward}
            label="Speed"
            tip="Speed-ramp a boring stretch"
            onClick={() => addMomentAtPlayhead("speed-up")}
          />
        </div>

        <span aria-hidden className="hidden h-8 w-px bg-white/[0.08] sm:block" />

        {/* Selection-scoped actions */}
        <div className="flex flex-wrap items-center gap-1.5">
          <ToolButton
            Icon={Diamond}
            label="Keyframe"
            tip={
              selected
                ? "Drop a camera keyframe at the playhead"
                : "Select a moment to add a keyframe"
            }
            onClick={onAddKeyframe}
            disabled={!selected}
            accent="cyan"
          />
          <ToolButton
            Icon={Copy}
            label="Duplicate"
            tip="Duplicate the selected moment (⌘D)"
            onClick={() => selected && duplicateMoment(selected.id)}
            disabled={!selected}
          />
          <ToolButton
            Icon={Trash2}
            label="Delete"
            tip="Remove the selected moment (Del)"
            onClick={() => selected && deleteMoment(selected.id)}
            disabled={!selected}
            danger
          />
        </div>

        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] text-fog">
          <Sparkles size={11} className="text-violet-300" />
          {selected ? (
            <>
              Editing{" "}
              <span className="font-medium text-white">{selected.label}</span>
            </>
          ) : (
            <>Click a timeline moment to edit it</>
          )}
        </span>
      </div>
    </div>
  );
}

interface ToolButtonProps {
  Icon: typeof Zap;
  label: string;
  tip: string;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  accent?: "violet" | "cyan";
}

function ToolButton({
  Icon,
  label,
  tip,
  onClick,
  disabled,
  primary,
  danger,
  accent,
}: ToolButtonProps) {
  // Primary "Add" is a label-only header for the cluster.
  if (primary) {
    return (
      <span
        title={tip}
        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-violet-400/40 bg-violet-500/15 px-3 text-[11px] font-semibold text-violet-100"
      >
        <Icon size={13} />
        {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={tip}
      aria-label={`${label} — ${tip}`}
      className={cn(
        "group inline-flex h-9 min-w-[3.75rem] items-center gap-1.5 rounded-xl border px-2.5 text-[11px] font-medium transition-all duration-200",
        "border-white/10 bg-white/[0.02] text-white/85 hover:-translate-y-px hover:border-white/25 hover:bg-white/[0.05] hover:text-white",
        accent === "cyan" &&
          "hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-cyan-100",
        danger && "hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-200",
        disabled &&
          "cursor-not-allowed opacity-40 hover:translate-y-0 hover:border-white/10 hover:bg-white/[0.02] hover:text-white/85"
      )}
    >
      <Icon size={13} className="shrink-0 opacity-90" />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}
