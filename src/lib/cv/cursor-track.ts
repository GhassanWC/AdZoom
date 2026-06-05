/**
 * Visual cursor tracking — estimates where the cursor is each frame from the
 * higher-resolution detect frame (DETECT_W×DETECT_H), without any sprite/ML
 * model. The cursor is the smallest, most localized, temporally-continuous
 * patch of inter-frame change; large diffuse change (scrolling, page loads,
 * video playback) is explicitly NOT the cursor.
 *
 * Honestly bounded: at this resolution we cannot read the cursor glyph, so the
 * estimate is a localized-motion centroid with a confidence. When no small
 * localized blob exists we fall back to the motion hotspot (low confidence).
 *
 * Stateful + incremental: `createCursorTracker().step(frame, fallback)` is
 * called once per extracted frame so the pipeline never retains all frames.
 */

import {
  DETECT_W,
  DETECT_H,
  DETECT_GRID_COLS,
  DETECT_GRID_ROWS,
  type GrayFrame,
} from "./types";

export interface CursorEstimate {
  /** Normalized 0..1 within the frame. */
  x: number;
  y: number;
  /** 0..1 — how likely this is a real cursor (low → motion-hotspot fallback). */
  confidence: number;
}

/** A connected patch of inter-frame change this frame (normalized coords). */
export interface ChangeCluster {
  cx: number;
  cy: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Number of grid cells in the cluster. */
  size: number;
  /** Sum of normalized cell deltas in the cluster. */
  energy: number;
}

export interface CursorStep {
  cursor: CursorEstimate;
  clusters: ChangeCluster[];
}

const COLS = DETECT_GRID_COLS;
const ROWS = DETECT_GRID_ROWS;
const CELLS = COLS * ROWS;
const CELL_PX_W = DETECT_W / COLS;
const CELL_PX_H = DETECT_H / ROWS;

/** Mean normalized cell delta (0..1) above which a cell is "active". */
const CELL_ACTIVE = 0.05;
/** A cursor blob is small — clusters bigger than this are large motion, not a cursor. */
const MAX_CURSOR_CELLS = 6;
/** Normalized distance within which a blob is "near" the previous cursor. */
const CONTINUITY_RADIUS = 0.22;
/** Energy that saturates the confidence's magnitude term. */
const ENERGY_SAT = 0.15;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Per-cell mean normalized abs-delta between two detect frames. */
function cellDeltas(prev: GrayFrame, cur: GrayFrame): Float32Array {
  const out = new Float32Array(CELLS);
  for (let gy = 0; gy < ROWS; gy++) {
    const y0 = (gy * CELL_PX_H) | 0;
    const y1 = ((gy + 1) * CELL_PX_H) | 0;
    for (let gx = 0; gx < COLS; gx++) {
      const x0 = (gx * CELL_PX_W) | 0;
      const x1 = ((gx + 1) * CELL_PX_W) | 0;
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * DETECT_W;
        for (let x = x0; x < x1; x++) {
          const i = row + x;
          sum += Math.abs(cur[i] - prev[i]);
          count++;
        }
      }
      out[gy * COLS + gx] = count > 0 ? sum / count / 255 : 0;
    }
  }
  return out;
}

function neighbors4(cell: number): number[] {
  const col = cell % COLS;
  const row = (cell / COLS) | 0;
  const out: number[] = [];
  if (col > 0) out.push(cell - 1);
  if (col < COLS - 1) out.push(cell + 1);
  if (row > 0) out.push(cell - COLS);
  if (row < ROWS - 1) out.push(cell + COLS);
  return out;
}

/** Connected-components over active cells → normalized clusters. */
function floodClusters(deltas: Float32Array): ChangeCluster[] {
  const visited = new Uint8Array(CELLS);
  const clusters: ChangeCluster[] = [];
  for (let start = 0; start < CELLS; start++) {
    if (visited[start] || deltas[start] < CELL_ACTIVE) continue;
    const stack = [start];
    let size = 0;
    let energy = 0;
    let gx0 = COLS;
    let gy0 = ROWS;
    let gx1 = -1;
    let gy1 = -1;
    let wcx = 0;
    let wcy = 0;
    while (stack.length > 0) {
      const c = stack.pop()!;
      if (visited[c]) continue;
      visited[c] = 1;
      if (deltas[c] < CELL_ACTIVE) continue;
      const col = c % COLS;
      const row = (c / COLS) | 0;
      size++;
      energy += deltas[c];
      wcx += (col + 0.5) * deltas[c];
      wcy += (row + 0.5) * deltas[c];
      if (col < gx0) gx0 = col;
      if (row < gy0) gy0 = row;
      if (col > gx1) gx1 = col;
      if (row > gy1) gy1 = row;
      for (const nb of neighbors4(c)) if (!visited[nb]) stack.push(nb);
    }
    if (size === 0 || energy <= 0) continue;
    clusters.push({
      cx: clamp01(wcx / energy / COLS),
      cy: clamp01(wcy / energy / ROWS),
      x: gx0 / COLS,
      y: gy0 / ROWS,
      w: (gx1 - gx0 + 1) / COLS,
      h: (gy1 - gy0 + 1) / ROWS,
      size,
      energy,
    });
  }
  return clusters;
}

export function createCursorTracker() {
  let prev: GrayFrame | null = null;
  let lastX = 0.5;
  let lastY = 0.5;
  let lastConf = 0;

  return {
    /**
     * @param frame    the DETECT_W×DETECT_H grayscale detect frame
     * @param fallback the motion hotspot for this frame (or null if static)
     */
    step(frame: GrayFrame, fallback: { x: number; y: number } | null): CursorStep {
      if (!prev) {
        prev = frame;
        return { cursor: { x: lastX, y: lastY, confidence: 0 }, clusters: [] };
      }
      const deltas = cellDeltas(prev, frame);
      prev = frame;
      const clusters = floodClusters(deltas);

      // Pick the cursor: a small, energetic, continuous blob.
      let best: ChangeCluster | null = null;
      let bestScore = -Infinity;
      let bestContinuity = 0;
      let bestSmallness = 0;
      for (const cl of clusters) {
        if (cl.size > MAX_CURSOR_CELLS) continue; // large motion, not a cursor
        const dist = Math.hypot(cl.cx - lastX, cl.cy - lastY);
        const continuity =
          lastConf > 0.1 && dist < CONTINUITY_RADIUS
            ? 1 - dist / CONTINUITY_RADIUS
            : 0;
        const smallness = 1 - (cl.size - 1) / MAX_CURSOR_CELLS; // 1 cell → 1
        const score = cl.energy * (0.5 + 0.3 * smallness + 0.4 * continuity);
        if (score > bestScore) {
          bestScore = score;
          best = cl;
          bestContinuity = continuity;
          bestSmallness = smallness;
        }
      }

      if (best) {
        const conf =
          clamp01(0.35 + 0.35 * bestSmallness + 0.3 * bestContinuity) *
          Math.min(1, best.energy / ENERGY_SAT);
        lastX = best.cx;
        lastY = best.cy;
        lastConf = conf;
        return { cursor: { x: best.cx, y: best.cy, confidence: conf }, clusters };
      }

      // No localized blob → fall back to the motion hotspot, low confidence.
      if (fallback) {
        lastX = fallback.x;
        lastY = fallback.y;
        lastConf = 0.15;
        return { cursor: { x: fallback.x, y: fallback.y, confidence: 0.15 }, clusters };
      }

      // Nothing moved — hold the last position with decaying confidence.
      lastConf *= 0.6;
      return { cursor: { x: lastX, y: lastY, confidence: lastConf }, clusters };
    },
  };
}
