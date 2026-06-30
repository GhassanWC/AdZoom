"use client";

import { motion } from "framer-motion";
import {
  Sparkles,
  MousePointer2,
  Download,
  Play,
  ZoomIn,
  Target,
  Scissors,
  FastForward,
} from "lucide-react";

/**
 * A premium, animated mock of the Framevo EDITOR — not a raw recording. It
 * shows the four things that make Framevo an AI video editor at a glance:
 * a live preview with an AI auto-zoom following the cursor, an AI-moments
 * status, an editable timeline of AI edit pills, and an export action.
 *
 * Token-based surfaces (bg-surface / white tints / brand ramps) so it adapts
 * to light + dark mode through the global theme overrides, exactly like the
 * rest of the landing page.
 */

// Hotspots the AI auto-zoom box travels between inside the preview.
const hotspots = [
  { x: 12, y: 16, w: 34, h: 26 },
  { x: 54, y: 40, w: 36, h: 30 },
  { x: 24, y: 58, w: 46, h: 26 },
];
const cursorPath = [
  { x: 29, y: 29 },
  { x: 72, y: 55 },
  { x: 47, y: 71 },
  { x: 29, y: 29 },
];

// AI edit pills laid out on the timeline (left% / width% / tone).
const TIMELINE_PILLS = [
  { Icon: ZoomIn, label: "Zoom", left: 4, width: 20, tone: "violet" as const },
  { Icon: Target, label: "Click", left: 27, width: 11, tone: "fuchsia" as const },
  { Icon: Scissors, label: "Cut", left: 41, width: 14, tone: "rose" as const },
  { Icon: ZoomIn, label: "Zoom", left: 58, width: 22, tone: "violet" as const },
  { Icon: FastForward, label: "Speed", left: 83, width: 13, tone: "amber" as const },
];

const PILL_TONE: Record<string, string> = {
  violet: "border-violet-400/40 bg-violet-500/20 text-violet-100",
  fuchsia: "border-fuchsia-400/40 bg-fuchsia-500/20 text-fuchsia-100",
  rose: "border-rose-400/40 bg-rose-500/20 text-rose-100",
  amber: "border-amber-300/40 bg-amber-400/20 text-amber-100",
};

export function EditorPreviewMock() {
  return (
    <div className="relative mx-auto w-full">
      {/* soft outer glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-10 -z-10 rounded-[40px] bg-[radial-gradient(circle_at_50%_30%,rgba(139,92,246,0.22),transparent_60%)] blur-2xl"
      />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        className="relative overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-cinematic"
      >
        {/* Window chrome */}
        <div className="flex h-9 items-center gap-3 border-b border-white/[0.06] bg-white/[0.03] px-4">
          <div className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-rose-400/80" />
            <span className="size-2.5 rounded-full bg-amber-400/80" />
            <span className="size-2.5 rounded-full bg-emerald-400/80" />
          </div>
          <div className="ml-1 flex items-center gap-1.5 text-[11px] font-medium text-fog">
            <Sparkles size={11} className="text-violet-300" />
            Framevo — Editor
          </div>
        </div>

        {/* Editor top bar — project + AI status + export */}
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-3.5 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="truncate font-display text-[12.5px] font-semibold text-white">
              product-demo.mp4
            </span>
            <span className="hidden items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-200 sm:inline-flex">
              <Sparkles size={10} />
              18 AI moments
            </span>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500 px-2.5 py-1 text-[11px] font-semibold text-white shadow-[0_6px_18px_-6px_rgba(139,92,246,0.7)]">
            <Download size={12} />
            Export
          </span>
        </div>

        {/* Preview pane */}
        <div className="p-3 sm:p-4">
          <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-white/[0.06] bg-gradient-to-br from-white/[0.04] to-white/[0.01]">
            {/* fake recorded app */}
            <div className="absolute inset-0">
              <div className="absolute inset-y-0 left-0 w-[20%] border-r border-white/[0.05] bg-white/[0.015] p-2.5">
                <div className="h-2.5 w-2/3 rounded bg-white/10" />
                <div className="mt-3 space-y-1.5">
                  <div className="h-2 rounded bg-white/[0.06]" />
                  <div className="h-2 w-4/5 rounded bg-violet-500/40" />
                  <div className="h-2 w-3/4 rounded bg-white/[0.06]" />
                  <div className="h-2 w-2/3 rounded bg-white/[0.06]" />
                </div>
              </div>
              <div className="absolute inset-y-0 left-[20%] right-0 p-3">
                <div className="mb-2.5 h-3 w-2/5 rounded bg-white/10" />
                <div className="grid grid-cols-3 gap-2">
                  <div className="aspect-[4/3] rounded-lg border border-white/[0.06] bg-white/[0.03]" />
                  <div className="aspect-[4/3] rounded-lg border border-violet-400/40 bg-gradient-to-br from-violet-500/15 to-cyan-400/10 ring-1 ring-inset ring-violet-400/30" />
                  <div className="aspect-[4/3] rounded-lg border border-white/[0.06] bg-white/[0.03]" />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <div className="h-6 w-20 rounded-md bg-violet-500/80" />
                  <div className="h-6 w-16 rounded-md border border-white/10 bg-white/[0.03]" />
                </div>
              </div>
            </div>

            {/* AI tracking chip */}
            <div className="absolute left-2.5 top-2.5 z-30 inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-black/40 px-2 py-1 text-[10px] font-medium text-[#C4B5FD] backdrop-blur-md">
              <span className="relative inline-flex size-1.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-violet-400/70" />
                <span className="relative inline-block size-1.5 rounded-full bg-violet-400" />
              </span>
              AI tracking
            </div>

            {/* AI auto-zoom region */}
            <motion.div
              className="pointer-events-none absolute z-20"
              initial={false}
              animate={{
                left: hotspots.map((h) => `${h.x}%`),
                top: hotspots.map((h) => `${h.y}%`),
                width: hotspots.map((h) => `${h.w}%`),
                height: hotspots.map((h) => `${h.h}%`),
              }}
              transition={{
                duration: 6.4,
                repeat: Infinity,
                ease: [0.22, 1, 0.36, 1],
                times: [0, 0.5, 1],
              }}
            >
              <div className="relative h-full w-full rounded-md ring-2 ring-violet-400/70 shadow-[0_0_0_4px_rgba(139,92,246,0.15)]">
                <span className="absolute -left-0.5 -top-0.5 size-2.5 border-l-2 border-t-2 border-violet-300" />
                <span className="absolute -right-0.5 -top-0.5 size-2.5 border-r-2 border-t-2 border-violet-300" />
                <span className="absolute -bottom-0.5 -left-0.5 size-2.5 border-b-2 border-l-2 border-violet-300" />
                <span className="absolute -bottom-0.5 -right-0.5 size-2.5 border-b-2 border-r-2 border-violet-300" />
                <span className="absolute -top-6 left-0 inline-flex items-center gap-1 rounded-md bg-violet-500 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white shadow-violet-glow">
                  <Sparkles size={9} /> Auto Zoom
                </span>
              </div>
            </motion.div>

            {/* Cursor + click ring */}
            <motion.div
              className="pointer-events-none absolute z-30"
              initial={false}
              animate={{
                left: cursorPath.map((p) => `${p.x}%`),
                top: cursorPath.map((p) => `${p.y}%`),
              }}
              transition={{
                duration: 6.4,
                repeat: Infinity,
                ease: [0.45, 0, 0.55, 1],
                times: [0, 0.33, 0.66, 1],
              }}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" className="drop-shadow-[0_2px_6px_rgba(139,92,246,0.6)]">
                <path d="M3 2 L17 9 L10 11 L9 18 Z" fill="white" stroke="rgba(0,0,0,0.5)" strokeWidth="0.6" />
              </svg>
            </motion.div>
            <motion.span
              className="pointer-events-none absolute z-20 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border border-violet-400/70"
              initial={false}
              animate={{
                left: cursorPath.map((p) => `${p.x}%`),
                top: cursorPath.map((p) => `${p.y}%`),
                scale: [0.4, 1.6, 0.4, 1.6],
                opacity: [0, 0.7, 0, 0.7],
              }}
              transition={{ duration: 6.4, repeat: Infinity, ease: "easeOut", times: [0, 0.33, 0.66, 1] }}
            />
          </div>

          {/* Timeline */}
          <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.015] p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-fog">
                <Play size={10} className="text-violet-300" />
                Timeline
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-fog">
                <span className="inline-flex items-center gap-1">
                  <Sparkles size={10} className="text-violet-300" /> AI
                </span>
                <span className="inline-flex items-center gap-1">
                  <MousePointer2 size={10} className="text-cyan-300" /> You
                </span>
              </div>
            </div>

            {/* ruler */}
            <div className="mb-2 flex items-center gap-1">
              {Array.from({ length: 12 }).map((_, i) => (
                <span key={i} className="h-2 flex-1 border-l border-white/[0.06]" />
              ))}
            </div>

            {/* lane with AI edit pills + playhead */}
            <div className="relative h-9 rounded-lg bg-white/[0.02]">
              {TIMELINE_PILLS.map((p, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 4 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: 0.15 + i * 0.08 }}
                  className={`absolute inset-y-1 inline-flex items-center gap-1 overflow-hidden rounded-md border px-1.5 text-[9.5px] font-semibold ${PILL_TONE[p.tone]}`}
                  style={{ left: `${p.left}%`, width: `${p.width}%` }}
                >
                  <p.Icon size={10} className="shrink-0" />
                  <span className="hidden truncate sm:inline">{p.label}</span>
                </motion.div>
              ))}
              {/* playhead */}
              <motion.span
                className="absolute inset-y-0 z-10 w-px bg-cyan-300 shadow-[0_0_6px_rgba(34,211,238,0.8)]"
                initial={false}
                animate={{ left: ["6%", "92%"] }}
                transition={{ duration: 6.4, repeat: Infinity, ease: "linear" }}
              >
                <span className="absolute -top-1 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-cyan-300" />
              </motion.span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Floating chips */}
      <FloatingChip icon={<Sparkles size={12} />} label="Auto Zoom On" className="-left-3 top-16 sm:-left-6" delay={0.4} />
      <FloatingChip icon={<MousePointer2 size={12} />} label="Cursor Smoothing" className="-right-3 top-1/3 sm:-right-6" delay={0.9} />
      <FloatingChip icon={<Download size={12} />} label="Export MP4 · 1080p" className="-left-3 bottom-12 sm:-left-6" delay={1.4} />
    </div>
  );
}

function FloatingChip({
  icon,
  label,
  className,
  delay,
}: {
  icon: React.ReactNode;
  label: string;
  className?: string;
  delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
      className={`absolute z-10 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-surface/85 px-3 py-1.5 text-[11px] font-medium text-white/90 shadow-cinematic backdrop-blur-xl ${className ?? ""}`}
    >
      <span className="text-violet-300">{icon}</span>
      {label}
    </motion.div>
  );
}
