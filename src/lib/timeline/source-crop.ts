/**
 * Source-rectangle crop — the SINGLE source of truth for the global Frame Crop
 * (which sub-rectangle of the recorded video is kept). Shared by the preview
 * (CSS clip), the exporter (9-arg drawImage), and the CV analyzers, so the
 * three can never disagree about the effective source frame.
 *
 * Pure + deterministic (no DOM / Firestore / Date.now / Math.random) — the same
 * "shared math, two renderers" model used by `canvas-layout.ts` / `camera.ts`.
 *
 * When there's no crop (the common case — uploads, full-frame projects, and
 * every project from before this shipped), `resolveSourceRect` returns the full
 * frame with `cropActive:false`, so every consumer behaves exactly as before.
 */

import type { SourceCrop } from "@/lib/recording/types";

export interface SourceRect {
  /** Source rectangle origin + size, in the CURRENT frame's pixel space. */
  sx: number;
  sy: number;
  sWidth: number;
  sHeight: number;
  /** True when the rect is a strict sub-region of the full frame. */
  cropActive: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/**
 * Smallest crop dimension we'll persist/render (normalized). Below this a crop
 * scales the preview `<video>` so far past its clip box that it reads as black,
 * so we never let a crop dimension collapse toward zero. The editor enforces a
 * larger floor (0.05); this is the defensive backstop for any other writer.
 */
export const MIN_CROP_SIZE = 0.02;

/**
 * Clamp / repair a `SourceCrop` to safe NORMALIZED values BEFORE it is persisted
 * or rendered — the single guard that keeps a bad crop from blanking the
 * preview or the export.
 *
 * Guarantees for an enabled crop: finite x/y/width/height, width/height in
 * `[MIN_CROP_SIZE, 1]`, and the rect fully inside the frame
 * (`x + width ≤ 1`, `y + height ≤ 1`). A non-finite or non-positive
 * width/height can't be repaired into a meaningful rect, so it safely RESETS to
 * the full-frame disabled crop (full video shown) instead of rendering black.
 * Disabled crops are normalized to the full frame. Provenance fields
 * (`aspectLock`, `reason`, `confidence`) are preserved.
 */
export function sanitizeSourceCrop(
  crop?: SourceCrop | null
): SourceCrop | undefined {
  if (!crop) return undefined;
  if (!crop.enabled) {
    return { ...crop, enabled: false, x: 0, y: 0, width: 1, height: 1 };
  }
  const finite = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);
  if (
    !finite(crop.x) ||
    !finite(crop.y) ||
    !finite(crop.width) ||
    !finite(crop.height) ||
    crop.width <= 0 ||
    crop.height <= 0
  ) {
    // Unrepairable rect → reset to full frame (disabled), keep provenance.
    return {
      ...FULL_FRAME_CROP,
      aspectLock: crop.aspectLock,
      reason: crop.reason,
    };
  }
  const width = clamp(crop.width, MIN_CROP_SIZE, 1);
  const height = clamp(crop.height, MIN_CROP_SIZE, 1);
  let x = clamp01(crop.x);
  let y = clamp01(crop.y);
  if (x + width > 1) x = 1 - width;
  if (y + height > 1) y = 1 - height;
  return { ...crop, enabled: true, x: clamp01(x), y: clamp01(y), width, height };
}

/** A normalized point/region pair the remap helpers operate on. */
export interface NormPoint {
  x: number;
  y: number;
}
export interface NormRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Resolve the effective source rectangle (pixels) for a frame of intrinsic size
 * `videoW × videoH`, given the project's (optional) `sourceCrop`.
 *
 * No-op (full frame, `cropActive:false`) when the crop is absent/disabled, or
 * the frame's intrinsic dims aren't known yet (`videoW`/`videoH` ≤ 0) — we
 * never crop a guessed dimension. Otherwise the normalized rect is mapped to
 * pixels, clamped inside the frame, and `sWidth`/`sHeight` are floored to even
 * (≥ 2) for H.264. Normalized coords are resolution-independent, so no rescale
 * is needed across decode paths.
 */
export function resolveSourceRect(
  videoW: number,
  videoH: number,
  crop?: SourceCrop | null
): SourceRect {
  const W = videoW > 0 ? Math.floor(videoW) : 0;
  const H = videoH > 0 ? Math.floor(videoH) : 0;

  if (
    !W ||
    !H ||
    !crop?.enabled ||
    !(crop.width > 0) ||
    !(crop.height > 0)
  ) {
    return { sx: 0, sy: 0, sWidth: W, sHeight: H, cropActive: false };
  }

  let sx = Math.round(clamp01(crop.x) * W);
  let sy = Math.round(clamp01(crop.y) * H);
  let sWidth = Math.round(clamp01(crop.width) * W);
  let sHeight = Math.round(clamp01(crop.height) * H);

  // Keep the rect inside the frame.
  sx = Math.max(0, Math.min(sx, W - 2));
  sy = Math.max(0, Math.min(sy, H - 2));
  sWidth = Math.min(sWidth, W - sx);
  sHeight = Math.min(sHeight, H - sy);

  // Floor to even dims (H.264) so we never leave a 1px sliver.
  if (sWidth % 2 !== 0) sWidth -= 1;
  if (sHeight % 2 !== 0) sHeight -= 1;
  sWidth = Math.max(2, sWidth);
  sHeight = Math.max(2, sHeight);

  // Re-clamp origin if rounding pushed the rect past the edge.
  if (sx + sWidth > W) sx = W - sWidth;
  if (sy + sHeight > H) sy = H - sHeight;
  sx = Math.max(0, sx);
  sy = Math.max(0, sy);

  const cropActive = sx > 0 || sy > 0 || sWidth < W || sHeight < H;
  return { sx, sy, sWidth, sHeight, cropActive };
}

/** A full-frame, disabled crop — the canonical "no crop" value. */
export const FULL_FRAME_CROP: SourceCrop = {
  enabled: false,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

// ── Coordinate remap (crop-space ↔ full-frame-space) ─────────────────────────
// Downstream coords (focusRegion, cursor, camera) are normalized to the
// EFFECTIVE (cropped) frame. When the crop changes, existing coords measured
// against the OLD crop must be re-expressed in the NEW crop's space. These pure
// helpers do that mapping; `enabled:false` (or full-frame) crops are identity.

/** Effective crop rect, defaulting a disabled/absent crop to the full frame. */
function effRect(crop?: SourceCrop | null): NormRegion {
  if (!crop?.enabled) return { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: clamp01(crop.x),
    y: clamp01(crop.y),
    width: crop.width > 0 ? crop.width : 1,
    height: crop.height > 0 ? crop.height : 1,
  };
}

/** Crop-normalized point → full-frame-normalized point. */
export function croppedToSource(p: NormPoint, crop?: SourceCrop | null): NormPoint {
  const r = effRect(crop);
  return { x: r.x + p.x * r.width, y: r.y + p.y * r.height };
}

/** Full-frame-normalized point → crop-normalized point (clamped to [0,1]). */
export function sourceToCropped(p: NormPoint, crop?: SourceCrop | null): NormPoint {
  const r = effRect(crop);
  return {
    x: clamp01((p.x - r.x) / r.width),
    y: clamp01((p.y - r.y) / r.height),
  };
}

/**
 * Re-express a region given in OLD-crop-normalized space into NEW-crop space
 * (via the shared full-frame space), clamped to [0,1] with a minimum size.
 * Identity when oldCrop and newCrop describe the same rect.
 */
export function remapRegion(
  region: NormRegion,
  oldCrop: SourceCrop | null | undefined,
  newCrop: SourceCrop | null | undefined,
  minSize = 0.04
): NormRegion {
  const tl = sourceToCropped(
    croppedToSource({ x: region.x, y: region.y }, oldCrop),
    newCrop
  );
  const br = sourceToCropped(
    croppedToSource(
      { x: region.x + region.width, y: region.y + region.height },
      oldCrop
    ),
    newCrop
  );
  const x = Math.min(tl.x, br.x);
  const y = Math.min(tl.y, br.y);
  const width = Math.max(minSize, Math.abs(br.x - tl.x));
  const height = Math.max(minSize, Math.abs(br.y - tl.y));
  return {
    x: clamp01(Math.min(x, 1 - width)),
    y: clamp01(Math.min(y, 1 - height)),
    width,
    height,
  };
}
