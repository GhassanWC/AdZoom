/**
 * Per-frame-pair differencing math.
 *
 * All operations are single-channel over FRAME_W × FRAME_H grayscale buffers.
 * The "similarity" metric here is a cheap pixel-delta proxy, NOT true SSIM —
 * we need change magnitude and scene cuts, not perceptual quality scoring.
 */

import {
  FRAME_W,
  FRAME_H,
  GRID_COLS,
  GRID_ROWS,
  GRID_CELLS,
  type GrayFrame,
  type Centroid,
} from "./types";

/** A pixel delta above this (0..255) counts as "moving". */
const MOTION_THRESHOLD = 16;
/** Below this total grid energy, the frame is treated as static (no centroid). */
const STATIC_THRESHOLD = 0.012;

/** Block grid used for the illumination-tolerant scene-change signal. */
const BLOCK_COLS = 16;
const BLOCK_ROWS = 9;

export interface FrameDiff {
  /** Mean absolute grayscale delta vs the previous frame (0..1). */
  meanDelta: number;
  /** Cheap similarity proxy = 1 - meanDelta (0..1). */
  ssim: number;
  /** Fraction of pixels exceeding MOTION_THRESHOLD (0..1). */
  motionIntensity: number;
  /** Mean per-block-mean delta — robust to global brightness shifts (0..1). */
  blockMeanDelta: number;
  /** 8×8 per-cell mean abs delta, row-major (0..1 each). */
  gridDelta: Float32Array;
  /** Motion-weighted hotspot, or null if the frame was effectively static. */
  centroid: Centroid | null;
}

/**
 * Diff two consecutive grayscale frames. `prev` and `cur` must both be
 * FRAME_W × FRAME_H. Pure — no allocations escape except the returned arrays.
 */
export function diffFrames(prev: GrayFrame, cur: GrayFrame): FrameDiff {
  const n = FRAME_W * FRAME_H;
  const gridDelta = new Float32Array(GRID_CELLS);
  const gridCount = new Float32Array(GRID_CELLS);

  const cellW = FRAME_W / GRID_COLS;
  const cellH = FRAME_H / GRID_ROWS;

  let sumDelta = 0;
  let movingPixels = 0;

  for (let y = 0; y < FRAME_H; y++) {
    const gy = Math.min(GRID_ROWS - 1, (y / cellH) | 0);
    for (let x = 0; x < FRAME_W; x++) {
      const i = y * FRAME_W + x;
      const d = Math.abs(cur[i] - prev[i]);
      sumDelta += d;
      if (d > MOTION_THRESHOLD) movingPixels++;
      const gx = Math.min(GRID_COLS - 1, (x / cellW) | 0);
      const cell = gy * GRID_COLS + gx;
      gridDelta[cell] += d;
      gridCount[cell]++;
    }
  }

  const meanDelta = sumDelta / n / 255;
  const motionIntensity = movingPixels / n;

  // Normalize grid cells to 0..1 mean-per-cell, accumulate weighted centroid.
  let gridTotal = 0;
  let cx = 0;
  let cy = 0;
  for (let cell = 0; cell < GRID_CELLS; cell++) {
    const norm = gridCount[cell] > 0 ? gridDelta[cell] / gridCount[cell] / 255 : 0;
    gridDelta[cell] = norm;
    gridTotal += norm;
    const col = cell % GRID_COLS;
    const row = (cell / GRID_COLS) | 0;
    // Cell center in normalized frame coordinates.
    cx += norm * ((col + 0.5) / GRID_COLS);
    cy += norm * ((row + 0.5) / GRID_ROWS);
  }

  const centroid: Centroid | null =
    gridTotal >= STATIC_THRESHOLD
      ? { x: cx / gridTotal, y: cy / gridTotal }
      : null;

  return {
    meanDelta,
    ssim: 1 - meanDelta,
    motionIntensity,
    blockMeanDelta: blockMeanDelta(prev, cur),
    gridDelta,
    centroid,
  };
}

/**
 * Mean absolute delta of per-block average luminance. Averaging within a block
 * before differencing suppresses pixel noise and tolerates small brightness
 * shifts, so spikes here are real layout/scene changes rather than flicker.
 */
function blockMeanDelta(prev: GrayFrame, cur: GrayFrame): number {
  const blockW = FRAME_W / BLOCK_COLS;
  const blockH = FRAME_H / BLOCK_ROWS;
  let sum = 0;

  for (let by = 0; by < BLOCK_ROWS; by++) {
    const y0 = Math.round(by * blockH);
    const y1 = Math.round((by + 1) * blockH);
    for (let bx = 0; bx < BLOCK_COLS; bx++) {
      const x0 = Math.round(bx * blockW);
      const x1 = Math.round((bx + 1) * blockW);
      let pSum = 0;
      let cSum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * FRAME_W + x;
          pSum += prev[i];
          cSum += cur[i];
          count++;
        }
      }
      if (count > 0) sum += Math.abs(cSum - pSum) / count;
    }
  }

  return sum / (BLOCK_COLS * BLOCK_ROWS) / 255;
}
