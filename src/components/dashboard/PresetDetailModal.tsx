"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  X,
  Sparkles,
  Check,
  Wand2,
  Copy,
  Trash2,
  User,
  Smartphone,
  Monitor,
  MousePointer2,
  Target,
  Zap,
} from "lucide-react";
import type { EffectsSettings, Preset } from "@/lib/firebase/schema";
import { Button } from "@/components/ui/Button";
import { PresetThumb } from "@/components/landing/PresetThumb";
import { cn } from "@/lib/cn";

interface PresetDetailModalProps {
  preset: Preset;
  open: boolean;
  onClose: () => void;
  onApply?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  applyLabel?: string;
  applied?: boolean;
  /** Current settings — used to render a before/after delta. */
  currentSettings?: EffectsSettings;
}

export function PresetDetailModal({
  preset,
  open,
  onClose,
  onApply,
  onDuplicate,
  onDelete,
  applyLabel = "Apply to current project",
  applied,
  currentSettings,
}: PresetDetailModalProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/80 px-4 backdrop-blur-xl"
        >
          <motion.div
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="glass-strong relative max-h-[90vh] w-full max-w-3xl overflow-hidden overflow-y-auto rounded-2xl shadow-cinematic"
          >
            <button
              onClick={onClose}
              aria-label="Close"
              className="absolute right-4 top-4 z-10 inline-flex size-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white transition-colors duration-200 hover:bg-white/[0.08]"
            >
              <X size={15} />
            </button>

            <div className="grid grid-cols-1 gap-0 md:grid-cols-[1.1fr_1fr]">
              {/* Before / After mini-preview */}
              <div className="border-b border-white/[0.06] p-6 md:border-b-0 md:border-r">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
                  Before · After preview
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <PreviewTile vibe={preset.vibe} variant="before" />
                  <PreviewTile vibe={preset.vibe} variant="after" />
                </div>

                <div className="mt-3 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-fog">
                  <span>Raw recording</span>
                  <span className="text-violet-300">With {preset.name}</span>
                </div>

                <div className="mt-6">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
                    Thumbnail
                  </div>
                  <div className="mt-2 aspect-[16/10] overflow-hidden rounded-lg border border-white/[0.06]">
                    <PresetThumb vibe={preset.vibe} />
                  </div>
                </div>
              </div>

              {/* Details + settings */}
              <div className="p-6">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-medium text-fog">
                    {preset.category}
                  </span>
                  {preset.isCustom && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-violet-400/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-200">
                      <User size={10} />
                      Custom
                    </span>
                  )}
                  {applied && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/40 bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-200">
                      <Check size={10} />
                      Applied
                    </span>
                  )}
                </div>

                <h2 className="mt-3 font-display text-2xl font-semibold tracking-tight text-white">
                  {preset.name}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-fog">
                  {preset.description}
                </p>

                {preset.useCase && (
                  <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
                      Best for
                    </div>
                    <p className="text-xs text-white/85">{preset.useCase}</p>
                  </div>
                )}

                <SettingsList preset={preset} currentSettings={currentSettings} />

                <div className="mt-6 flex flex-wrap gap-2">
                  {onApply && (
                    <Button
                      onClick={onApply}
                      variant="primary"
                      size="md"
                      leftIcon={<Wand2 size={14} />}
                      className="flex-1"
                    >
                      {applied ? "Re-apply" : applyLabel}
                    </Button>
                  )}
                  {onDuplicate && (
                    <Button
                      onClick={onDuplicate}
                      variant="ghost"
                      size="md"
                      leftIcon={<Copy size={13} />}
                    >
                      Duplicate
                    </Button>
                  )}
                  {onDelete && (
                    <Button
                      onClick={onDelete}
                      variant="ghost"
                      size="md"
                      leftIcon={<Trash2 size={13} />}
                      className="text-rose-300 hover:!border-rose-400/40 hover:!bg-rose-500/[0.08]"
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

function SettingsList({
  preset,
  currentSettings,
}: {
  preset: Preset;
  currentSettings?: EffectsSettings;
}) {
  const e = preset.effects;
  const PlatformIcon =
    e.targetPlatform === "tiktok" || e.targetPlatform === "reels"
      ? Smartphone
      : Monitor;

  return (
    <div className="mt-5 space-y-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
        Settings included
      </div>
      <div className="grid grid-cols-2 gap-2">
        <SettingRow
          icon={<Sparkles size={11} className="text-violet-300" />}
          label="Zoom intensity"
          value={`${e.autoZoom}%`}
          delta={delta(currentSettings?.autoZoom, e.autoZoom, "%")}
        />
        <SettingRow
          icon={<Zap size={11} className="text-violet-300" />}
          label="Zoom speed"
          value={`${e.zoomSpeed}%`}
          delta={delta(currentSettings?.zoomSpeed, e.zoomSpeed, "%")}
        />
        <SettingRow
          icon={<MousePointer2 size={11} className="text-violet-300" />}
          label="Cursor size"
          value={`${e.cursorSize}%`}
          delta={delta(currentSettings?.cursorSize, e.cursorSize, "%")}
        />
        <SettingRow
          icon={<MousePointer2 size={11} className="text-violet-300" />}
          label="Cursor smoothing"
          value={`${e.cursorSmoothing}%`}
          delta={delta(currentSettings?.cursorSmoothing, e.cursorSmoothing, "%")}
        />
        <SettingRow
          icon={<Target size={11} className="text-violet-300" />}
          label="Click style"
          value={e.clickHighlightStyle}
        />
        <SettingRow
          icon={<Sparkles size={11} className="text-violet-300" />}
          label="Captions"
          value={prettyCaptionStyle(e.captionStyle)}
        />
        <SettingRow
          icon={<Zap size={11} className="text-violet-300" />}
          label="Pacing"
          value={e.pacing}
        />
        <SettingRow
          icon={<PlatformIcon size={11} className="text-violet-300" />}
          label="Platform"
          value={prettyPlatform(e.targetPlatform)}
        />
        <SettingRow
          icon={<PlatformIcon size={11} className="text-violet-300" />}
          label="Export format"
          value={e.defaultExportFormat}
        />
        <SettingRow
          icon={<Sparkles size={11} className="text-violet-300" />}
          label="Vertical"
          value={e.verticalExport ? "Yes" : "No"}
        />
      </div>
    </div>
  );
}

function SettingRow({
  icon,
  label,
  value,
  delta,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  delta?: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] text-fog">
        {icon}
        {label}
      </span>
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-white/90">
        {value}
        {delta && (
          <span
            className={cn(
              "rounded px-1 text-[9px] font-semibold",
              delta.startsWith("+")
                ? "bg-emerald-400/15 text-emerald-300"
                : delta.startsWith("-")
                  ? "bg-rose-400/15 text-rose-300"
                  : "bg-white/[0.04] text-fog"
            )}
          >
            {delta}
          </span>
        )}
      </span>
    </div>
  );
}

function delta(current: number | undefined, next: number, suffix: string): string | null {
  if (current === undefined) return null;
  const d = next - current;
  if (Math.abs(d) < 1) return null;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d}${suffix}`;
}

function prettyCaptionStyle(s: string): string {
  switch (s) {
    case "none":
      return "Off";
    case "minimal":
      return "Minimal";
    case "bold-pop":
      return "Bold pop";
    case "tutorial-tooltip":
      return "Tooltip";
    case "subtitle":
      return "Subtitle";
    default:
      return s;
  }
}

function prettyPlatform(p: string): string {
  switch (p) {
    case "youtube":
      return "YouTube";
    case "tiktok":
      return "TikTok";
    case "reels":
      return "Reels";
    case "twitter":
      return "Twitter";
    case "internal":
      return "Internal";
    default:
      return p;
  }
}

/** A tiny synthetic "before" / "after" tile shown in the modal. */
function PreviewTile({
  vibe,
  variant,
}: {
  vibe: Preset["vibe"];
  variant: "before" | "after";
}) {
  // The "after" tile applies a zoom + tint matching the vibe. The "before"
  // tile shows the same scene plain.
  const isVertical = vibe === "tiktok" || vibe === "shorts";
  return (
    <div
      className={cn(
        "relative aspect-[16/10] overflow-hidden rounded-lg border border-white/[0.06] bg-black",
        isVertical && variant === "after" && "aspect-[16/10]"
      )}
    >
      <div
        className={cn(
          "absolute inset-0 transition-transform",
          variant === "after" && "scale-[1.35]"
        )}
        style={
          variant === "after"
            ? { transformOrigin: "62% 55%" }
            : { transformOrigin: "50% 50%" }
        }
      >
        <PresetThumb vibe={vibe} />
      </div>

      {variant === "after" && (
        <>
          <span className="pointer-events-none absolute inset-x-0 top-0 h-3 bg-black/60" />
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-3 bg-black/60" />
          <span className="pointer-events-none absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-violet-300/80 shadow-[0_0_8px_rgba(139,92,246,0.6)]" />
        </>
      )}

      <span className="absolute right-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-white/90 backdrop-blur-md">
        {variant === "before" ? "Before" : "After"}
      </span>
    </div>
  );
}
