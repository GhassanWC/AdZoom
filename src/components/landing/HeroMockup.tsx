"use client";

import { motion } from "framer-motion";
import { Sparkles, MousePointer2, Smartphone } from "lucide-react";

// Hotspots inside the mockup that the AI "auto-zooms" to
const hotspots = [
  // [x%, y%, w%, h%]
  { x: 14, y: 18, w: 32, h: 22 },
  { x: 56, y: 38, w: 34, h: 30 },
  { x: 26, y: 66, w: 44, h: 22 },
];

const cursorPath = [
  { x: 28, y: 28 },
  { x: 70, y: 50 },
  { x: 46, y: 76 },
  { x: 28, y: 28 },
];

export function HeroMockup() {
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
        className="relative aspect-[16/10] w-full overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-cinematic"
      >
        {/* macOS-style chrome */}
        <div className="flex h-9 items-center gap-3 border-b border-white/[0.06] bg-white/[0.03] px-4">
          <div className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-rose-400/80" />
            <span className="size-2.5 rounded-full bg-amber-400/80" />
            <span className="size-2.5 rounded-full bg-emerald-400/80" />
          </div>
          <div className="ml-2 flex h-5 items-center gap-2 rounded-md bg-white/[0.04] px-2 text-[10px] text-fog">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>
            recording.mp4 — Framevo
          </div>
        </div>

        {/* Inner recording — fake SaaS UI */}
        <div className="relative h-[calc(100%-2.25rem)] overflow-hidden bg-gradient-to-br from-[#0B0D11] to-[#0E1218]">
          {/* mini sidebar */}
          <div className="absolute inset-y-0 left-0 flex w-[18%] flex-col gap-2 border-r border-white/[0.05] bg-white/[0.015] p-3">
            <div className="h-3 w-2/3 rounded bg-white/10" />
            <div className="mt-2 space-y-1.5">
              <div className="h-2.5 rounded bg-white/[0.06]" />
              <div className="h-2.5 w-4/5 rounded bg-violet-500/40" />
              <div className="h-2.5 w-3/4 rounded bg-white/[0.06]" />
              <div className="h-2.5 w-2/3 rounded bg-white/[0.06]" />
              <div className="h-2.5 w-3/5 rounded bg-white/[0.06]" />
            </div>
          </div>

          {/* main content area */}
          <div className="absolute inset-y-0 left-[18%] right-0 p-4">
            <div className="mb-3 h-4 w-2/5 rounded bg-white/10" />
            <div className="grid grid-cols-3 gap-2">
              <div className="aspect-[4/3] rounded-lg border border-white/[0.06] bg-white/[0.03]">
                <div className="m-2 space-y-1.5">
                  <div className="h-1.5 w-2/3 rounded bg-white/15" />
                  <div className="h-1.5 w-4/5 rounded bg-white/[0.06]" />
                  <div className="h-1.5 w-1/2 rounded bg-white/[0.06]" />
                </div>
              </div>
              <div className="aspect-[4/3] rounded-lg border border-violet-400/40 bg-gradient-to-br from-violet-500/10 to-cyan-400/10 ring-1 ring-inset ring-violet-400/30">
                <div className="m-2 space-y-1.5">
                  <div className="h-1.5 w-2/3 rounded bg-white/25" />
                  <div className="h-1.5 w-4/5 rounded bg-white/15" />
                  <div className="h-1.5 w-1/2 rounded bg-white/10" />
                </div>
              </div>
              <div className="aspect-[4/3] rounded-lg border border-white/[0.06] bg-white/[0.03]">
                <div className="m-2 space-y-1.5">
                  <div className="h-1.5 w-2/3 rounded bg-white/15" />
                  <div className="h-1.5 w-4/5 rounded bg-white/[0.06]" />
                  <div className="h-1.5 w-1/2 rounded bg-white/[0.06]" />
                </div>
              </div>
            </div>

            {/* button area */}
            <div className="mt-4 flex items-center gap-2">
              <div className="h-7 w-24 rounded-md bg-violet-500/80" />
              <div className="h-7 w-20 rounded-md border border-white/10 bg-white/[0.03]" />
              <div className="ml-auto h-7 w-7 rounded-md border border-white/10 bg-white/[0.03]" />
            </div>

            {/* fake code block */}
            <div className="mt-4 space-y-1.5 rounded-lg border border-white/[0.06] bg-black/30 p-3 font-mono text-[10px]">
              <div className="text-violet-300/80">function <span className="text-white/80">enhanceRecording</span>(<span className="text-cyan-400/80">video</span>) {"{"}</div>
              <div className="pl-3 text-white/50">  const zooms = ai.detectZoomRegions(video);</div>
              <div className="pl-3 text-white/50">  return render(video, zooms);</div>
              <div className="text-violet-300/80">{"}"}</div>
            </div>
          </div>

          {/* AI Zoom region — animates between hotspots */}
          <motion.div
            className="pointer-events-none absolute z-20"
            initial={false}
            animate={{
              left: [
                `${hotspots[0].x}%`,
                `${hotspots[1].x}%`,
                `${hotspots[2].x}%`,
                `${hotspots[0].x}%`,
              ],
              top: [
                `${hotspots[0].y}%`,
                `${hotspots[1].y}%`,
                `${hotspots[2].y}%`,
                `${hotspots[0].y}%`,
              ],
              width: [
                `${hotspots[0].w}%`,
                `${hotspots[1].w}%`,
                `${hotspots[2].w}%`,
                `${hotspots[0].w}%`,
              ],
              height: [
                `${hotspots[0].h}%`,
                `${hotspots[1].h}%`,
                `${hotspots[2].h}%`,
                `${hotspots[0].h}%`,
              ],
            }}
            transition={{
              duration: 6.4,
              repeat: Infinity,
              ease: [0.22, 1, 0.36, 1],
              times: [0, 0.33, 0.66, 1],
            }}
          >
            <div className="relative h-full w-full rounded-md ring-2 ring-violet-400/70 shadow-[0_0_0_4px_rgba(139,92,246,0.15)]">
              {/* corner brackets */}
              <span className="absolute -left-0.5 -top-0.5 size-2.5 border-l-2 border-t-2 border-violet-300" />
              <span className="absolute -right-0.5 -top-0.5 size-2.5 border-r-2 border-t-2 border-violet-300" />
              <span className="absolute -bottom-0.5 -left-0.5 size-2.5 border-b-2 border-l-2 border-violet-300" />
              <span className="absolute -bottom-0.5 -right-0.5 size-2.5 border-b-2 border-r-2 border-violet-300" />
              {/* label */}
              <span className="absolute -top-6 left-0 inline-flex items-center gap-1 rounded-md bg-violet-500 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white shadow-violet-glow">
                <Sparkles size={9} /> Auto Zoom
              </span>
            </div>
          </motion.div>

          {/* Cursor + trail */}
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
            <CursorIcon />
            <span className="absolute -bottom-1 -right-1 inline-block size-2 rounded-full bg-violet-400/60 blur-[2px]" />
          </motion.div>

          {/* Click ring */}
          <motion.span
            className="pointer-events-none absolute z-20 size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-violet-400/70"
            initial={false}
            animate={{
              left: cursorPath.map((p) => `${p.x}%`),
              top: cursorPath.map((p) => `${p.y}%`),
              scale: [0.4, 1.6, 0.4, 1.6],
              opacity: [0, 0.7, 0, 0.7],
            }}
            transition={{
              duration: 6.4,
              repeat: Infinity,
              ease: "easeOut",
              times: [0, 0.33, 0.66, 1],
            }}
          />
        </div>
      </motion.div>

      {/* Floating effect chips */}
      <FloatingChip
        icon={<Sparkles size={12} />}
        label="Auto Zoom On"
        className="-left-3 top-12 sm:-left-6"
        delay={0.4}
      />
      <FloatingChip
        icon={<MousePointer2 size={12} />}
        label="Cursor Smoothing"
        className="-right-3 top-1/3 sm:-right-6"
        delay={0.9}
      />
      <FloatingChip
        icon={<Smartphone size={12} />}
        label="Export 1080p"
        className="-left-3 bottom-10 sm:-left-6"
        delay={1.4}
      />
    </div>
  );
}

function CursorIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      className="drop-shadow-[0_2px_6px_rgba(139,92,246,0.6)]"
    >
      <path
        d="M3 2 L17 9 L10 11 L9 18 Z"
        fill="white"
        stroke="rgba(0,0,0,0.5)"
        strokeWidth="0.6"
      />
    </svg>
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
