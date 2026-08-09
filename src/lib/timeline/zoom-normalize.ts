/**
 * Zoom hygiene for GENERATED timelines.
 *
 * The camera resolver already renders any input smoothly — it links neighbours,
 * refuses to flash on slivers and caps how far it pushes. This module fixes the
 * problem one layer up: a timeline that ASKS for two zooms on the same button
 * 200ms apart, or a zoom held for forty seconds, is a bad edit even when it
 * renders beautifully. The user sees it on the timeline, drags it, reasons about
 * it — so the data should be clean, not just the pixels.
 *
 * Three passes, in order:
 *
 *   1. MERGE   — consecutive zooms on the same target collapse into one. This is
 *                the "six clicks on one sidebar → six pushes" case.
 *   2. CLAMP   — every zoom lands inside the preset's duration window: long
 *                enough to read, short enough to keep breathing.
 *   3. TRIM    — leftover overlaps are cut at the boundary so exactly one zoom
 *                owns any instant. Without this, two overlapping same-priority
 *                zooms make the camera hand back and forth (A → B → A) inside a
 *                single beat.
 *
 * User-authored edits are never reshaped — someone dragged those on purpose.
 */

import type { DetectedMoment } from "@/lib/firebase/schema";
import {
  clampZoomWindow,
  zoomPreset,
  type ZoomPresetId,
} from "@/lib/timeline/zoom-presets";

/**
 * The edits this module reshapes. Crop is a framing decision with its own
 * duration semantics, click-highlight is a beat pinned to a click instant, and
 * cut/speed are timing — none of them are "a zoom" in the sense that matters
 * here, so none of them get re-timed.
 */
export function isZoomEdit(m: DetectedMoment): boolean {
  return m.effectType === "zoom" || m.effectType === "cursor-focus";
}

/** Two zooms closer than this, on the same target, are one zoom asked for twice. */
const MERGE_GAP_S = 0.35;
/** How close two focal centres must be to count as "the same target". */
const MERGE_FOCUS_DIST = 0.08;
/** A trimmed zoom shorter than this fraction of the preset floor is merged instead. */
const TRIM_SURVIVAL_RATIO = 0.6;

export interface ZoomNormalizeOptions {
  /** Project zoom style — sets the duration window. Absent ⇒ "standard". */
  preset?: ZoomPresetId;
  /** Source (or clip) duration in seconds — windows never extend past it. */
  duration: number;
  /**
   * Edits to pass through untouched. Defaults to anything a human authored:
   * `source === "user"` or `provenance === "user"`.
   */
  keepAsAuthored?: (m: DetectedMoment) => boolean;
}

export interface ZoomNormalizeResult {
  moments: DetectedMoment[];
  /** Zooms collapsed into a neighbour on the same target. */
  merged: number;
  /** Zooms whose window was pulled into the preset's duration range. */
  clamped: number;
  /** Zooms shortened so they stop where the next one starts. */
  trimmed: number;
}

function focusCentre(m: DetectedMoment): { x: number; y: number } {
  return {
    x: m.focusRegion.x + m.focusRegion.width / 2,
    y: m.focusRegion.y + m.focusRegion.height / 2,
  };
}

function sameTarget(a: DetectedMoment, b: DetectedMoment): boolean {
  const ca = focusCentre(a);
  const cb = focusCentre(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y) < MERGE_FOCUS_DIST;
}

function authoredByDefault(m: DetectedMoment): boolean {
  return m.source === "user" || m.provenance === "user";
}

/**
 * Clean up the zoom track of a generated timeline. Pure: returns a new list,
 * leaves every non-zoom edit (and every user edit) exactly as it was, and keeps
 * the overall ordering by start time.
 */
export function normalizeZoomTimeline(
  moments: DetectedMoment[],
  options: ZoomNormalizeOptions
): ZoomNormalizeResult {
  const profile = zoomPreset(options.preset);
  const authored = options.keepAsAuthored ?? authoredByDefault;
  const limit =
    Number.isFinite(options.duration) && options.duration > 0
      ? options.duration
      : Infinity;

  const untouched: DetectedMoment[] = [];
  const target: DetectedMoment[] = [];
  for (const m of moments) {
    if (isZoomEdit(m) && !authored(m)) target.push(m);
    else untouched.push(m);
  }
  if (target.length === 0) {
    return { moments, merged: 0, clamped: 0, trimmed: 0 };
  }

  const sorted = [...target].sort((a, b) => a.startTime - b.startTime);

  // ── 1. Merge same-target neighbours ──────────────────────────────────────
  let merged = 0;
  const collapsed: DetectedMoment[] = [];
  for (const m of sorted) {
    const prev = collapsed[collapsed.length - 1];
    const touches = prev && m.startTime - prev.endTime <= MERGE_GAP_S;
    if (prev && touches && sameTarget(prev, m)) {
      // The stronger of the two wins: collapsing two pushes into one should not
      // quietly soften the emphasis the timeline asked for. Absent fields stay
      // absent — Firestore rejects a literal `undefined` anywhere in the doc.
      const next: DetectedMoment = {
        ...prev,
        endTime: Math.max(prev.endTime, m.endTime),
      };
      if (prev.intensity !== undefined || m.intensity !== undefined) {
        next.intensity = Math.max(prev.intensity ?? 0, m.intensity ?? 0);
      }
      if (prev.attentionScore !== undefined || m.attentionScore !== undefined) {
        next.attentionScore = Math.max(prev.attentionScore ?? 0, m.attentionScore ?? 0);
      }
      collapsed[collapsed.length - 1] = next;
      merged++;
      continue;
    }
    collapsed.push(m);
  }

  // ── 2. Clamp each window into the preset's duration range ────────────────
  let clamped = 0;
  const sized = collapsed.map((m) => {
    const w = clampZoomWindow(m.startTime, m.endTime, profile, limit);
    if (
      Math.abs(w.startTime - m.startTime) < 1e-6 &&
      Math.abs(w.endTime - m.endTime) < 1e-6
    ) {
      return m;
    }
    clamped++;
    return { ...m, startTime: w.startTime, endTime: w.endTime };
  });

  // ── 3. Trim leftover overlaps so one zoom owns any instant ───────────────
  let trimmed = 0;
  const out: DetectedMoment[] = [];
  for (const m of sized) {
    const prev = out[out.length - 1];
    if (prev && m.startTime < prev.endTime) {
      const shortened = m.startTime - prev.startTime;
      if (shortened < profile.minDurationS * TRIM_SURVIVAL_RATIO) {
        // Trimming would leave a stub — absorb the overlap instead.
        out[out.length - 1] = {
          ...prev,
          endTime: Math.max(prev.endTime, m.endTime),
        };
        merged++;
        continue;
      }
      out[out.length - 1] = { ...prev, endTime: m.startTime };
      trimmed++;
    }
    out.push(m);
  }

  return {
    moments: [...untouched, ...out].sort((a, b) => a.startTime - b.startTime),
    merged,
    clamped,
    trimmed,
  };
}
