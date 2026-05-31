/**
 * Post-recording "health check" for a captured blob.
 *
 *  - `detectGreenBottomBand` samples a few frames and decides, heuristically,
 *    whether the bottom of the video is a solid horizontal green strip — the
 *    fingerprint of Chrome's tab-capture sharing-controls toolbar (and a few
 *    other footers, e.g. some Stripe Connect onboarding screens). It is
 *    deliberately conservative: better to miss a faint band than to nag the
 *    user about a clean recording.
 *
 *  - `cropBottomBand` re-encodes the blob with the detected band sliced off.
 *    It uses canvas captureStream + MediaRecorder, the same pattern as the
 *    editor's export pipeline, so the cropped take stays a self-contained
 *    video file (mp4 or webm, matching the source's MIME).
 *
 * Both functions only run on demand from `RecordingPreview` — nothing here
 * mutates the original blob, and nothing runs unless the preview asks.
 */

import { pickRecordingMime } from "./types";

export interface GreenBandReport {
  /** True when a strong green band was found at the bottom of the frame. */
  detected: boolean;
  /** Pixel height of the band, measured up from the bottom edge. */
  bandHeightPx: number;
  /**
   * Y coordinate where the band starts (top of the band, in source pixels).
   * Equal to `videoHeight - bandHeightPx` when detected; `videoHeight` otherwise.
   */
  bandStartY: number;
  /** Source video pixel dimensions — useful for the crop step. */
  videoWidth: number;
  videoHeight: number;
  /**
   * How confident the detector is — 0..1. We surface this so callers can
   * decide whether to nag aggressively or gently. The detector is heuristic;
   * this is NOT a guarantee that a band exists, just a calibrated signal.
   */
  confidence: number;
}

/**
 * Returns true if a pixel is "saturated green" — green channel clearly
 * dominates red and blue, and there's enough chroma to count as a colour
 * rather than near-grey. Tuned against Chrome's sharing-controls strip
 * (which lands around #0f9d58 / #34a853) and Stripe-green footers.
 */
function isGreenPixel(r: number, g: number, b: number): boolean {
  // Dominance: green well above red and blue.
  if (g < 80) return false;
  if (g <= r + 20) return false;
  if (g <= b + 20) return false;
  // Saturation guard: avoid near-grey pixels that happen to lean green.
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat < 0.25) return false;
  return true;
}

/**
 * Fraction of green pixels in one image row, sampled every `step` pixels
 * horizontally. `step > 1` keeps the cost low on 4K recordings.
 */
function rowGreenRatio(
  data: Uint8ClampedArray,
  y: number,
  width: number,
  step: number
): number {
  let green = 0;
  let total = 0;
  const base = y * width * 4;
  for (let x = 0; x < width; x += step) {
    const i = base + x * 4;
    if (isGreenPixel(data[i], data[i + 1], data[i + 2])) green++;
    total++;
  }
  return total === 0 ? 0 : green / total;
}

/**
 * Find the height of a contiguous green band sitting flush against the
 * bottom edge of `imgData`. Returns 0 when the bottom row isn't green or
 * the run is too short to be a real toolbar.
 */
function measureBottomBand(
  data: Uint8ClampedArray,
  width: number,
  height: number
): number {
  // Sample budget: 1 in every ~24 source pixels horizontally is enough.
  const step = Math.max(1, Math.floor(width / 80));
  // Bottom row must be solidly green or this isn't a toolbar; saves us
  // from chasing logos / icons higher up the frame.
  if (rowGreenRatio(data, height - 1, width, step) < 0.85) return 0;

  // Walk upward until a row isn't predominantly green. A toolbar can't be
  // taller than ~12% of the frame in any sane UI; cap there so a fully
  // green captured surface (someone's wallpaper) doesn't crop everything.
  const maxBand = Math.min(height - 4, Math.floor(height * 0.12));
  let bandHeight = 1;
  for (let dy = 2; dy <= maxBand; dy++) {
    const y = height - dy;
    if (rowGreenRatio(data, y, width, step) < 0.7) break;
    bandHeight = dy;
  }
  // Anything thinner than 3px is just colour noise on the edge.
  if (bandHeight < 3) return 0;
  return bandHeight;
}

async function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => {
      video.removeEventListener("seeked", handler);
      resolve();
    };
    video.addEventListener("seeked", handler);
    video.currentTime = t;
  });
}

/**
 * Load a blob into a hidden video element. The "go time" is `loadedmetadata`
 * — we don't need the full file decoded, just enough to seek + draw frames.
 */
function loadBlob(blob: Blob): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.src = url;
    const cleanup = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      // The caller is responsible for revoking the URL when it's done with
      // the element (so it stays valid for seeks/draws).
      resolve(video);
    };
    const onError = () => {
      cleanup();
      URL.revokeObjectURL(url);
      reject(new Error("Health-check: could not decode recorded blob"));
    };
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

/**
 * Heuristic — samples up to three frames (early / middle / late). Returns
 * the smallest non-zero band size found across the samples; if any sample
 * disagrees by more than 4px we drop confidence. A truly baked-in sharing
 * strip is rock-stable across the whole take, so consistency is the signal
 * we lean on for the "this is real" confidence number.
 */
export async function detectGreenBottomBand(blob: Blob): Promise<GreenBandReport> {
  const video = await loadBlob(blob);
  try {
    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    if (!w || !h) {
      return {
        detected: false,
        bandHeightPx: 0,
        bandStartY: h,
        videoWidth: w,
        videoHeight: h,
        confidence: 0,
      };
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return {
        detected: false,
        bandHeightPx: 0,
        bandStartY: h,
        videoWidth: w,
        videoHeight: h,
        confidence: 0,
      };
    }

    const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    // Three probe points: 0.5s, midpoint, 80%. Clamped against duration so
    // very short clips (< 1s) still sample two valid frames.
    const probes = dur > 0
      ? [
          Math.min(0.5, dur * 0.1),
          dur * 0.5,
          Math.min(dur - 0.1, dur * 0.8),
        ]
      : [0];

    const bands: number[] = [];
    for (const t of probes) {
      try {
        await seek(video, t);
      } catch {
        continue;
      }
      ctx.drawImage(video, 0, 0, w, h);
      // Only read the bottom 15% — cheaper than the whole frame.
      const stripeH = Math.max(16, Math.floor(h * 0.15));
      const stripe = ctx.getImageData(0, h - stripeH, w, stripeH);
      const band = measureBottomBand(stripe.data, w, stripeH);
      bands.push(band);
    }

    const nonZero = bands.filter((b) => b > 0);
    if (nonZero.length === 0) {
      return {
        detected: false,
        bandHeightPx: 0,
        bandStartY: h,
        videoWidth: w,
        videoHeight: h,
        confidence: 0,
      };
    }

    // Pick the smallest band — that's the most conservative crop and the
    // value least likely to chomp into real content.
    const bandHeightPx = Math.min(...nonZero);

    // Confidence: how many probes saw a band, scaled by how consistent
    // their measurements are. Identical bands across three probes = 1.0.
    const agreement = nonZero.length / probes.length;
    const spread =
      nonZero.length > 1
        ? Math.max(...nonZero) - Math.min(...nonZero)
        : 0;
    const tightness = spread <= 2 ? 1 : spread <= 6 ? 0.8 : 0.5;
    const confidence = Math.min(1, agreement * tightness);

    return {
      detected: confidence >= 0.5 && bandHeightPx >= 3,
      bandHeightPx,
      bandStartY: h - bandHeightPx,
      videoWidth: w,
      videoHeight: h,
      confidence,
    };
  } finally {
    URL.revokeObjectURL(video.src);
  }
}

export interface CropProgress {
  /** 0..1 — `currentTime / duration`. */
  pct: number;
}

export interface CropResult {
  /** The re-encoded, cropped video. Original input blob is untouched. */
  blob: Blob;
  /**
   * Whether the cropped output contains an audio track. `false` means either
   * the source had no audio, OR `HTMLMediaElement.captureStream()` wasn't
   * available / failed to expose the source's audio track. We can't reliably
   * distinguish "no audio in source" from "audio passthrough failed" in every
   * browser, so the UI should warn whenever this is `false` and the user
   * cared about audio (e.g., mic was enabled).
   */
  audioPreserved: boolean;
}

/**
 * Re-encode `blob` with the bottom `bandHeightPx` pixels chopped off.
 * Returns a fresh Blob, leaving the input untouched. Output dimensions are
 * `videoWidth × (videoHeight - bandHeightPx)`. Audio is passed through via
 * the source video's `captureStream()` when the browser supports it.
 *
 * NB: this is a real-time re-encode — duration matches the original because
 * we play the source at 1x. For long recordings that's slow but predictable;
 * we surface progress via the callback so the UI can keep the user informed.
 */
export async function cropBottomBand(
  blob: Blob,
  bandHeightPx: number,
  onProgress?: (p: CropProgress) => void
): Promise<CropResult> {
  if (bandHeightPx <= 0) return { blob, audioPreserved: true };
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not available in this browser.");
  }

  const video = await loadBlob(blob);
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (!srcW || !srcH || bandHeightPx >= srcH) {
    URL.revokeObjectURL(video.src);
    throw new Error("Invalid crop dimensions.");
  }

  const outW = srcW;
  const outH = srcH - bandHeightPx;

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    URL.revokeObjectURL(video.src);
    throw new Error("Could not get 2D context for crop.");
  }
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, outW, outH);

  // Best-effort audio passthrough. `captureStream` on HTMLMediaElement is
  // non-standard but ships in Chromium. If it isn't there, we drop audio
  // rather than failing the whole crop — but we DO surface that fact via
  // `audioPreserved` in the return value, so the UI can warn the user
  // instead of silently shipping a muted re-encode.
  let audioTrack: MediaStreamTrack | null = null;
  try {
    type CaptureStream = () => MediaStream;
    const captureStream = (video as unknown as { captureStream?: CaptureStream })
      .captureStream;
    if (captureStream) {
      const stream = captureStream.call(video);
      const audio = stream.getAudioTracks();
      if (audio.length) audioTrack = audio[0];
    }
  } catch {
    // captureStream blew up — leave audioTrack null and report it as dropped
  }

  const fps = 30;
  const canvasStream = canvas.captureStream(fps);
  if (audioTrack) canvasStream.addTrack(audioTrack);
  const audioPreserved = canvasStream.getAudioTracks().length > 0;

  // Match the source's container family when possible so the cropped file
  // is interchangeable with the original (.mp4 ↔ .mp4, .webm ↔ .webm).
  const sourceIsMp4 = blob.type.startsWith("video/mp4");
  const preferred = sourceIsMp4
    ? "video/mp4;codecs=avc1.42E01E,mp4a.40.2"
    : "";
  const mime =
    preferred && MediaRecorder.isTypeSupported(preferred)
      ? preferred
      : pickRecordingMime();

  const recorder = new MediaRecorder(canvasStream, {
    mimeType: mime,
    videoBitsPerSecond: 6_000_000,
    audioBitsPerSecond: 128_000,
  });

  const chunks: Blob[] = [];
  const recorded = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
    recorder.onerror = () => reject(new Error("Crop recorder failed."));
  });

  video.currentTime = 0;
  // Wait for the seek to settle so the first painted frame is real video.
  await new Promise<void>((resolve) => {
    const handler = () => {
      video.removeEventListener("seeked", handler);
      resolve();
    };
    video.addEventListener("seeked", handler);
  });

  recorder.start(500);

  let stopped = false;
  const duration =
    isFinite(video.duration) && video.duration > 0 ? video.duration : 0;

  const draw = () => {
    if (stopped) return;
    // Source rect: full width, top srcH-bandHeightPx pixels.
    // Destination: full canvas. `drawImage` with 9-arg form does the crop.
    try {
      ctx.drawImage(video, 0, 0, srcW, outH, 0, 0, outW, outH);
    } catch {
      // tainted-canvas or similar — bail out cleanly
      stopped = true;
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    if (duration > 0 && onProgress) {
      onProgress({ pct: Math.min(0.99, video.currentTime / duration) });
    }
    if (video.ended || (duration > 0 && video.currentTime >= duration - 0.05)) {
      stopped = true;
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    requestAnimationFrame(draw);
  };

  try {
    await video.play();
  } catch (err) {
    if (!(err instanceof DOMException) || err.name !== "AbortError") {
      URL.revokeObjectURL(video.src);
      throw err;
    }
  }
  requestAnimationFrame(draw);

  // Safety stop in case `ended` never fires (some browsers misbehave on
  // very short blobs). 5 second padding past the nominal duration.
  const safety = setTimeout(
    () => {
      if (!stopped) {
        stopped = true;
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
    },
    Math.max(2_000, (duration + 5) * 1000)
  );

  try {
    const out = await recorded;
    if (onProgress) onProgress({ pct: 1 });
    return { blob: out, audioPreserved };
  } finally {
    clearTimeout(safety);
    video.pause();
    URL.revokeObjectURL(video.src);
  }
}
