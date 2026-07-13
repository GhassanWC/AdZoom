"use client";

import * as React from "react";
import { Scissors } from "lucide-react";
import type { GeneratedClip } from "@/lib/firebase/schema";
import { cn } from "@/lib/cn";
import { MIN_PILL_PX, MIN_RENDER_DURATION } from "./constants";
import { fmt } from "./utils";

/**
 * Read-only lane of AI-generated short clips.
 *
 * Smart Clips are WINDOWS into the same source video (no media duplication), so
 * they belong on the source timeline: each clip is a pill spanning its
 * `startTime`→`endTime`, positioned exactly like a moment pill
 * (percentage-of-`total`; the parent owns the zoom transform).
 *
 * The lane never mutates a clip. Clicking a pill OPENS it in the Clips panel and
 * moves the playhead to its start — so "which part of the recording is this
 * clip?" is answerable at a glance instead of by reading two timecodes.
 *
 * Empty `clips` → renders nothing. Whether the row exists at all is the parent's
 * decision, not this component's.
 */

/** Same width heuristic MomentPill uses to pick a content tier. */
const APPROX_VIEWPORT_PX = 500;

export function ClipsLane({
  clips,
  total,
  focusedClipId,
  onOpen,
  onSeek,
}: {
  /** AI-generated clips for this project (source-time windows). */
  clips: GeneratedClip[];
  /** Source duration in seconds. */
  total: number;
  /** The clip currently open in the Clips panel — rendered as active. */
  focusedClipId: string | null;
  /** Open the clip (the pill's primary action). */
  onOpen: (id: string) => void;
  /** Move the playhead — fired alongside `onOpen` so the preview follows. */
  onSeek: (t: number) => void;
}) {
  if (clips.length === 0) return null;

  return (
    <div className="absolute inset-0 z-10">
      {clips.map((clip) => (
        <ClipPill
          key={clip.id}
          clip={clip}
          total={total}
          focused={focusedClipId === clip.id}
          onOpen={onOpen}
          onSeek={onSeek}
        />
      ))}
    </div>
  );
}

function ClipPill({
  clip,
  total,
  focused,
  onOpen,
  onSeek,
}: {
  clip: GeneratedClip;
  total: number;
  focused: boolean;
  onOpen: (id: string) => void;
  onSeek: (t: number) => void;
}) {
  // Prefer the cached duration, fall back to the window, then to a floor — a
  // clip must never collapse into a zero-width sliver.
  const rawDur = Number.isFinite(clip.duration) && clip.duration > 0
    ? clip.duration
    : clip.endTime - clip.startTime;
  const duration = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 0;
  const renderDur = duration > 0 ? duration : MIN_RENDER_DURATION;

  const left = total > 0 ? (clip.startTime / total) * 100 : 0;
  const widthPct = total > 0 ? (renderDur / total) * 100 : 2;

  // Narrow pills drop the title and keep the icon — same tiering as MomentPill.
  const approxPx = (widthPct / 100) * APPROX_VIEWPORT_PX;
  const tier: "icon" | "label" = approxPx < 76 ? "icon" : "label";

  return (
    <div
      className="group absolute touch-none"
      style={{
        left: `${left}%`,
        width: `${widthPct}%`,
        // Floor the rendered width so a short clip on a long recording still
        // reads as a block, not a hairline marker.
        minWidth: `${MIN_PILL_PX}px`,
        top: 4,
        bottom: 4,
      }}
    >
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onSeek(clip.startTime);
          onOpen(clip.id);
        }}
        title={`${clip.title}\n${fmt(clip.startTime)}–${fmt(clip.endTime)} · ${duration.toFixed(1)}s${
          clip.reason ? `\n${clip.reason}` : ""
        }`}
        aria-label={`Open clip ${clip.title}, ${duration.toFixed(1)} seconds from ${fmt(
          clip.startTime
        )}`}
        aria-current={focused ? "true" : undefined}
        className={cn(
          "relative flex h-full w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-xl",
          "border bg-gradient-to-br px-2 text-left text-white backdrop-blur-sm",
          "shadow-[0_10px_28px_-14px_rgba(0,0,0,0.85)]",
          // Named properties only — transform/opacity/shadow composite cheaply
          // even with a lane full of pills.
          "transition-[box-shadow,transform,--tw-ring-color,--tw-ring-shadow] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
          focused
            ? "border-violet-200/60 from-violet-500/90 via-violet-500/60 to-fuchsia-500/35 ring-2 ring-violet-100/90 shadow-[0_8px_36px_-12px_rgba(139,92,246,0.95)]"
            : cn(
                "border-violet-300/35 from-violet-500/70 via-violet-500/45 to-fuchsia-500/25",
                // `fv-lift` is pointer-gated, so a tap can't strand a pill in
                // its hovered state on touch devices.
                "fv-lift ring-1 ring-white/10 hover:ring-violet-200/60",
                "hover:shadow-[0_8px_36px_-12px_rgba(139,92,246,0.95)]"
              )
        )}
      >
        <span
          aria-hidden
          className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-black/30 ring-1 ring-violet-200/30"
        >
          <Scissors size={11} className="opacity-95" />
        </span>

        {tier !== "icon" && (
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold leading-tight tracking-tight">
            {clip.title}
          </span>
        )}

        <span className="ml-auto shrink-0 rounded bg-black/40 px-1 py-[1px] font-mono text-[9.5px] font-bold tabular-nums leading-none ring-1 ring-white/25">
          {duration >= 60 ? fmt(duration) : `${duration.toFixed(1)}s`}
        </span>
      </button>
    </div>
  );
}
