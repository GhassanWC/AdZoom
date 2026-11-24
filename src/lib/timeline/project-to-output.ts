/**
 * Projection between the timeline UI's two views.
 *
 * On a sequence project the ruler is SEQUENCE time, but source-anchored edits
 * are stored in asset time. These helpers map a moment to where it shows on
 * the ruler (first span; a moment split by a cut has several) and a ruler
 * position back to the source time of the footage under it, so dragging a
 * caption on a sequence timeline still writes source seconds.
 */

import type { DetectedMoment } from "@/lib/firebase/schema";
import { anchorOf, evaluateTimeline, layoutOf, outputSpansForSource, type TimelineRevision } from "./evaluate";
import { SOURCE_ASSET_ID } from "./sequence";
import { fromTicks } from "./ticks";

export interface OutputSpan {
  start: number;
  end: number;
  /** True when the moment is partly cut away / split across clips (shown with a dashed edge). */
  partial: boolean;
}

/** Where a moment shows on the sequence ruler, or null when its footage is not in the sequence. */
export function momentOutputSpan(rev: TimelineRevision, m: DetectedMoment): OutputSpan | null {
  const a = anchorOf(m);
  if (a.kind === "sequence") return { start: m.startTime, end: m.endTime, partial: false };
  if (a.kind === "item") {
    const l = layoutOf(rev).items.find((x) => x.item.id === a.itemId);
    if (!l) return null;
    const cut = fromTicks(l.cut);
    return { start: cut + m.startTime, end: cut + m.endTime, partial: false };
  }
  const assetId = a.assetId ?? SOURCE_ASSET_ID;
  const spans = outputSpansForSource(rev, assetId, m.startTime, m.endTime);
  if (!spans.length) return null;
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end));
  const covered = spans.reduce((n, s) => n + (s.end - s.start), 0);
  return { start, end, partial: covered < end - start - 1e-6 || spans.length > 1 };
}

/** Project every moment for display: start/end replaced by the output span (moments with no span are dropped). */
export function projectMomentsToOutput(rev: TimelineRevision, moments: readonly DetectedMoment[]): { moments: DetectedMoment[]; spans: Map<string, OutputSpan> } {
  const spans = new Map<string, OutputSpan>();
  const out: DetectedMoment[] = [];
  for (const m of moments) {
    const span = momentOutputSpan(rev, m);
    if (!span) continue;
    spans.set(m.id, span);
    out.push({ ...m, startTime: span.start, endTime: span.end });
  }
  return { moments: out, spans };
}

/** The source time (of the dominant layer's asset) under a sequence time. */
export function sourceUnderOutput(rev: TimelineRevision, t: number): { assetId: string; sourceTime: number } | null {
  const ev = evaluateTimeline(rev, t);
  return ev.dominant ? { assetId: ev.dominant.assetId, sourceTime: ev.dominant.sourceTime } : null;
}

/**
 * Convert a dragged display span back to what the moment stores. Source-anchored:
 * the source times under the new start/end (null when the start lands on
 * another asset — the drag is refused). Item-anchored: relative to the item's cut.
 */
export function outputSpanToMomentTimes(rev: TimelineRevision, m: DetectedMoment, start: number, end: number): { startTime: number; endTime: number } | null {
  const a = anchorOf(m);
  if (a.kind === "sequence") return { startTime: start, endTime: end };
  if (a.kind === "item") {
    const l = layoutOf(rev).items.find((x) => x.item.id === a.itemId);
    if (!l) return null;
    const cut = fromTicks(l.cut);
    const r4i = (v: number) => Math.round(v * 1e4) / 1e4;
    return { startTime: r4i(Math.max(0, start - cut)), endTime: r4i(Math.max(0.05, end - cut)) };
  }
  const assetId = a.assetId ?? SOURCE_ASSET_ID;
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const s = sourceUnderOutput(rev, start);
  // The end is exclusive: sample just inside it (an exact boundary belongs to the next item).
  const e = sourceUnderOutput(rev, Math.max(start, end - 1e-6));
  if (!s || !e || s.assetId !== assetId || e.assetId !== assetId || e.sourceTime <= s.sourceTime) return null;
  return { startTime: r4(s.sourceTime), endTime: r4(e.sourceTime) };
}
