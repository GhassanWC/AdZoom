"use client";

import * as React from "react";
import {
  Trash2,
  Sparkles,
  MousePointer2,
  Target,
  FastForward,
  Diamond,
  Plus,
  Crosshair,
  X,
  ChevronDown,
  Clock,
  Camera,
  Type,
  Brain,
  Crop,
  Zap,
  MousePointerClick,
} from "lucide-react";
import { useEditorReal } from "./context";
import { Slider } from "@/components/ui/Slider";
import { Toggle } from "@/components/ui/Toggle";
import { cn } from "@/lib/cn";
import { seedKeyframes } from "@/lib/timeline/camera";
import type {
  DetectedMoment,
  EaseKind,
  EffectType,
  MomentKeyframe,
} from "@/lib/firebase/schema";

const EFFECTS: { id: EffectType; label: string; Icon: typeof Sparkles }[] = [
  { id: "zoom", label: "Zoom", Icon: Zap },
  { id: "click-highlight", label: "Click", Icon: Target },
  { id: "cursor-focus", label: "Focus", Icon: MousePointer2 },
  { id: "speed-up", label: "Speed-up", Icon: FastForward },
];

export function MomentInspector() {
  const {
    project,
    selectedMomentId,
    setSelectedMomentId,
    activeMoment,
    updateMoment,
    deleteMoment,
    duplicateMoment,
    currentTime,
    seek,
  } = useEditorReal();

  const moments = project.analysis?.detectedMoments ?? [];
  const moment =
    moments.find((m) => m.id === selectedMomentId) || activeMoment || null;

  if (!moment) {
    return <EmptyInspector hasMoments={moments.length > 0} status={project.status} />;
  }

  return (
    <div className="glass overflow-hidden rounded-2xl">
      {/* Header */}
      <div className="relative border-b border-white/[0.06] px-5 pb-4 pt-5">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-12 right-0 h-32 w-48 bg-[radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.18),transparent_60%)] blur-2xl"
        />
        <div className="relative flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
              Inspector
              {moment.source === "user" ? (
                <span className="rounded bg-cyan-400/15 px-1.5 py-0.5 text-[9px] font-semibold text-cyan-200">
                  Yours
                </span>
              ) : (
                <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-violet-200">
                  AI
                </span>
              )}
            </div>
            <input
              value={moment.label}
              onChange={(e) => updateMoment(moment.id, { label: e.target.value })}
              className="-ml-1 mt-1 w-full rounded-lg px-1 font-display text-lg font-semibold text-white outline-none transition-colors duration-150 focus:bg-white/[0.04]"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <IconButton
              label="Duplicate (⌘D)"
              onClick={() => duplicateMoment(moment.id)}
            >
              <Plus size={14} />
            </IconButton>
            <IconButton
              label="Delete (Del)"
              tone="danger"
              onClick={() => deleteMoment(moment.id)}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        </div>
      </div>

      {/* Grouped collapsible sections */}
      <div className="divide-y divide-white/[0.05]">
        <CollapsibleGroup
          icon={<Camera size={14} />}
          title="Motion"
          subtitle="Effect type & intensity"
          defaultOpen
        >
          <div className="grid grid-cols-4 gap-2">
            {EFFECTS.map((e) => {
              const active = moment.effectType === e.id;
              return (
                <button
                  key={e.id}
                  onClick={() => updateMoment(moment.id, { effectType: e.id })}
                  className={cn(
                    "group/eff flex flex-col items-center gap-1.5 rounded-xl border p-2.5 text-center transition-all duration-200",
                    active
                      ? "border-violet-400/40 bg-violet-500/15 text-violet-100 shadow-[0_0_24px_-8px_rgba(139,92,246,0.5)]"
                      : "border-white/10 bg-white/[0.02] text-fog hover:-translate-y-px hover:border-white/25 hover:text-white"
                  )}
                >
                  <e.Icon size={15} className="opacity-90" />
                  <span className="text-[11px] font-medium">{e.label}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-5">
            <Slider
              label="Zoom intensity"
              value={Math.round((moment.intensity ?? 1) * 100)}
              min={20}
              max={150}
              onChange={(v) => updateMoment(moment.id, { intensity: v / 100 })}
            />
          </div>
        </CollapsibleGroup>

        <CollapsibleGroup
          icon={<Clock size={14} />}
          title="Timing"
          subtitle={`${fmt(moment.startTime)} → ${fmt(moment.endTime)} · ${(
            moment.endTime - moment.startTime
          ).toFixed(1)}s`}
          defaultOpen
        >
          <div className="grid grid-cols-2 gap-3">
            <TimeField
              label="Start"
              value={moment.startTime}
              onChange={(v) => updateMoment(moment.id, { startTime: Math.max(0, v) })}
              onSeek={() => seek(moment.startTime)}
            />
            <TimeField
              label="End"
              value={moment.endTime}
              onChange={(v) =>
                updateMoment(moment.id, {
                  endTime: Math.max(moment.startTime + 0.1, v),
                })
              }
              onSeek={() => seek(moment.endTime)}
            />
          </div>
        </CollapsibleGroup>

        <CollapsibleGroup
          icon={<Diamond size={14} className="text-violet-300" />}
          title="Camera keyframes"
          subtitle={
            (moment.keyframes?.length ?? 0) > 0
              ? `${moment.keyframes!.length} keyframes`
              : "Static focus"
          }
        >
          <KeyframeEditor
            moment={moment}
            currentTime={currentTime}
            onChange={(keyframes) => updateMoment(moment.id, { keyframes })}
            onSeek={seek}
          />
        </CollapsibleGroup>

        <CollapsibleGroup
          icon={<MousePointerClick size={14} />}
          title="Cursor & focus"
          subtitle="Where the camera looks"
        >
          <FocusRegionEditor moment={moment} onChange={(fr) => updateMoment(moment.id, { focusRegion: fr })} />
        </CollapsibleGroup>

        <CollapsibleGroup
          icon={<Type size={14} />}
          title="Captions"
          subtitle={moment.caption ? "On for this moment" : "Off"}
        >
          <Toggle
            label="Show caption"
            description="Display the AI-suggested caption during this moment."
            checked={Boolean(moment.caption)}
            onChange={(v) => updateMoment(moment.id, { caption: v })}
          />
        </CollapsibleGroup>

        {moment.reason && (
          <CollapsibleGroup
            icon={<Brain size={14} className="text-violet-300" />}
            title="AI reasoning"
            subtitle="Why this beat made the cut"
          >
            <p className="rounded-xl border border-violet-400/20 bg-violet-500/[0.05] px-3.5 py-3 text-[13px] leading-relaxed text-white/85">
              {moment.reason}
            </p>
          </CollapsibleGroup>
        )}
      </div>

      <div className="border-t border-white/[0.06] px-5 py-3">
        <button
          onClick={() => setSelectedMomentId(null)}
          className="w-full text-center text-[11px] text-fog transition-colors duration-200 hover:text-white"
        >
          Clear selection
        </button>
      </div>
    </div>
  );
}

function EmptyInspector({
  hasMoments,
  status,
}: {
  hasMoments: boolean;
  status: string;
}) {
  return (
    <div className="glass relative overflow-hidden rounded-2xl p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 right-0 h-40 w-56 bg-[radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.18),transparent_65%)] blur-2xl"
      />
      <div className="relative">
        <div className="inline-flex size-11 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/20">
          <Crop size={18} />
        </div>
        <h3 className="mt-4 font-display text-base font-semibold text-white">
          Inspector
        </h3>
        {hasMoments ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-fog">
            Select a moment or create one manually. The AI's plan is fully editable —
            rename, retime, switch effect, or delete.
          </p>
        ) : status !== "analyzed" && status !== "completed" ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-fog">
            Run <strong className="text-white">Analyze with AI</strong> to generate a
            first-draft edit.
          </p>
        ) : (
          <p className="mt-1.5 text-[13px] leading-relaxed text-fog">
            No moments yet — use the toolbar above to add your first zoom, focus, or
            click highlight.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Collapsible group ──────────────────────────────────────────────────────

function CollapsibleGroup({
  icon,
  title,
  subtitle,
  defaultOpen = false,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors duration-150 hover:bg-white/[0.02]"
      >
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.03] text-fog ring-1 ring-white/[0.05] transition-colors duration-150 group-hover:text-white">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-white">{title}</div>
          {subtitle && (
            <div className="truncate text-[11px] text-fog">{subtitle}</div>
          )}
        </div>
        <ChevronDown
          size={14}
          className={cn(
            "shrink-0 text-fog transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>
      {open && <div className="px-5 pb-5 pt-1">{children}</div>}
    </div>
  );
}

// ─── Keyframe editor ────────────────────────────────────────────────────────

const EASES: EaseKind[] = ["linear", "ease-in", "ease-out", "ease-in-out"];

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function KeyframeEditor({
  moment,
  currentTime,
  onChange,
  onSeek,
}: {
  moment: DetectedMoment;
  currentTime: number;
  onChange: (keyframes: MomentKeyframe[] | undefined) => void;
  onSeek: (t: number) => void;
}) {
  const kfs = moment.keyframes ?? [];
  const dur = Math.max(0.1, moment.endTime - moment.startTime);
  const hasKfs = kfs.length > 0;

  const toLocal = (t: number) => clamp01((t - moment.startTime) / dur);
  const toAbs = (lt: number) => moment.startTime + lt * dur;

  const addAtPlayhead = () => {
    const lt = toLocal(currentTime);
    const cx = moment.focusRegion.x + moment.focusRegion.width / 2;
    const cy = moment.focusRegion.y + moment.focusRegion.height / 2;
    const scale = clamp01(
      moment.intensity ?? moment.recommendedIntensity ?? moment.attentionScore ?? 0.7
    );
    const next = [
      ...kfs.filter((k) => Math.abs(k.t - lt) > 0.02),
      {
        t: round3(lt),
        x: round3(cx),
        y: round3(cy),
        scale: round3(scale),
        ease: "ease-in-out" as EaseKind,
      },
    ].sort((a, b) => a.t - b.t);
    onChange(next);
  };

  const patchKf = (i: number, patch: Partial<MomentKeyframe>) => {
    const next = kfs
      .map((k, idx) => (idx === i ? { ...k, ...patch } : k))
      .sort((a, b) => a.t - b.t);
    onChange(next);
  };
  const removeKf = (i: number) => {
    const next = kfs.filter((_, idx) => idx !== i);
    onChange(next.length ? next : undefined);
  };

  if (!hasKfs) {
    return (
      <div className="space-y-3">
        <p className="text-[12px] leading-relaxed text-fog">
          Animate the camera across this moment — drop keyframes and the preview
          will play them live. Exports render identically.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onChange(seedKeyframes(moment))}
            className="rounded-xl border border-violet-400/30 bg-violet-500/10 py-2 text-[12px] font-medium text-violet-100 transition-colors duration-150 hover:bg-violet-500/20"
          >
            Add punch-in
          </button>
          <button
            type="button"
            onClick={addAtPlayhead}
            className="rounded-xl border border-white/10 bg-white/[0.02] py-2 text-[12px] font-medium text-fog transition-colors duration-150 hover:border-white/25 hover:text-white"
          >
            At playhead
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {kfs.map((k, i) => (
        <div key={i} className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2">
          <button
            type="button"
            onClick={() => onSeek(toAbs(k.t))}
            title="Jump to this keyframe"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 font-mono text-[10px] text-fog transition-colors duration-150 hover:text-white"
          >
            <Crosshair size={10} />
            {Math.round(k.t * 100)}%
          </button>
          <input
            type="range"
            min={20}
            max={130}
            value={Math.round(k.scale * 100)}
            onChange={(e) => patchKf(i, { scale: Number(e.target.value) / 100 })}
            aria-label="Keyframe zoom"
            className="range-thumb h-1 flex-1"
            title={`Zoom ${Math.round(k.scale * 100)}%`}
          />
          <select
            value={k.ease ?? "ease-in-out"}
            onChange={(e) => patchKf(i, { ease: e.target.value as EaseKind })}
            aria-label="Keyframe easing"
            className="h-8 rounded-lg border border-white/10 bg-white/[0.03] px-1 text-[10px] text-white outline-none focus:border-white/20"
          >
            {EASES.map((ez) => (
              <option key={ez} value={ez} className="bg-ink">
                {ez}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => removeKf(i)}
            aria-label="Remove keyframe"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-fog transition-colors duration-150 hover:bg-rose-500/10 hover:text-rose-300"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <div className="grid grid-cols-2 gap-2 pt-1">
        <button
          type="button"
          onClick={addAtPlayhead}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-violet-400/30 bg-violet-500/10 py-2 text-[12px] font-medium text-violet-100 transition-colors duration-150 hover:bg-violet-500/20"
        >
          <Plus size={12} />
          At playhead
        </button>
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="rounded-xl border border-white/10 bg-white/[0.02] py-2 text-[12px] font-medium text-fog transition-colors duration-150 hover:border-rose-400/30 hover:text-rose-300"
        >
          Clear all
        </button>
      </div>
    </div>
  );
}

// ─── Focus region editor ────────────────────────────────────────────────────

function FocusRegionEditor({
  moment,
  onChange,
}: {
  moment: DetectedMoment;
  onChange: (fr: DetectedMoment["focusRegion"]) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-relaxed text-fog">
        Drag the violet box on the preview to retarget the camera. Fine-tune
        below if you need exact coordinates.
      </p>
      <div className="grid grid-cols-4 gap-2">
        {(["x", "y", "width", "height"] as const).map((k) => (
          <label key={k} className="block">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fog">
              {k}
            </span>
            <input
              type="number"
              step={0.01}
              min={0}
              max={1}
              value={Number(moment.focusRegion[k].toFixed(2))}
              onChange={(e) =>
                onChange({
                  ...moment.focusRegion,
                  [k]: Math.max(0, Math.min(1, Number(e.target.value))),
                })
              }
              className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-white/[0.02] px-2 font-mono text-[12px] text-white outline-none focus:border-white/25"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

// ─── Misc atoms ─────────────────────────────────────────────────────────────

function IconButton({
  label,
  tone,
  onClick,
  children,
}: {
  label: string;
  tone?: "danger";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.02] text-fog transition-all duration-200 hover:-translate-y-px hover:border-white/25 hover:text-white",
        tone === "danger" &&
          "hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-300"
      )}
    >
      {children}
    </button>
  );
}

function TimeField({
  label,
  value,
  onChange,
  onSeek,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  onSeek: () => void;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fog">
          {label}
        </span>
        <button
          type="button"
          onClick={onSeek}
          className="text-[10px] text-fog transition-colors duration-150 hover:text-white"
        >
          Seek
        </button>
      </div>
      <div className="relative">
        <input
          type="number"
          step={0.1}
          min={0}
          value={Number(value.toFixed(2))}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.02] px-3 pr-8 font-mono text-[13px] text-white outline-none focus:border-white/25"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-fog">
          s
        </span>
      </div>
    </label>
  );
}

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}
