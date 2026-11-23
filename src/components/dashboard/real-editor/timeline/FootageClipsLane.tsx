"use client";

/**
 * The Clips row — the footage that actually plays, one pill per kept span.
 *
 * A clip is DERIVED from the cuts (lib/edit-commands/clips.ts): the source is
 * one continuous upload, and every removed range is an ordinary `cut` edit. So
 * this row never stores anything — it draws what the cuts leave behind, which
 * is exactly what the preview plays and every exporter renders.
 *
 * Selecting a clip is what gives "trim the first two seconds" / "delete this
 * clip" / "the shot before this one" a subject. Trimming itself happens through
 * the Cuts lane (drag a cut's edge) or the assistant, which edit the same cut
 * moments — so there is no second editing model to keep in sync.
 */

import * as React from "react";
import { Film } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Clip } from "@/lib/edit-commands/clips";
import { MIN_PILL_PX } from "./constants";
import { fmt } from "./utils";

export function FootageClipsLane({
  clips,
  total,
  selectedClipId,
  onSelect,
}: {
  clips: Clip[];
  /** Source duration — pills are positioned in source time like every lane. */
  total: number;
  selectedClipId: string | null;
  onSelect: (clip: Clip) => void;
}) {
  if (clips.length === 0 || total <= 0) return null;
  return (
    <div className="absolute inset-0 z-10" role="listbox" aria-label="Clips">
      {clips.map((clip) => {
        const selected = clip.id === selectedClipId;
        const len = clip.outputEnd - clip.outputStart;
        return (
          <button
            key={clip.id}
            type="button"
            role="option"
            aria-selected={selected}
            data-clip-id={clip.id}
            data-testid="footage-clip"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(clip);
            }}
            title={`Clip ${clip.index} · ${fmt(clip.sourceStart)}–${fmt(clip.sourceEnd)} in the recording · plays for ${len.toFixed(1)}s`}
            aria-label={`Clip ${clip.index}, ${len.toFixed(1)} seconds, from ${fmt(clip.sourceStart)}`}
            className={cn(
              "absolute top-1 bottom-1 flex items-center gap-1 overflow-hidden rounded-md border px-1.5 text-left text-[10.5px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70",
              selected
                ? "border-violet-300/80 bg-violet-500/30 text-white"
                : "border-white/10 bg-white/[0.05] text-fog hover:border-white/25 hover:text-white"
            )}
            style={{
              left: `${(clip.sourceStart / total) * 100}%`,
              width: `${((clip.sourceEnd - clip.sourceStart) / total) * 100}%`,
              minWidth: `${MIN_PILL_PX}px`,
            }}
          >
            <Film size={10} aria-hidden className="shrink-0 opacity-70" />
            <span className="truncate font-medium">Clip {clip.index}</span>
            <span className="truncate font-mono tabular-nums opacity-70">{len.toFixed(1)}s</span>
          </button>
        );
      })}
    </div>
  );
}
