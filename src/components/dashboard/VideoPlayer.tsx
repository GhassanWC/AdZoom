"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  Play,
  Pause,
  Volume2,
  Maximize2,
  Sparkles,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { FakeRecording } from "./FakeRecording";

// AI zoom hotspots — coords as % of player
const hotspots = [
  { x: 22, y: 26, w: 28, h: 30, label: "menu" },
  { x: 56, y: 38, w: 32, h: 34, label: "card" },
  { x: 60, y: 64, w: 32, h: 22, label: "code" },
];

const cursorPath = [
  { x: 30, y: 36 },
  { x: 68, y: 50 },
  { x: 70, y: 72 },
  { x: 30, y: 36 },
];

export function VideoPlayer({ format = "16:9" }: { format?: "16:9" | "9:16" }) {
  const [playing, setPlaying] = React.useState(true);

  return (
    <div className="relative">
      {/* main player surface */}
      <div
        className={
          format === "16:9"
            ? "relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-white/[0.06] bg-surface shadow-cinematic"
            : "relative mx-auto aspect-[9/16] max-h-[70vh] overflow-hidden rounded-xl border border-white/[0.06] bg-surface shadow-cinematic"
        }
      >
        <FakeRecording />

        {/* Auto zoom region */}
        <motion.div
          className="pointer-events-none absolute z-20"
          initial={false}
          animate={
            playing
              ? {
                  left: hotspots.map((h) => `${h.x}%`).concat(`${hotspots[0].x}%`),
                  top: hotspots.map((h) => `${h.y}%`).concat(`${hotspots[0].y}%`),
                  width: hotspots.map((h) => `${h.w}%`).concat(`${hotspots[0].w}%`),
                  height: hotspots.map((h) => `${h.h}%`).concat(`${hotspots[0].h}%`),
                }
              : {
                  left: `${hotspots[0].x}%`,
                  top: `${hotspots[0].y}%`,
                  width: `${hotspots[0].w}%`,
                  height: `${hotspots[0].h}%`,
                }
          }
          transition={{
            duration: 7.5,
            repeat: playing ? Infinity : 0,
            ease: [0.22, 1, 0.36, 1],
            times: [0, 0.33, 0.66, 1],
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

        {/* Cursor */}
        <motion.div
          className="pointer-events-none absolute z-30"
          initial={false}
          animate={
            playing
              ? {
                  left: cursorPath.map((p) => `${p.x}%`),
                  top: cursorPath.map((p) => `${p.y}%`),
                }
              : { left: `${cursorPath[0].x}%`, top: `${cursorPath[0].y}%` }
          }
          transition={{
            duration: 7.5,
            repeat: playing ? Infinity : 0,
            ease: [0.45, 0, 0.55, 1],
            times: [0, 0.33, 0.66, 1],
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" className="drop-shadow-[0_2px_6px_rgba(139,92,246,0.6)]">
            <path d="M3 2 L17 9 L10 11 L9 18 Z" fill="white" stroke="rgba(0,0,0,0.5)" strokeWidth="0.6" />
          </svg>
        </motion.div>

        {/* Click ring */}
        <motion.span
          className="pointer-events-none absolute z-20 size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-violet-400/70"
          initial={false}
          animate={
            playing
              ? {
                  left: cursorPath.map((p) => `${p.x}%`),
                  top: cursorPath.map((p) => `${p.y}%`),
                  scale: [0.4, 1.6, 0.4, 1.6],
                  opacity: [0, 0.7, 0, 0.7],
                }
              : { opacity: 0 }
          }
          transition={{
            duration: 7.5,
            repeat: playing ? Infinity : 0,
            ease: "easeOut",
            times: [0, 0.33, 0.66, 1],
          }}
        />

        {/* AI status chip */}
        <div className="pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/10 px-2.5 py-1 text-[10px] font-medium text-violet-200 backdrop-blur-md">
          <span className="relative inline-flex size-1.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-violet-400/70" />
            <span className="relative inline-block size-1.5 rounded-full bg-violet-400" />
          </span>
          AI tracking
        </div>

        {/* Vignette */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,0.35)_100%)]"
        />

        {/* Controls bar */}
        <div className="absolute inset-x-0 bottom-0 z-40 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-4 pb-3 pt-10">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? "Pause" : "Play"}
              className="inline-flex size-8 items-center justify-center rounded-full bg-white text-ink transition-transform duration-200 hover:scale-105"
            >
              {playing ? <Pause size={14} className="fill-ink" /> : <Play size={14} className="fill-ink" />}
            </button>
            <button aria-label="Skip back" className="text-fog transition-colors duration-200 hover:text-white">
              <SkipBack size={14} />
            </button>
            <button aria-label="Skip forward" className="text-fog transition-colors duration-200 hover:text-white">
              <SkipForward size={14} />
            </button>
            <span className="font-mono text-[11px] tabular-nums text-fog">
              00:42 <span className="text-fog/50">/ 03:08</span>
            </span>
            <div className="ml-2 flex flex-1 items-center gap-2">
              <Volume2 size={13} className="text-fog" />
              <div className="h-0.5 w-16 rounded-full bg-white/15">
                <div className="h-full w-2/3 rounded-full bg-white" />
              </div>
            </div>
            <button aria-label="Fullscreen" className="text-fog transition-colors duration-200 hover:text-white">
              <Maximize2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
