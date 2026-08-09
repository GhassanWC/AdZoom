"use client";

import * as React from "react";
import type { NarrativeRole } from "@/lib/firebase/schema";
import { useClockSelector } from "../playback-clock";
import { cn } from "@/lib/cn";
import {
  NARRATIVE_COLORS,
  NARRATIVE_LABEL,
  NARRATIVE_TEXT,
  TRACK_HEIGHTS,
  MIN_PILL_PX,
  MIN_RENDER_DURATION,
} from "./constants";

interface Segment {
  startTime: number;
  endTime: number;
  role: NarrativeRole;
  label: string;
}

/**
 * Netflix-style chapter strip. Each AI-classified segment becomes a card
 * with a role tag, a title, and a duration — clicking jumps the playhead to
 * the chapter's start. Active chapter glows. Wide enough segments expand
 * to show the full label; narrow ones collapse to the role only.
 */
export function NarrativeBand({
  segments,
  duration,
  onSeek,
}: {
  segments: Segment[];
  duration: number;
  onSeek: (t: number) => void;
}) {
  // Only the ACTIVE CHAPTER matters here, and that changes a handful of times per
  // video — so this subscribes to the derived index rather than the raw time and
  // re-renders on chapter boundaries instead of several times a second.
  const activeIndex = useClockSelector((t) =>
    segments.findIndex((s) => t >= s.startTime && t <= s.endTime)
  );
  if (segments.length === 0 || duration <= 0) return null;
  return (
    <div
      style={{ height: TRACK_HEIGHTS.chapters }}
      className="relative flex w-full items-stretch gap-[3px]"
    >
      {segments.map((s, i) => {
        // Guard against a missing/zero/NaN range so a chapter never collapses.
        const rawDur = s.endTime - s.startTime;
        const dur = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 0;
        const renderDur = dur > 0 ? dur : MIN_RENDER_DURATION;
        const widthPct = duration > 0 ? (renderDur / duration) * 100 : 0;
        const active = i === activeIndex;
        const gradient = NARRATIVE_COLORS[s.role];
        const textTone = NARRATIVE_TEXT[s.role];
        const tag = NARRATIVE_LABEL[s.role];
        const isWide = widthPct > 14;
        return (
          <button
            key={`${s.startTime}-${i}`}
            type="button"
            onClick={() => onSeek(s.startTime + 0.01)}
            title={`${tag} · ${s.label} · ${dur.toFixed(1)}s`}
            // flex-grow proportional to duration (flex-basis 0) so chapters
            // always fill the band in proportion — never pack-left as narrow
            // pills when segment widths don't sum to ~100%. The px floor keeps
            // short chapters legible.
            style={{
              flexGrow: Math.max(0.01, widthPct),
              flexBasis: 0,
              minWidth: `${MIN_PILL_PX}px`,
            }}
            className={cn(
              "group relative flex h-full min-w-0 items-stretch overflow-hidden rounded-[10px] border border-white/[0.06] bg-gradient-to-br text-left transition-all duration-200",
              gradient,
              "hover:border-white/35 hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.7)]",
              active &&
                "border-white/60 ring-1 ring-white/40 shadow-[0_8px_28px_-10px_rgba(255,255,255,0.35)]"
            )}
          >
            {/* Chapter number tab */}
            <span
              className={cn(
                "flex shrink-0 items-center justify-center border-r border-white/10 bg-black/35 px-2 font-mono text-[10px] font-semibold tabular-nums",
                textTone,
                isWide ? "min-w-[28px]" : "min-w-[20px] px-1.5"
              )}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="relative flex min-w-0 flex-1 flex-col justify-center px-2 py-1">
              <span
                className={cn(
                  "truncate text-[10px] font-semibold uppercase tracking-[0.16em] leading-none",
                  textTone
                )}
              >
                {tag}
              </span>
              {isWide && (
                <span className="mt-1 truncate text-[11.5px] font-medium leading-tight text-white/85">
                  {s.label || tag}
                </span>
              )}
              <span className="mt-auto pt-0.5 font-mono text-[9px] tabular-nums text-white/55">
                {dur.toFixed(1)}s
              </span>
            </span>
            {/* Active glow indicator */}
            {active && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-gradient-to-r from-transparent via-white/80 to-transparent"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
