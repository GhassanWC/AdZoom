"use client";

import * as React from "react";
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
  Pencil,
  ChevronRight,
} from "lucide-react";
import { useEditorReal } from "./context";
import { seedKeyframes } from "@/lib/timeline/camera";
import { cn } from "@/lib/cn";
import {
  EFFECT_ICONS,
  EFFECT_TONES,
  PROVENANCE_PRESENTATION,
} from "./timeline/constants";
import type { DetectedMoment, MomentProvenance } from "@/lib/firebase/schema";

function provenanceOf(m: DetectedMoment): MomentProvenance {
  if (m.provenance) return m.provenance;
  if (m.source === "user") return "user";
  return "ai";
}

/**
 * Cinematic contextual editing toolbar.
 *
 * Two faces:
 *   • Idle  — quick-add row + global counts. Looks like a creative studio
 *             floating dock.
 *   • Focused — a selected moment promotes the dock into a contextual
 *               inspector strip with provenance, attention, intensity slider,
 *               and the same edit actions. Premium "you are editing X" feel.
 */
export function EditorToolbar() {
  const {
    addMomentAtPlayhead,
    selectedMomentId,
    project,
    duplicateMoment,
    deleteMoment,
    updateMoment,
    openInspector,
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
    <div
      className={cn(
        "glass relative overflow-hidden rounded-2xl transition-all duration-300",
        selected &&
          "ring-1 ring-violet-400/30 shadow-[0_24px_48px_-32px_rgba(139,92,246,0.55)]"
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -top-16 left-1/4 h-32 w-2/3 transition-opacity duration-500",
          selected
            ? "bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.24),transparent_70%)] opacity-100 blur-3xl"
            : "bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.1),transparent_70%)] opacity-60 blur-2xl"
        )}
      />

      <div className="relative flex flex-wrap items-center gap-3 px-4 py-3">
        {selected ? (
          <SelectedHeader moment={selected} />
        ) : (
          <IdleHeader aiCount={aiCount} userCount={userCount} />
        )}

        <span aria-hidden className="hidden h-9 w-px bg-white/[0.08] sm:block" />

        {/* Quick-add cluster */}
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

        <span aria-hidden className="hidden h-9 w-px bg-white/[0.08] sm:block" />

        {/* Selection-scoped actions */}
        <div className="flex flex-wrap items-center gap-1.5">
          <ToolButton
            Icon={Pencil}
            label="Edit"
            tip="Open the full moment inspector"
            onClick={() => selected && openInspector()}
            disabled={!selected}
            accent="violet"
          />
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

        {!selected && (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] text-fog">
            <Sparkles size={11} className="text-violet-300" />
            Click a timeline moment to edit it
          </span>
        )}
      </div>

      {/* ── Contextual strip: intensity + reasoning when selected ─────── */}
      {selected && (
        <div className="relative border-t border-white/[0.06] bg-black/15 px-5 py-3.5">
          <div className="flex flex-wrap items-center gap-5">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <IntensitySlider
                value={Math.round((selected.intensity ?? 1) * 100)}
                onChange={(v) =>
                  void updateMoment(selected.id, { intensity: v / 100 })
                }
              />
            </div>
            {selected.reason && (
              <span className="hidden min-w-0 max-w-md truncate text-[11.5px] italic text-white/70 lg:inline">
                “{selected.reason}”
              </span>
            )}
            <button
              type="button"
              onClick={() => openInspector()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-violet-400/35 bg-violet-500/15 px-3 py-1.5 text-[11.5px] font-medium text-violet-100 transition-colors duration-150 hover:bg-violet-500/25"
            >
              Open inspector
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function IdleHeader({
  aiCount,
  userCount,
}: {
  aiCount: number;
  userCount: number;
}) {
  return (
    <div className="flex items-center gap-2.5 pr-1">
      <span className="inline-flex size-9 items-center justify-center rounded-xl bg-violet-500/15 text-violet-200 ring-1 ring-violet-300/30">
        <Move3D size={14} />
      </span>
      <div className="leading-tight">
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-fog">
          Edit toolbar
        </div>
        <div className="text-[12px] text-white/85">
          <span className="font-semibold text-violet-200">{aiCount}</span> AI ·{" "}
          <span className="font-semibold text-cyan-200">{userCount}</span> yours
        </div>
      </div>
    </div>
  );
}

function SelectedHeader({ moment }: { moment: DetectedMoment }) {
  const Icon = EFFECT_ICONS[moment.effectType] ?? Sparkles;
  const tones = EFFECT_TONES[moment.effectType] ?? EFFECT_TONES.zoom;
  const prov = provenanceOf(moment);
  const provInfo = PROVENANCE_PRESENTATION[prov];
  const attention = moment.attentionScore ?? moment.importance ?? 0.5;
  return (
    <div className="flex min-w-0 items-center gap-3 pr-1">
      <span
        className={cn(
          "inline-flex size-10 items-center justify-center rounded-xl bg-gradient-to-br text-white ring-1 ring-white/15",
          tones.ai
        )}
      >
        <Icon size={15} />
      </span>
      <div className="min-w-0 leading-tight">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-200/90">
          Editing
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[9.5px] font-semibold leading-none",
              provInfo.chip
            )}
          >
            <provInfo.Icon size={9} strokeWidth={2.5} />
            {provInfo.short}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[13.5px] font-semibold text-white">
          <span className="max-w-[220px] truncate">{moment.label}</span>
          <span className="font-mono text-[10.5px] tabular-nums text-fog">
            ATN {Math.round(attention * 100)}
          </span>
        </div>
      </div>
    </div>
  );
}

function IntensitySlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex min-w-[220px] flex-1 items-center gap-3 text-[11px] text-fog">
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog/80">
        Intensity
      </span>
      <input
        type="range"
        min={20}
        max={150}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="range-thumb h-1 flex-1"
        aria-label="Intensity"
      />
      <span className="w-12 text-right font-mono text-[11px] tabular-nums text-white/85">
        {value}%
      </span>
    </label>
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
  if (primary) {
    return (
      <span
        title={tip}
        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-violet-400/45 bg-violet-500/20 px-3 text-[11px] font-semibold text-violet-50 shadow-[0_8px_20px_-12px_rgba(139,92,246,0.6)]"
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
        "border-white/10 bg-white/[0.025] text-white/85 hover:-translate-y-px hover:border-white/30 hover:bg-white/[0.06] hover:text-white",
        accent === "violet" &&
          "hover:border-violet-300/45 hover:bg-violet-500/15 hover:text-violet-50",
        accent === "cyan" &&
          "hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-cyan-100",
        danger &&
          "hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-200",
        disabled &&
          "cursor-not-allowed opacity-40 hover:translate-y-0 hover:border-white/10 hover:bg-white/[0.025] hover:text-white/85"
      )}
    >
      <Icon size={13} className="shrink-0 opacity-90" />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}
