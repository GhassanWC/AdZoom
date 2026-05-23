/**
 * Lightweight UI region detection — shape + motion stats only.
 *
 * Honestly bounded: this is NOT vision. There's no CNN, no segmentation, no
 * trained model (invariant 4 of the hybrid pipeline). It clusters change-active
 * grid cells with connected-components, then classifies the resulting
 * rectangles by aspect ratio, size, and screen position. `labelGuess` is a
 * hint to the AI refinement layer — never an authoritative class.
 *
 * Confidence is clamped to 0.7 unless a click event landed inside the region,
 * in which case it can reach 0.85.
 *
 * Inputs are taken from per-frame `gridDelta` (8×8) that the CV pipeline
 * already computes — no extra video decode required.
 */

import type { Interaction } from "../recording/types";
import type { UIRegion } from "../firebase/schema";
import { GRID_COLS, GRID_ROWS } from "./types";

export interface RegionDetectInput {
  /** Per-sampled-frame grid deltas (length = frames, each = GRID_CELLS=64). */
  gridDeltas: Float32Array[];
  /** Timestamps for each frame in `gridDeltas`. */
  times: number[];
  /** Real interactions, if available, to corroborate region confidence. */
  interactions?: Interaction[];
  /** Window length to aggregate gridDeltas (seconds). */
  windowSeconds?: number;
}

const DEFAULT_WINDOW_S = 2;
const ACTIVE_CELL_THRESHOLD = 0.06; // cell mean delta needed to count as active

interface Cluster {
  cells: Set<number>;
  bbox: { gx0: number; gy0: number; gx1: number; gy1: number };
  energy: number;
  t0: number;
  t1: number;
}

function neighbors(cell: number): number[] {
  const col = cell % GRID_COLS;
  const row = Math.floor(cell / GRID_COLS);
  const out: number[] = [];
  if (col > 0) out.push(cell - 1);
  if (col < GRID_COLS - 1) out.push(cell + 1);
  if (row > 0) out.push(cell - GRID_COLS);
  if (row < GRID_ROWS - 1) out.push(cell + GRID_COLS);
  return out;
}

function classifyShape(
  x: number,
  y: number,
  w: number,
  h: number,
  hasInteriorClick: boolean
): UIRegion["labelGuess"] {
  const aspect = w / Math.max(0.001, h);
  const area = w * h;
  const cx = x + w / 2;
  const cy = y + h / 2;

  // Edge anchoring.
  const onLeftEdge = x < 0.08;
  const onRightEdge = x + w > 0.92;
  const onTopEdge = y < 0.08;

  if (area < 0.015 && aspect > 0.6 && aspect < 1.6) return "button";
  if (area < 0.04 && aspect > 2.2) return "input";
  if (area > 0.25 && cx > 0.3 && cx < 0.7 && cy > 0.2 && cy < 0.8) return "modal";
  if ((onLeftEdge || onRightEdge) && h > 0.5 && aspect < 0.5) return "sidebar";
  if (onTopEdge && w > 0.5 && aspect > 3) return "toolbar";
  if (hasInteriorClick && area < 0.08) return "button";
  if (area < 0.1 && aspect > 0.5 && aspect < 2) return "card";
  return "unknown";
}

/**
 * Detect probable UI regions over a recording. Returns one entry per
 * (cluster × window) — the same on-screen element appearing in multiple
 * windows yields multiple `UIRegion` entries, each with its own t0/t1.
 */
export function detectRegions(input: RegionDetectInput): UIRegion[] {
  const { gridDeltas, times, interactions = [], windowSeconds = DEFAULT_WINDOW_S } = input;
  if (gridDeltas.length === 0 || times.length === 0) return [];

  const out: UIRegion[] = [];
  const duration = times[times.length - 1];
  let idSeq = 0;

  for (let wStart = 0; wStart < duration; wStart += windowSeconds) {
    const wEnd = wStart + windowSeconds;
    // Accumulate cell energy over this window.
    const cellEnergy = new Float64Array(GRID_COLS * GRID_ROWS);
    let frameCount = 0;
    for (let i = 0; i < gridDeltas.length; i++) {
      const t = times[i];
      if (t < wStart || t >= wEnd) continue;
      const gd = gridDeltas[i];
      if (!gd) continue;
      for (let c = 0; c < gd.length && c < cellEnergy.length; c++) {
        cellEnergy[c] += gd[c];
      }
      frameCount++;
    }
    if (frameCount === 0) continue;
    for (let c = 0; c < cellEnergy.length; c++) cellEnergy[c] /= frameCount;

    // Connected-components flood fill over "active" cells.
    const visited = new Uint8Array(cellEnergy.length);
    const clusters: Cluster[] = [];
    for (let start = 0; start < cellEnergy.length; start++) {
      if (visited[start] || cellEnergy[start] < ACTIVE_CELL_THRESHOLD) continue;
      const stack = [start];
      const cells = new Set<number>();
      let gx0 = GRID_COLS;
      let gy0 = GRID_ROWS;
      let gx1 = -1;
      let gy1 = -1;
      let energy = 0;
      while (stack.length > 0) {
        const c = stack.pop()!;
        if (visited[c]) continue;
        visited[c] = 1;
        if (cellEnergy[c] < ACTIVE_CELL_THRESHOLD) continue;
        cells.add(c);
        energy += cellEnergy[c];
        const col = c % GRID_COLS;
        const row = Math.floor(c / GRID_COLS);
        if (col < gx0) gx0 = col;
        if (row < gy0) gy0 = row;
        if (col > gx1) gx1 = col;
        if (row > gy1) gy1 = row;
        for (const n of neighbors(c)) if (!visited[n]) stack.push(n);
      }
      if (cells.size > 0) {
        clusters.push({ cells, bbox: { gx0, gy0, gx1, gy1 }, energy, t0: wStart, t1: wEnd });
      }
    }

    for (const cl of clusters) {
      const x = cl.bbox.gx0 / GRID_COLS;
      const y = cl.bbox.gy0 / GRID_ROWS;
      const w = (cl.bbox.gx1 - cl.bbox.gx0 + 1) / GRID_COLS;
      const h = (cl.bbox.gy1 - cl.bbox.gy0 + 1) / GRID_ROWS;

      // Does any click event land inside?
      const hasInteriorClick = interactions.some(
        (ev) =>
          (ev.type === "click" || ev.type === "dblclick" || ev.type === "rightclick") &&
          ev.t >= cl.t0 &&
          ev.t <= cl.t1 &&
          ev.x >= x &&
          ev.x <= x + w &&
          ev.y >= y &&
          ev.y <= y + h
      );

      const labelGuess = classifyShape(x, y, w, h, hasInteriorClick);
      // Confidence: cell energy → 0..0.5; clicks bump up to 0.85; otherwise capped at 0.7.
      const energyTerm = Math.min(0.5, cl.energy / Math.max(1, cl.cells.size) * 1.5);
      const base = 0.3 + energyTerm;
      const confidence = hasInteriorClick ? Math.min(0.85, base + 0.2) : Math.min(0.7, base);

      out.push({
        id: `reg_${idSeq++}_${cl.t0.toFixed(1)}`,
        t0: cl.t0,
        t1: Math.min(duration, cl.t1),
        x,
        y,
        w,
        h,
        labelGuess,
        confidence,
      });
    }
  }

  return out;
}
