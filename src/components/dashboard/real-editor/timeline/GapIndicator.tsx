"use client";

import { TRACK_HEIGHTS } from "./constants";

interface QuartileRange {
  /** Left edge (0..1) of the empty range. */
  start: number;
  /** Right edge (0..1) of the empty range. */
  end: number;
}

/**
 * Calm indicator strip that replaces the old amber quartile shading. A
 * dashed top border + uppercase "QUIET" microcopy across stretches of the
 * timeline with no moments. Visual weight is intentionally low — it's
 * context, not error state.
 */
export function GapIndicator({ ranges }: { ranges: QuartileRange[] }) {
  if (ranges.length === 0) {
    return <div style={{ height: TRACK_HEIGHTS.gap }} aria-hidden />;
  }
  return (
    <div
      style={{ height: TRACK_HEIGHTS.gap }}
      className="relative"
      aria-hidden
    >
      {ranges.map((r, i) => {
        const left = r.start * 100;
        const width = (r.end - r.start) * 100;
        return (
          <div
            key={i}
            className="absolute inset-y-1.5 flex items-center justify-center border-t border-dashed border-white/15"
            style={{ left: `${left}%`, width: `${width}%` }}
          >
            <span className="text-[9px] uppercase tracking-[0.22em] text-fog/60">
              Quiet
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Compute empty-quartile ranges from the moments list. Quartiles with at
 * least one moment starting in them are considered "covered"; uncovered ones
 * are flagged.
 */
export function emptyQuartileRanges(
  moments: { startTime: number }[],
  duration: number
): QuartileRange[] {
  if (duration <= 0) return [];
  const q = duration / 4;
  const covered = [false, false, false, false];
  for (const m of moments) {
    const idx = Math.min(3, Math.max(0, Math.floor(m.startTime / q)));
    covered[idx] = true;
  }
  const ranges: QuartileRange[] = [];
  for (let i = 0; i < 4; i++) {
    if (!covered[i]) ranges.push({ start: i / 4, end: (i + 1) / 4 });
  }
  // Merge adjacent ranges so two consecutive empty quartiles read as one strip.
  const merged: QuartileRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.end - r.start) < 1e-6) {
      last.end = r.end;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}
