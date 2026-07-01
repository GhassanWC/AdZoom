"use client";

import * as React from "react";
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Undo2,
  Redo2,
  HelpCircle,
  BarChart2,
  Plus,
  Scissors,
  Copy,
  Trash2,
  ChevronDown,
  Zap,
  MousePointer2,
  Target,
  FastForward,
  Type,
  Sparkles,
  Megaphone,
  EyeOff,
  BadgeCheck,
  Captions,
  Shuffle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { EffectType } from "@/lib/firebase/schema";
import { fmt } from "./utils";

/** Aggregated single-signal health used by the dot. */
export type TimelineHealth = "balanced" | "clustered" | "quiet" | "empty";

/**
 * Unified timeline toolbar — the single bar above the tracks that holds every
 * timeline-level control: add / split / duplicate / delete, zoom & fit, undo &
 * redo, the analytics (Insights) toggle, a shortcuts popover, the AI-health
 * dot, and the playhead time readout. Replaces the old minimal header and the
 * separate per-moment dock so the editing controls live in one professional,
 * compact place (Premiere / CapCut feel) without clutter.
 */
export function TimelineToolbar({
  health,
  zoom,
  minZoom,
  maxZoom,
  onZoomIn,
  onZoomOut,
  onFit,
  currentTime,
  total,
  insightsOpen,
  onToggleInsights,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  hasSelection,
  onAdd,
  onDuplicate,
  onDelete,
}: {
  health: TimelineHealth;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  currentTime: number;
  total: number;
  insightsOpen: boolean;
  onToggleInsights: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  hasSelection: boolean;
  onAdd: (effectType: EffectType) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="relative border-b border-white/[0.06] px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {/* ── Identity ─────────────────────────────────────────────── */}
        <div className="flex min-w-0 items-center gap-2.5 pr-1">
          <h3 className="font-display text-[14px] font-semibold tracking-tight text-white">
            Timeline
          </h3>
          <HealthDot health={health} />
        </div>

        <Divider />

        {/* ── Edit group ───────────────────────────────────────────── */}
        <div className="flex items-center gap-1">
          <AddMenu onAdd={onAdd} />
          <IconBtn
            Icon={Scissors}
            label="Split"
            tip="Split clip at playhead — coming soon"
            disabled
          />
          <IconBtn
            Icon={Copy}
            label="Duplicate"
            tip="Duplicate selected moment (⌘D)"
            onClick={onDuplicate}
            disabled={!hasSelection}
          />
          <IconBtn
            Icon={Trash2}
            label="Delete"
            tip="Delete selected moment (Del)"
            onClick={onDelete}
            disabled={!hasSelection}
            danger
          />
        </div>

        <Divider />

        {/* ── History group ────────────────────────────────────────── */}
        <div className="flex items-center gap-1">
          <IconBtn
            Icon={Undo2}
            label="Undo"
            tip="Undo (⌘Z)"
            onClick={onUndo}
            disabled={!canUndo}
          />
          <IconBtn
            Icon={Redo2}
            label="Redo"
            tip="Redo (⌘⇧Z)"
            onClick={onRedo}
            disabled={!canRedo}
          />
        </div>

        {/* ── View group + meta (right-aligned) ────────────────────── */}
        <div className="ml-auto flex items-center gap-2">
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/[0.025] p-1">
            <IconBtn
              Icon={ZoomOut}
              label="Zoom out"
              tip="Zoom timeline out"
              onClick={onZoomOut}
              disabled={zoom <= minZoom}
              bare
            />
            <span className="w-9 text-center font-mono text-[11px] tabular-nums text-fog">
              {zoom.toFixed(1)}×
            </span>
            <IconBtn
              Icon={ZoomIn}
              label="Zoom in"
              tip="Zoom timeline in"
              onClick={onZoomIn}
              disabled={zoom >= maxZoom}
              bare
            />
            <IconBtn
              Icon={Maximize2}
              label="Fit"
              tip="Fit timeline to screen"
              onClick={onFit}
              bare
            />
          </div>

          <TipsPopover />

          <button
            type="button"
            onClick={onToggleInsights}
            aria-expanded={insightsOpen}
            title={insightsOpen ? "Hide analytics" : "Show analytics"}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-medium transition-colors duration-150",
              insightsOpen
                ? "border-violet-400/40 bg-violet-500/12 text-violet-100"
                : "border-white/10 bg-white/[0.025] text-fog hover:border-white/25 hover:text-white"
            )}
          >
            <BarChart2 size={12} />
            <span className="hidden sm:inline">Insights</span>
          </button>

          <span className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 font-mono text-[12px] font-medium tabular-nums text-white">
            {fmt(currentTime)}
            <span className="text-fog/70"> / {fmt(total)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="hidden h-6 w-px bg-white/[0.08] sm:block" />;
}

interface IconBtnProps {
  Icon: LucideIcon;
  label: string;
  tip: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Bare = no border/background chrome (used inside grouped pills). */
  bare?: boolean;
}

function IconBtn({ Icon, label, tip, onClick, disabled, danger, bare }: IconBtnProps) {
  if (bare) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        title={tip}
        className="inline-flex size-7 items-center justify-center rounded-md text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white disabled:pointer-events-none disabled:opacity-30"
      >
        <Icon size={13} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={tip}
      className={cn(
        "group inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.025] px-2 text-[11.5px] font-medium text-white/85 transition-all duration-150",
        "hover:border-white/25 hover:bg-white/[0.06] hover:text-white",
        danger && "hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-200",
        disabled &&
          "cursor-not-allowed opacity-35 hover:border-white/10 hover:bg-white/[0.025] hover:text-white/85"
      )}
    >
      <Icon size={13} className="shrink-0" />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

type AddEffectSpec = { id: EffectType; label: string; Icon: LucideIcon; hint: string; group: "edit" | "overlay" };
const ADD_EFFECTS: AddEffectSpec[] = [
  { id: "zoom", label: "Zoom", Icon: Zap, hint: "Cinematic zoom into a region", group: "edit" },
  { id: "cursor-focus", label: "Focus", Icon: MousePointer2, hint: "Soft focus / cursor follow", group: "edit" },
  { id: "click-highlight", label: "Click", Icon: Target, hint: "Click highlight", group: "edit" },
  { id: "cut", label: "Cut", Icon: Scissors, hint: "Mark a dead section to remove", group: "edit" },
  { id: "speed-up", label: "Speed", Icon: FastForward, hint: "Speed up a slow stretch", group: "edit" },
  // Phase-3 overlays — manually addable text / annotation / redaction edits.
  { id: "text-overlay", label: "Text overlay", Icon: Type, hint: "Positioned text label", group: "overlay" },
  { id: "hook-text", label: "Hook text", Icon: Sparkles, hint: "Big attention line", group: "overlay" },
  { id: "captions", label: "Caption", Icon: Captions, hint: "A subtitle line you type", group: "overlay" },
  { id: "callout", label: "Callout", Icon: Megaphone, hint: "Point at part of the frame", group: "overlay" },
  { id: "blur-redaction", label: "Blur", Icon: EyeOff, hint: "Hide a sensitive region", group: "overlay" },
  { id: "branding-cta", label: "CTA", Icon: BadgeCheck, hint: "End-card call to action", group: "overlay" },
  { id: "transition", label: "Transition", Icon: Shuffle, hint: "Quick fade between scenes", group: "overlay" },
  // NB: smart-crop is applied via the Canvas tool (output framing), not a
  // playhead moment, so it's intentionally not offered here.
];

function AddMenu({ onAdd }: { onAdd: (e: EffectType) => void }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Insert a new edit at the playhead"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-violet-400/40 bg-violet-500/15 px-2.5 text-[11.5px] font-semibold text-violet-50 transition-colors duration-150 hover:bg-violet-500/25"
      >
        <Plus size={13} />
        <span className="hidden sm:inline">Add</span>
        <ChevronDown size={11} className="opacity-70" />
      </button>
      {open && (
        <div className="absolute left-0 top-10 z-40 max-h-[70vh] w-52 overflow-y-auto rounded-xl border border-white/10 bg-ink/95 p-1 shadow-cinematic backdrop-blur-xl">
          {ADD_EFFECTS.map(({ id, label, Icon, hint, group }, i) => (
            <React.Fragment key={id}>
              {group === "overlay" && ADD_EFFECTS[i - 1]?.group === "edit" && (
                <div className="mx-2 my-1 border-t border-white/[0.07] pt-1 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-fog/70">
                  Overlays
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  onAdd(id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-white/[0.06]"
              >
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.05] text-violet-200 ring-1 ring-white/10">
                  <Icon size={13} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-white">{label}</span>
                  <span className="block truncate text-[10.5px] text-fog">{hint}</span>
                </span>
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

const HEALTH_PRESENTATION: Record<
  TimelineHealth,
  { dot: string; label: string; tooltip: string }
> = {
  balanced: {
    dot: "bg-emerald-400",
    label: "Balanced",
    tooltip:
      "Moments are well distributed and the density looks healthy. Open Insights for the full breakdown.",
  },
  clustered: {
    dot: "bg-amber-300",
    label: "Clustered",
    tooltip:
      "Several moments are bunched together. Open Insights to see distribution.",
  },
  quiet: {
    dot: "bg-amber-300",
    label: "Quiet sections",
    tooltip:
      "Parts of the video have no detected activity. Open Insights to find them.",
  },
  empty: {
    dot: "bg-white/30",
    label: "No moments",
    tooltip: "No moments on the timeline yet.",
  },
};

function HealthDot({ health }: { health: TimelineHealth }) {
  const cfg = HEALTH_PRESENTATION[health];
  return (
    <span
      title={cfg.tooltip}
      className="hidden items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-2 py-[3px] text-[11px] font-medium text-fog sm:inline-flex"
    >
      <span className={cn("size-1.5 rounded-full", cfg.dot)} />
      <span>{cfg.label}</span>
    </span>
  );
}

const TIPS = [
  ["Drag a clip", "to move it"],
  ["Drag the edges", "to retime"],
  ["Click the lane", "to seek"],
  ["Shift / ⌘ + click", "to multi-select"],
  ["Space", "play / pause"],
  ["Del / Backspace", "remove selection"],
  ["⌘D", "duplicate"],
  ["⌘Z / ⌘⇧Z", "undo / redo"],
  ["Esc", "clear multi-select"],
] as const;

function TipsPopover() {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Timeline shortcuts"
        className={cn(
          "inline-flex size-8 items-center justify-center rounded-lg border text-fog transition-colors duration-150",
          open
            ? "border-violet-400/40 bg-violet-500/12 text-violet-100"
            : "border-white/10 bg-white/[0.025] hover:border-white/25 hover:text-white"
        )}
      >
        <HelpCircle size={13} />
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-40 w-72 overflow-hidden rounded-xl border border-white/10 bg-ink/95 shadow-cinematic backdrop-blur-xl">
          <div className="border-b border-white/[0.06] px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
            Shortcuts
          </div>
          <ul className="space-y-1.5 px-4 py-3 text-[12px]">
            {TIPS.map(([action, hint]) => (
              <li key={action} className="flex items-baseline justify-between gap-3">
                <span className="text-white/85">{action}</span>
                <span className="text-fog">{hint}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
