"use client";

import { fmtPrecise } from "./utils";

/**
 * Cinematic playhead — a chunkier triangle head, a glowing time chip just
 * below the ruler, and a sharp 1-px line that drops the full track height.
 * The line carries a soft violet bloom so it reads as "you are here" against
 * the rest of the cinematic timeline without screaming.
 */
export function Playhead({
  currentTime,
  total,
  rulerHeight,
}: {
  currentTime: number;
  total: number;
  rulerHeight: number;
}) {
  if (total <= 0) return null;
  const left = (currentTime / total) * 100;
  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-30"
      style={{ left: `${left}%` }}
      aria-hidden
    >
      {/* Diamond head — sits on the ruler */}
      <span
        className="absolute -translate-x-1/2 rotate-45 rounded-[2px] bg-white shadow-[0_0_14px_rgba(255,255,255,0.95)]"
        style={{ top: 6, width: 12, height: 12 }}
      />
      {/* Time chip — just under the ruler */}
      <span
        className="absolute -translate-x-1/2 whitespace-nowrap rounded-md border border-white/20 bg-ink/95 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-white shadow-cinematic backdrop-blur-md"
        style={{ top: rulerHeight + 4 }}
      >
        {fmtPrecise(currentTime)}
      </span>
      {/* Full-height line with violet bloom */}
      <span className="absolute inset-y-0 left-0 w-px -translate-x-1/2 bg-white/90 shadow-[0_0_10px_rgba(196,181,253,0.65)]" />
    </div>
  );
}
