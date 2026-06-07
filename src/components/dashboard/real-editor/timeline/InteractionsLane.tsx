"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import type { Interaction } from "@/lib/recording/types";
import { cn } from "@/lib/cn";
import { fmt } from "./utils";

/**
 * Read-only cursor / click / focus marker lane. Renders the captured
 * interaction stream as thin, non-draggable pips so the user can see where
 * real clicks happened relative to the AI's edits. Clicking a pip seeks the
 * playhead there (read-only — it never mutates a moment).
 *
 * Falls back gracefully:
 *   • loading        → subtle spinner
 *   • no sidecar but clicks were counted → an aggregate "N clicks" note
 *   • external recording / nothing       → a labeled empty lane
 *
 * `mousemove` is intentionally skipped — a long recording carries thousands of
 * them and would mount thousands of DOM nodes. Only discrete events render.
 */
type Marker = {
  id: string;
  t: number;
  kind: "click" | "dblclick" | "rightclick" | "hover";
};

const KIND_LABEL: Record<Marker["kind"], string> = {
  click: "Click",
  dblclick: "Double-click",
  rightclick: "Right-click",
  hover: "Hover",
};

export function InteractionsLane({
  interactions,
  loading,
  total,
  totalClicks,
  onSeek,
}: {
  interactions: Interaction[] | null;
  loading: boolean;
  total: number;
  totalClicks?: number;
  onSeek?: (t: number) => void;
}) {
  const markers = React.useMemo<Marker[]>(() => {
    if (!interactions) return [];
    const out: Marker[] = [];
    for (const ev of interactions) {
      if (
        ev.type === "click" ||
        ev.type === "dblclick" ||
        ev.type === "rightclick" ||
        ev.type === "hover"
      ) {
        out.push({ id: ev.id, t: ev.t, kind: ev.type });
      }
    }
    return out;
  }, [interactions]);

  if (loading) {
    return (
      <div className="absolute inset-0 flex items-center gap-2 px-3 text-[11px] text-fog/70">
        <Loader2 size={12} className="animate-spin text-emerald-300/80" />
        Loading cursor data…
      </div>
    );
  }

  if (!interactions) {
    return (
      <div className="absolute inset-0 flex items-center px-3 text-[11px] text-fog/55">
        {totalClicks && totalClicks > 0
          ? `${totalClicks} click${totalClicks === 1 ? "" : "s"} detected — positions aren't available for this recording`
          : "No cursor data for this recording"}
      </div>
    );
  }

  if (markers.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center px-3 text-[11px] text-fog/50">
        No clicks captured in this recording
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-10">
      {markers.map((mk) => {
        const left = total > 0 ? Math.max(0, Math.min(100, (mk.t / total) * 100)) : 0;
        const isHover = mk.kind === "hover";
        if (isHover) {
          // Hovers are faint, non-interactive context.
          return (
            <span
              key={mk.id}
              aria-hidden
              className="pointer-events-none absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/25"
              style={{ left: `${left}%` }}
            />
          );
        }
        return (
          <button
            key={mk.id}
            type="button"
            title={`${KIND_LABEL[mk.kind]} · ${fmt(mk.t)}`}
            aria-label={`${KIND_LABEL[mk.kind]} at ${fmt(mk.t)}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSeek?.(mk.t);
            }}
            className="absolute inset-y-1.5 w-px -translate-x-1/2 cursor-pointer"
            style={{ left: `${left}%` }}
          >
            <span
              aria-hidden
              className={cn(
                "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-150",
                mk.kind === "rightclick" ? "bg-amber-300/70" : "bg-emerald-400/70"
              )}
            />
            <span
              aria-hidden
              className={cn(
                "absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-1 ring-ink",
                mk.kind === "rightclick" ? "bg-amber-300" : "bg-emerald-400"
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
