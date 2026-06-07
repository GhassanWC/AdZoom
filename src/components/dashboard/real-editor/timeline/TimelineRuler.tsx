"use client";

import { TRACK_HEIGHTS } from "./constants";
import { fmt } from "./utils";

/**
 * Adaptive time ruler. Picks a tick interval that lands close to ~8-12
 * major ticks at the current duration, with minor ticks in between. Major
 * ticks carry a label and a stronger line; minor ticks are subtle.
 *
 * The ruler is intentionally taller than before (36px) so the timecodes can
 * breathe and the tick rhythm reads cinematically.
 */
export function TimelineRuler({
  total,
  pxPerSec = 0,
}: {
  total: number;
  /** Measured px/sec — when > 0, drives tick density so zooming reveals finer ticks. */
  pxPerSec?: number;
}) {
  if (total <= 0) {
    return (
      <div style={{ height: TRACK_HEIGHTS.ruler }} aria-hidden />
    );
  }
  const { major, minor } = pickTickInterval(total, pxPerSec);
  const majors: number[] = [];
  for (let t = 0; t <= total + 1e-3; t += major) majors.push(t);
  if (majors[majors.length - 1] < total - 1e-3) majors.push(total);

  const minors: number[] = [];
  if (minor > 0) {
    for (let t = 0; t <= total + 1e-3; t += minor) {
      if (Math.abs(t / major - Math.round(t / major)) > 0.01) minors.push(t);
    }
  }

  return (
    <div
      style={{ height: TRACK_HEIGHTS.ruler }}
      className="relative border-b border-white/[0.08]"
      aria-hidden
    >
      {minors.map((t, i) => (
        <span
          key={`min-${i}`}
          className="absolute bottom-0 w-px bg-white/[0.06]"
          style={{ left: `${(t / total) * 100}%`, height: 6 }}
        />
      ))}
      {majors.map((t, i) => {
        const pct = (t / total) * 100;
        const isFirst = i === 0;
        const isLast = i === majors.length - 1;
        const translate = isFirst
          ? "translateX(0)"
          : isLast
            ? "translateX(-100%)"
            : "translateX(-50%)";
        return (
          <div
            key={`maj-${i}`}
            className="absolute inset-y-0"
            style={{ left: `${pct}%`, transform: translate }}
          >
            <span
              className="absolute bottom-0 left-1/2 -translate-x-1/2 bg-white/25"
              style={{ width: 1, height: 11 }}
            />
            <span
              className="absolute left-1/2 -translate-x-1/2 font-mono text-[10.5px] font-medium tabular-nums text-fog/85"
              style={{ top: 4 }}
            >
              {fmt(t)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Target on-screen spacing between major ticks (px). */
const TARGET_MAJOR_PX = 92;

/**
 * Major + minor tick intervals (seconds). When a measured `pxPerSec` is
 * available, ticks are chosen so majors land ~`TARGET_MAJOR_PX` apart — so
 * zooming a long video in reveals second-level ticks instead of staying at
 * minute granularity. Without a measurement it falls back to a duration
 * heuristic aiming for 6-10 majors across the whole timeline.
 */
function pickTickInterval(
  total: number,
  pxPerSec = 0
): { major: number; minor: number } {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let major = candidates[candidates.length - 1];
  if (pxPerSec > 0) {
    const wanted = TARGET_MAJOR_PX / pxPerSec; // seconds per major to hit target px
    major = candidates.find((c) => c >= wanted) ?? candidates[candidates.length - 1];
  } else {
    for (const c of candidates) {
      if (total / c <= 10) {
        major = c;
        break;
      }
    }
  }
  const minor =
    major <= 1 ? 0 : major <= 5 ? major / 5 : major <= 30 ? major / 5 : major / 6;
  return { major, minor };
}

/**
 * Vertical gridlines aligned with the major ruler ticks, extending down
 * through the lanes. Rendered as a non-interactive overlay so they don't
 * absorb pointer events.
 */
export function GridLines({ total }: { total?: number }) {
  const { major } = pickTickInterval(total && total > 0 ? total : 60);
  const denom = total && total > 0 ? total : 1;
  const ticks: number[] = [];
  if (total && total > 0) {
    for (let t = major; t < total; t += major) ticks.push(t / denom);
  } else {
    [0.25, 0.5, 0.75].forEach((p) => ticks.push(p));
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
      {ticks.map((p, i) => (
        <span
          key={i}
          className="absolute inset-y-0 w-px bg-white/[0.04]"
          style={{ left: `${p * 100}%` }}
        />
      ))}
    </div>
  );
}
