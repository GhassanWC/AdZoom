"use client";

import { cn } from "@/lib/cn";
import { fmt } from "./utils";

const BUCKETS = 24;

/**
 * 24-bucket histogram of moment distribution. Pure presentation — caller
 * passes the moments + duration, we tally and render.
 */
export function DensityBar({
  moments,
  duration,
}: {
  moments: { startTime: number }[];
  duration: number;
}) {
  const counts = new Array<number>(BUCKETS).fill(0);
  for (const m of moments) {
    const idx = Math.min(
      BUCKETS - 1,
      Math.max(0, Math.floor((m.startTime / duration) * BUCKETS))
    );
    counts[idx]++;
  }
  const max = Math.max(1, ...counts);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.14em] text-fog">
        <span>Distribution</span>
        <span className="font-mono normal-case tracking-normal">
          {fmt(0)} → {fmt(duration / 2)} → {fmt(duration)}
        </span>
      </div>
      <div
        className="flex h-6 items-end gap-[2px] rounded-lg border border-white/[0.06] bg-white/[0.015] px-1.5 py-1"
        aria-hidden
      >
        {counts.map((c, i) => {
          const h = (c / max) * 100;
          return (
            <span
              key={`bucket-${i}`}
              title={`${c} moment${c === 1 ? "" : "s"} in this 1/${BUCKETS} of the timeline`}
              className={cn(
                "flex-1 rounded-sm transition-colors duration-150",
                c === 0
                  ? "bg-white/[0.04]"
                  : "bg-gradient-to-t from-violet-500/70 to-cyan-400/70"
              )}
              style={{ height: `${Math.max(10, h)}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}
