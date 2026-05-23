"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Pause, Play, Square, X, Mic } from "lucide-react";
import { cn } from "@/lib/cn";
import { WebcamPreview } from "./WebcamPreview";

/**
 * Floating in-progress HUD — a single calm pill anchored bottom-center, plus
 * an optional draggable webcam bubble. Designed to stay out of the user's way
 * during a screen recording while remaining unmistakably present.
 */
export function RecordingHUD({
  elapsedSeconds,
  micLevel,
  paused,
  webcamStream,
  onPause,
  onResume,
  onStop,
  onCancel,
}: {
  elapsedSeconds: number;
  micLevel: number;
  paused: boolean;
  webcamStream: MediaStream | null;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onCancel: () => void;
}) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <>
      <motion.div
        key="rec-hud"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 14 }}
        transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
        className="fixed bottom-6 left-1/2 z-[140] flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/15 bg-ink/95 px-3 py-2 shadow-cinematic backdrop-blur-xl"
        role="region"
        aria-label="Recording controls"
      >
        <div
          className={cn(
            "inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
            paused
              ? "bg-amber-500/15 text-amber-200"
              : "bg-rose-500/15 text-rose-200"
          )}
        >
          <span className="relative inline-flex size-2 items-center justify-center">
            {!paused && (
              <span className="absolute inset-0 -m-1 rounded-full bg-rose-400/40 animate-ping" />
            )}
            <span
              className={cn(
                "relative size-2 rounded-full",
                paused ? "bg-amber-300" : "bg-rose-400"
              )}
            />
          </span>
          {paused ? "Paused" : "Rec"}
        </div>

        <div className="px-2 font-mono text-sm tabular-nums text-white">
          {fmt(elapsedSeconds)}
        </div>

        <span aria-hidden className="h-5 w-px bg-white/10" />

        <HUDButton
          label={paused ? "Resume recording" : "Pause recording"}
          onClick={paused ? onResume : onPause}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </HUDButton>

        <HUDButton label="Stop recording" onClick={onStop} variant="primary">
          <Square size={12} fill="currentColor" />
        </HUDButton>

        <HUDButton label="Cancel recording" onClick={onCancel}>
          <X size={13} />
        </HUDButton>

        <span aria-hidden className="h-5 w-px bg-white/10" />

        <div className="flex items-center gap-1.5 pl-1 pr-2">
          <Mic size={11} className="text-fog" />
          <MicMeter level={micLevel} />
        </div>
      </motion.div>

      <AnimatePresence>
        {webcamStream && (
          <motion.div
            key="rec-webcam"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="fixed bottom-24 right-6 z-[139]"
          >
            <WebcamPreview stream={webcamStream} size={120} />
          </motion.div>
        )}
      </AnimatePresence>
    </>,
    document.body
  );
}

function HUDButton({
  children,
  label,
  onClick,
  variant = "default",
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: "default" | "primary";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-full transition-colors duration-150",
        variant === "primary"
          ? "bg-rose-500 text-white hover:bg-rose-500/90"
          : "border border-white/10 bg-white/[0.04] text-white/85 hover:border-white/25 hover:text-white"
      )}
    >
      {children}
    </button>
  );
}

function MicMeter({ level }: { level: number }) {
  const bars = 5;
  const active = Math.max(0, Math.min(bars, Math.round(level * bars + 0.4)));
  return (
    <div className="flex items-center gap-[2px]">
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-3 w-[3px] rounded-full transition-colors duration-100",
            i < active ? "bg-violet-300/85" : "bg-white/12"
          )}
        />
      ))}
    </div>
  );
}

function fmt(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
