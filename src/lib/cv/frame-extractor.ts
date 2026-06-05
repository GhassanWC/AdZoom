/**
 * Frame extraction — pulls grayscale pixel buffers out of an `<video>` element
 * by seeking, not by realtime playback.
 *
 * Why seeking: `requestVideoFrameCallback` only fires during realtime playback,
 * so extracting a 3-min video that way would take 3 minutes of wall-clock.
 * Seeking is deterministic and works while the element is paused.
 *
 * Caveats handled here:
 *  - Browsers seek near keyframes, so the *actual* `video.currentTime` after a
 *    seek can differ from the requested time — we report the actual time.
 *  - Some browsers fire `seeked` before the frame is painted, so we settle with
 *    a double `requestAnimationFrame` before reading pixels.
 *  - `getImageData` throws `SecurityError` on a cross-origin video without CORS
 *    headers — surfaced as `CvTaintedError`.
 */

import {
  FRAME_W,
  FRAME_H,
  DETECT_W,
  DETECT_H,
  SAMPLE_FPS,
  SAMPLE_FPS_LONG,
  LONG_VIDEO_SECONDS,
  CvAbortError,
  CvTaintedError,
  type GrayFrame,
} from "./types";

export interface ExtractedFrame {
  /** Actual video.currentTime after the seek settled (seconds). */
  t: number;
  /** Grayscale buffer, FRAME_W × FRAME_H, one byte per pixel (legacy consumers). */
  frame: GrayFrame;
  /** Higher-res grayscale buffer, DETECT_W × DETECT_H, for cursor/UI tracking. */
  detectFrame: GrayFrame;
}

/** Pick the sampling rate — calmer rate for long videos to bound wall-clock. */
export function sampleFpsFor(duration: number): number {
  return duration > LONG_VIDEO_SECONDS ? SAMPLE_FPS_LONG : SAMPLE_FPS;
}

function rafSettle(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function seekTo(video: HTMLVideoElement, t: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CvAbortError());
      return;
    }
    let settled = false;
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };
    const onSeeked = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Video seek failed"));
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CvAbortError());
    };
    // Safety: if `seeked` never fires (rare codec edge cases), don't hang forever.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, 4000);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort);
    try {
      video.currentTime = t;
    } catch (err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error("Failed to set currentTime"));
    }
  });
}

/**
 * Async generator yielding one grayscale `ExtractedFrame` per sample point.
 * Restores the video element's `currentTime`, `paused`, and `muted` state when
 * the loop finishes, throws, or is abandoned (the `finally` runs on early return).
 */
export async function* extractFrames(
  video: HTMLVideoElement,
  duration: number,
  signal?: AbortSignal
): AsyncGenerator<ExtractedFrame, void, void> {
  if (duration <= 0 || !Number.isFinite(duration)) return;

  const fps = sampleFpsFor(duration);
  const step = 1 / fps;

  const canvas = document.createElement("canvas");
  canvas.width = DETECT_W;
  canvas.height = DETECT_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");

  // Preserve and neutralize playback state.
  const prevTime = video.currentTime;
  const prevPaused = video.paused;
  const prevMuted = video.muted;
  video.muted = true;
  if (!prevPaused) video.pause();

  try {
    for (let t = 0; t < duration; t += step) {
      if (signal?.aborted) throw new CvAbortError();

      await seekTo(video, Math.min(t, Math.max(0, duration - 0.05)), signal);
      await rafSettle();

      ctx.drawImage(video, 0, 0, DETECT_W, DETECT_H);

      let pixels: ImageData;
      try {
        pixels = ctx.getImageData(0, 0, DETECT_W, DETECT_H);
      } catch {
        // SecurityError → tainted canvas (cross-origin video, no CORS headers).
        throw new CvTaintedError();
      }

      const detectFrame = toGrayscale(pixels.data, DETECT_W, DETECT_H);
      const frame = downsample2x(detectFrame);
      yield { t: video.currentTime, frame, detectFrame };
    }
  } finally {
    // Best-effort restore — never throw out of cleanup.
    try {
      video.currentTime = prevTime;
      video.muted = prevMuted;
      if (!prevPaused) void video.play().catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

/** RGBA ImageData → single-channel luma buffer (Rec. 601 weights). */
function toGrayscale(rgba: Uint8ClampedArray, w: number, h: number): GrayFrame {
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;
  }
  return out;
}

/**
 * Box-downsample a DETECT_W×DETECT_H gray buffer to FRAME_W×FRAME_H by
 * averaging each 2×2 source block. Requires DETECT = 2× FRAME on both axes.
 */
function downsample2x(src: GrayFrame): GrayFrame {
  const out = new Uint8ClampedArray(FRAME_W * FRAME_H);
  for (let y = 0; y < FRAME_H; y++) {
    const sy = y * 2;
    for (let x = 0; x < FRAME_W; x++) {
      const sx = x * 2;
      const i = sy * DETECT_W + sx;
      out[y * FRAME_W + x] =
        (src[i] + src[i + 1] + src[i + DETECT_W] + src[i + DETECT_W + 1]) >> 2;
    }
  }
  return out;
}
