"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";

// Generate a deterministic, stable waveform so SSR matches CSR
const waveform = Array.from({ length: 80 }, (_, i) =>
  35 + Math.abs(Math.sin(i * 0.45) * 0.6 + Math.cos(i * 0.18) * 0.4) * 55
);

const zoomKeyframes = [
  { at: 8, label: "Menu" },
  { at: 22, label: "Card hover" },
  { at: 38, label: "Click" },
  { at: 58, label: "Code zoom" },
  { at: 76, label: "Scroll" },
];

export function TimelineTrack() {
  const [playhead, setPlayhead] = React.useState(34);

  return (
    <div className="glass rounded-xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-5 items-center justify-center rounded-md bg-violet-500/15 text-violet-300">
            <Sparkles size={10} />
          </span>
          <span className="text-xs font-medium text-white">Timeline</span>
          <span className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-fog">
            {zoomKeyframes.length} auto-zooms
          </span>
        </div>
        <span className="font-mono text-[11px] tabular-nums text-fog">
          00:42 / 03:08
        </span>
      </div>

      {/* waveform + keyframes */}
      <div
        className="relative h-14 cursor-pointer select-none"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          setPlayhead(Math.min(98, Math.max(2, ((e.clientX - r.left) / r.width) * 100)));
        }}
      >
        {/* waveform bars */}
        <div className="absolute inset-x-0 bottom-2 top-2 flex items-end gap-[2px]">
          {waveform.map((h, i) => {
            const passed = (i / waveform.length) * 100 <= playhead;
            return (
              <span
                key={i}
                className={
                  "flex-1 rounded-sm transition-colors duration-150 " +
                  (passed ? "bg-violet-400/70" : "bg-white/10")
                }
                style={{ height: `${h}%` }}
              />
            );
          })}
        </div>

        {/* zoom keyframe pills */}
        {zoomKeyframes.map((k) => (
          <span
            key={k.at}
            title={k.label}
            className="absolute top-0 z-10 -translate-x-1/2"
            style={{ left: `${k.at}%` }}
          >
            <span className="inline-flex items-center gap-1 rounded-full border border-violet-400/40 bg-violet-500/20 px-1.5 py-0.5 text-[9px] font-medium text-violet-200 backdrop-blur-md">
              <Sparkles size={8} />
              {k.label}
            </span>
          </span>
        ))}

        {/* playhead */}
        <span
          className="absolute inset-y-0 z-20 w-0.5 bg-white shadow-[0_0_8px_rgba(255,255,255,0.6)]"
          style={{ left: `${playhead}%` }}
        >
          <span className="absolute -top-1 left-1/2 inline-block size-2 -translate-x-1/2 rotate-45 bg-white" />
        </span>
      </div>
    </div>
  );
}
