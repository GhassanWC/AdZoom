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
 *  - `probeVideoBottomBand` is a synchronous diagnostic against a live
 *    `<video>` element — proves whether a green strip is baked into the
 *    captured pixels rather than introduced by our rendering.
 *
 * Detection is NON-DESTRUCTIVE: the result becomes a `sourceCrop` (a bottom-only
 * `browser-bar-cleanup` rect) that every render/analysis path honors via
 * `resolveSourceRect`. Nothing here mutates the original blob.
 */

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
 * Returns true for a clearly saturated, non-grey pixel of ANY hue. The
 * secondary "strongly tinted band" signal — Chrome's sharing strip is not
 * always the same green (themes / channels shift it toward blue-grey), but it
 * stays a solid, saturated, full-width band. Deliberately stricter on
 * saturation than `isGreenPixel` because it isn't anchored to a hue, so it must
 * not fire on near-grey video content. Only consulted for browser-tab takes.
 */
function isTintedPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 60) return false; // near-black
  const sat = max === 0 ? 0 : (max - min) / max;
  return sat >= 0.35;
}

/**
 * Fraction of pixels in one image row matching `pred`, sampled every `step`
 * pixels horizontally. `step > 1` keeps the cost low on 4K recordings.
 */
function rowMatchRatio(
  data: Uint8ClampedArray,
  y: number,
  width: number,
  step: number,
  pred: (r: number, g: number, b: number) => boolean
): number {
  let hit = 0;
  let total = 0;
  const base = y * width * 4;
  for (let x = 0; x < width; x += step) {
    const i = base + x * 4;
    if (pred(data[i], data[i + 1], data[i + 2])) hit++;
    total++;
  }
  return total === 0 ? 0 : hit / total;
}

function rowGreenRatio(
  data: Uint8ClampedArray,
  y: number,
  width: number,
  step: number
): number {
  return rowMatchRatio(data, y, width, step, isGreenPixel);
}

/**
 * Find the height of the browser sharing-bar band flush against the bottom
 * edge of `imgData`. Returns 0 when no band is found or it's too thin to be a
 * real toolbar.
 *
 * Two robustness upgrades over a naive "bottom row must be green" check:
 *  1. SCAN-UP past control chrome. Chrome can render its playback scrubber /
 *     controls *below* the green strip, so the very bottom rows aren't green.
 *     We allow a small budget of non-band rows at the very bottom, find the
 *     green run above them, and crop from the run's TOP down to the bottom edge
 *     (the chrome below is also baked-in artifact and must go).
 *  2. STRONGLY-TINTED fallback (browser surface only). When the strip isn't the
 *     expected green hue, a solid saturated full-width band still qualifies.
 *     Gated on `surface === "browser"` so window/monitor/upload takes can never
 *     trip it.
 */
function measureBottomBand(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  surface?: string
): number {
  const step = Math.max(1, Math.floor(width / 80));
  const allowTinted = surface === "browser";

  // A row is "band start" if it's solidly the green hue, or (browser only) a
  // near-uniform saturated band.
  const isBandStart = (y: number): boolean =>
    rowGreenRatio(data, y, width, step) >= 0.85 ||
    (allowTinted && rowMatchRatio(data, y, width, step, isTintedPixel) >= 0.95);
  // A row "continues" the band on the looser 0.7 threshold while walking up.
  const continuesBand = (y: number): boolean =>
    rowGreenRatio(data, y, width, step) >= 0.7 ||
    (allowTinted && rowMatchRatio(data, y, width, step, isTintedPixel) >= 0.9);

  // Non-band chrome allowed at the very bottom (scrubber / controls strip).
  const chromeBudget = Math.max(2, Math.floor(height * 0.04));
  // Toolbar + chrome can't be taller than ~15% of the frame in any sane UI;
  // cap there so a mostly-green captured surface doesn't crop everything.
  const maxBand = Math.min(height - 4, Math.floor(height * 0.15));

  // 1. Find the lowest band row, skipping up to `chromeBudget` chrome rows.
  let bandBottom = -1;
  for (let dy = 1; dy <= chromeBudget + 1 && dy <= maxBand; dy++) {
    const y = height - dy;
    if (y < 0) break;
    if (isBandStart(y)) {
      bandBottom = y;
      break;
    }
  }
  if (bandBottom === -1) return 0;

  // 2. Walk upward to the top of the contiguous band.
  let bandTop = bandBottom;
  const limit = Math.max(0, height - maxBand);
  for (let y = bandBottom - 1; y >= limit; y--) {
    if (!continuesBand(y)) break;
    bandTop = y;
  }

  // Crop from the band's top down to the bottom edge (includes chrome below).
  const bandHeight = height - bandTop;
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
export async function detectGreenBottomBand(
  blob: Blob,
  opts: { surface?: "monitor" | "window" | "browser" | null } = {}
): Promise<GreenBandReport> {
  const { surface } = opts;
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
      // Only read the bottom 20% — cheaper than the whole frame, and wide
      // enough to contain a green strip plus its control chrome.
      const stripeH = Math.max(16, Math.floor(h * 0.2));
      const stripe = ctx.getImageData(0, h - stripeH, w, stripeH);
      const band = measureBottomBand(stripe.data, w, stripeH, surface ?? undefined);
      bands.push(band);
    }

    const nonZero = bands.filter((b) => b > 0);
    if (nonZero.length === 0) {
      logDetect({
        detected: false,
        bottomCropPx: 0,
        confidence: 0,
        frameWidth: w,
        frameHeight: h,
        sampleCount: probes.length,
      });
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
    const detected = confidence >= 0.5 && bandHeightPx >= 3;

    logDetect({
      detected,
      bottomCropPx: bandHeightPx,
      confidence: +confidence.toFixed(3),
      frameWidth: w,
      frameHeight: h,
      sampleCount: probes.length,
    });

    return {
      detected,
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

/** Structured detection log — shipped to prod for support diagnostics. */
function logDetect(info: {
  detected: boolean;
  bottomCropPx: number;
  confidence: number;
  frameWidth: number;
  frameHeight: number;
  sampleCount: number;
}): void {
  console.info("[tab-capture-cleanup-detect]", info);
}

/**
 * Synchronous bottom-band probe against a LIVE `<video>` element (not a
 * blob). Diagnostic-only: it answers the single question "are the bottom
 * rows of the SOURCE video green?" so we can prove a green strip is baked
 * into the captured pixels rather than added by our canvas rendering.
 *
 * Returns `null` when the frame can't be read (no metadata yet, or a
 * tainted canvas). Requires the video to be seekable to a painted frame —
 * call it after `loadeddata`/`seeked`. Reuses the same green heuristics as
 * the on-demand detector so the two never disagree.
 */
export interface BottomBandProbe {
  sourceW: number;
  sourceH: number;
  /** 0..1 — fraction of green pixels in the very bottom row of the frame. */
  bottomRowGreenRatio: number;
  /** Height (px) of the contiguous green band flush to the bottom edge. */
  bandHeightPx: number;
}

export function probeVideoBottomBand(
  video: HTMLVideoElement
): BottomBandProbe | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(video, 0, 0, w, h);
  } catch {
    return null; // cross-origin taint or not-yet-painted
  }

  const stripeH = Math.max(16, Math.floor(h * 0.15));
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, h - stripeH, w, stripeH).data;
  } catch {
    return null; // tainted canvas (CORS) — can't read pixels
  }

  const step = Math.max(1, Math.floor(w / 80));
  return {
    sourceW: w,
    sourceH: h,
    bottomRowGreenRatio: rowGreenRatio(data, stripeH - 1, w, step),
    bandHeightPx: measureBottomBand(data, w, stripeH),
  };
}
