/**
 * Visual interaction inference — turns the per-frame cursor track + change
 * clusters into (a) cursor DWELLS and (b) UI-change-grounded INFERRED CLICKS.
 *
 * The core idea (the upload-first editing signal): a click is a cursor that
 * SETTLES and is then followed shortly after by a LOCALIZED UI change near the
 * cursor (a menu opens, a button depresses, a field focuses). That changed
 * region — not the motion hotspot — is what the camera should zoom to, so we
 * carry its tight bbox into the inferred click. Page-scale changes (scene cuts)
 * are excluded; they are transitions, not clicks.
 */

import type { InferredClick } from "../firebase/schema";
import type { VisualEvent } from "../firebase/schema";
import {
  DETECT_GRID_COLS,
  DETECT_GRID_ROWS,
} from "./types";
import type { CursorEstimate, ChangeCluster } from "./cursor-track";

const CELLS = DETECT_GRID_COLS * DETECT_GRID_ROWS;

/** Cursor confidence below which a frame doesn't anchor a dwell. */
const CONF_MIN = 0.3;
/** A dwell holds the cursor within this normalized radius. */
const DWELL_RADIUS = 0.04;
/** Frames the cursor must hold to count as settled. */
const DWELL_MIN_FRAMES = 2;
/** Look this far AFTER a dwell for the UI reaction (seconds). */
const LOOKAHEAD_MIN_S = 0.1;
const LOOKAHEAD_MAX_S = 0.8;
/** The reaction must be within this normalized distance of the cursor. */
const NEAR_RADIUS = 0.25;
/** Minimum cluster energy to count as a real UI reaction. */
const MIN_CHANGE_ENERGY = 0.3;
/** Clusters larger than this fraction of the grid are page-scale, not clicks. */
const MAX_CHANGE_FRACTION = 0.35;
/** Don't treat changes within this window of a scene cut as clicks. */
const SCENE_GUARD_S = 0.5;
/** Minimum gap between two inferred clicks. */
const DEBOUNCE_S = 0.6;
/** Cap persisted inferred clicks for doc size. */
const MAX_INFERRED = 60;
/** Smallest focus region a click produces (keeps zooms usable). */
const MIN_REGION = 0.18;
const MAX_REGION = 0.6;

export interface CursorDwell {
  t: number;
  x: number;
  y: number;
}

export interface VisualInteractionResult {
  dwells: CursorDwell[];
  inferredClicks: InferredClick[];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function nearSceneChange(t: number, scenes: VisualEvent[]): boolean {
  for (const s of scenes) if (Math.abs(s.t - t) < SCENE_GUARD_S) return true;
  return false;
}

/** Tight focus region from a change cluster — centered, clamped, min/max sized. */
function regionFromCluster(cl: ChangeCluster): InferredClick["region"] {
  const w = clamp01(Math.max(MIN_REGION, Math.min(MAX_REGION, cl.w * 1.4)));
  const h = clamp01(Math.max(MIN_REGION, Math.min(MAX_REGION, cl.h * 1.4)));
  const x = clamp01(Math.min(1 - w, Math.max(0, cl.cx - w / 2)));
  const y = clamp01(Math.min(1 - h, Math.max(0, cl.cy - h / 2)));
  return { x, y, w, h };
}

/**
 * @param cursorSeq  per-frame cursor estimate (same length as `times`)
 * @param clusterSeq per-frame change clusters (same length as `times`)
 * @param times      per-frame timestamps in seconds
 * @param scenes     detected scene changes (to exclude page transitions)
 */
export function detectVisualInteractions(
  cursorSeq: CursorEstimate[],
  clusterSeq: ChangeCluster[][],
  times: number[],
  scenes: VisualEvent[]
): VisualInteractionResult {
  const n = Math.min(cursorSeq.length, clusterSeq.length, times.length);
  const dwells: CursorDwell[] = [];

  // 1. Dwell detection — cursor settles within DWELL_RADIUS for ≥ MIN frames.
  let i = 0;
  while (i < n) {
    if (cursorSeq[i].confidence < CONF_MIN) {
      i++;
      continue;
    }
    const ax = cursorSeq[i].x;
    const ay = cursorSeq[i].y;
    let j = i + 1;
    let held = 1;
    while (
      j < n &&
      Math.hypot(cursorSeq[j].x - ax, cursorSeq[j].y - ay) < DWELL_RADIUS
    ) {
      held++;
      j++;
    }
    if (held >= DWELL_MIN_FRAMES) {
      dwells.push({ t: times[j - 1], x: ax, y: ay });
      i = j;
    } else {
      i++;
    }
  }

  // 2. UI-change-grounded clicks — a localized reaction near a settled cursor.
  const inferredClicks: InferredClick[] = [];
  let lastClickT = -Infinity;
  const maxCells = MAX_CHANGE_FRACTION * CELLS;

  for (const d of dwells) {
    if (d.t - lastClickT < DEBOUNCE_S) continue;
    let best: { t: number; cl: ChangeCluster; score: number } | null = null;
    for (let k = 0; k < n; k++) {
      const t = times[k];
      if (t < d.t + LOOKAHEAD_MIN_S || t > d.t + LOOKAHEAD_MAX_S) continue;
      if (nearSceneChange(t, scenes)) continue;
      for (const cl of clusterSeq[k]) {
        if (cl.size > maxCells) continue; // page-scale change, not a click
        if (cl.energy < MIN_CHANGE_ENERGY) continue;
        const dist = Math.hypot(cl.cx - d.x, cl.cy - d.y);
        if (dist > NEAR_RADIUS) continue;
        const score = cl.energy * (1 - dist / NEAR_RADIUS);
        if (!best || score > best.score) best = { t, cl, score };
      }
    }
    if (best) {
      inferredClicks.push({
        t: Math.round(best.t * 10) / 10,
        strength: clamp01(Math.min(1, best.cl.energy / 1.2)),
        region: regionFromCluster(best.cl),
      });
      lastClickT = best.t;
      if (inferredClicks.length >= MAX_INFERRED) break;
    }
  }

  return { dwells, inferredClicks };
}
