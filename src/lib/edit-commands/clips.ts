/**
 * Clips — the kept spans of footage, as addressable things.
 *
 * Framevo's timeline is ONE source video plus edits (`DetectedMoment`s) in
 * SOURCE seconds. Removing footage is an ordinary `cut` moment; there is no
 * stored "clip" entity. A clip is therefore DERIVED: a maximal kept span
 * between active cuts (or the ends of the video). Deriving instead of storing
 * keeps the one-array contract every renderer depends on — preview, browser
 * export, the Cloud Run worker and Remotion all read `detectedMoments` and
 * nothing else, so a clip can never disagree with what is rendered.
 *
 * IDENTITY: a clip is named by its two boundaries — the id of the cut that
 * ends just before it (or "in") and the cut that starts just after it (or
 * "out"). Extending a boundary cut keeps the clip's id; only creating a NEW
 * boundary (trimming the very first/last clip) renames it, and the executor
 * reports that rename so selection follows the clip.
 *
 * Pure: no React, no Firestore. Tested in tests/edit-commands.test.ts.
 */

import type { DetectedMoment } from "@/lib/firebase/schema";
import { buildTimelineMap, isActiveCut, type TimelineMap } from "@/lib/timeline/crop-speed";

/** Boundary tolerance (seconds) when matching a cut edge to a clip edge. */
const EDGE_EPS = 1e-3;

export interface Clip {
  id: string;
  /** 1-based position in playback order. */
  index: number;
  sourceStart: number;
  sourceEnd: number;
  /** Where the clip plays in the finished video. */
  outputStart: number;
  outputEnd: number;
  /** Id of the cut ending at `sourceStart`, or "in" (start of the video). */
  leftBoundary: string;
  /** Id of the cut starting at `sourceEnd`, or "out" (end of the video). */
  rightBoundary: string;
}

export function clipId(left: string, right: string): string {
  return `clip:${left}:${right}`;
}

/**
 * Derive the clips from the edits. `moments` must already be layer-filtered
 * (`visibleMoments`) exactly as the renderer receives them, so a hidden Cuts
 * layer — which the export ignores — also yields one whole clip here.
 */
export function deriveClips(
  moments: readonly DetectedMoment[],
  sourceDuration: number,
  map: TimelineMap = buildTimelineMap(moments as DetectedMoment[], sourceDuration)
): Clip[] {
  if (!(sourceDuration > 0) || map.segments.length === 0) return [];

  // Speed sections split segments; a clip is a SOURCE-contiguous run of them.
  const spans: { sourceStart: number; sourceEnd: number; outputStart: number; outputEnd: number }[] = [];
  for (const seg of map.segments) {
    const last = spans[spans.length - 1];
    if (last && Math.abs(last.sourceEnd - seg.sourceStart) <= EDGE_EPS) {
      last.sourceEnd = seg.sourceEnd;
      last.outputEnd = seg.outputEnd;
    } else {
      spans.push({
        sourceStart: seg.sourceStart,
        sourceEnd: seg.sourceEnd,
        outputStart: seg.outputStart,
        outputEnd: seg.outputEnd,
      });
    }
  }

  const cuts = moments.filter(isActiveCut);
  const boundaryAt = (t: number, edge: "end" | "start"): string | null => {
    // Several overlapping cuts can share an edge; prefer the one that reaches
    // furthest away from the clip so extending it is the minimal change, then
    // the lowest id for determinism.
    let pick: DetectedMoment | null = null;
    for (const c of cuts) {
      const edgeT = edge === "end" ? c.endTime : c.startTime;
      if (Math.abs(edgeT - t) > EDGE_EPS) continue;
      if (
        !pick ||
        (edge === "end" ? c.startTime < pick.startTime : c.endTime > pick.endTime) ||
        ((edge === "end" ? c.startTime === pick.startTime : c.endTime === pick.endTime) && c.id < pick.id)
      ) {
        pick = c;
      }
    }
    return pick?.id ?? null;
  };

  return spans.map((s, i) => {
    const left = s.sourceStart <= EDGE_EPS ? "in" : boundaryAt(s.sourceStart, "end") ?? `t${s.sourceStart.toFixed(3)}`;
    const right =
      s.sourceEnd >= sourceDuration - EDGE_EPS ? "out" : boundaryAt(s.sourceEnd, "start") ?? `t${s.sourceEnd.toFixed(3)}`;
    return {
      id: clipId(left, right),
      index: i + 1,
      sourceStart: round(s.sourceStart),
      sourceEnd: round(s.sourceEnd),
      outputStart: round(s.outputStart),
      outputEnd: round(s.outputEnd),
      leftBoundary: left,
      rightBoundary: right,
    };
  });
}

/** The clip playing at source time `t`, or null when `t` is inside a cut. */
export function clipAtSource(clips: readonly Clip[], t: number): Clip | null {
  for (const c of clips) if (t >= c.sourceStart - EDGE_EPS && t < c.sourceEnd - EDGE_EPS) return c;
  return null;
}

/** Output (viewer) time → source time inside the given map. */
export function sourceAtOutput(map: TimelineMap, outputTime: number): number {
  for (const seg of map.segments) {
    if (outputTime <= seg.outputEnd + EDGE_EPS) {
      const into = Math.max(0, outputTime - seg.outputStart);
      return Math.min(seg.sourceEnd, seg.sourceStart + into * seg.speedMultiplier);
    }
  }
  const last = map.segments[map.segments.length - 1];
  return last ? last.sourceEnd : 0;
}

/** Source time → output (viewer) time; a time inside a cut maps to the cut's output point. */
export function outputAtSource(map: TimelineMap, sourceTime: number): number {
  for (const seg of map.segments) {
    if (sourceTime < seg.sourceStart) return seg.outputStart;
    if (sourceTime <= seg.sourceEnd) {
      return seg.outputStart + (sourceTime - seg.sourceStart) / seg.speedMultiplier;
    }
  }
  return map.outputDuration;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
