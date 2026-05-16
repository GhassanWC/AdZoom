/**
 * Per-frame visual density — a cheap edge-energy estimate of how "busy" a
 * frame is. A dense IDE full of text scores high; an empty slide scores low.
 *
 * This is a single-frame signal (no previous frame needed), so a dense but
 * static screen still reads as visually demanding even when motion is zero.
 */

import { FRAME_W, FRAME_H, type GrayFrame } from "./types";

/**
 * Sobel-lite: mean of |horizontal gradient| + |vertical gradient| over the
 * interior pixels, normalized to roughly 0..1. The /255 then a gentle gain
 * keeps typical UI screenshots in a usable mid-range.
 */
export function visualDensity(frame: GrayFrame): number {
  let sum = 0;
  let count = 0;

  for (let y = 1; y < FRAME_H - 1; y++) {
    for (let x = 1; x < FRAME_W - 1; x++) {
      const i = y * FRAME_W + x;
      const gx = Math.abs(frame[i + 1] - frame[i - 1]);
      const gy = Math.abs(frame[i + FRAME_W] - frame[i - FRAME_W]);
      sum += gx + gy;
      count++;
    }
  }

  if (count === 0) return 0;
  // Each gradient term maxes at 255; /510 maps the theoretical max to 1.
  // Real UI frames rarely exceed ~0.25, so apply a 2.5× gain and clamp.
  const raw = sum / count / 510;
  return Math.min(1, raw * 2.5);
}
