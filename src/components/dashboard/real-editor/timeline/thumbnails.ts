"use client";

/**
 * Client-side video frame extractor for timeline pill thumbnails.
 *
 * Strategy: maintain ONE hidden `<video>` per source URL (videos are large —
 * one decode pipeline is plenty). Requests for individual timestamps are
 * serialised through a per-URL queue so concurrent `seeked` events don't
 * collide. Results are cached in memory by `${url}::${time.toFixed(2)}`.
 *
 * We render at a small width (160px) — pills are 28px tall in the UI, so
 * 160×90 is already 5× the rendered density on retina. Anything larger is
 * wasted memory.
 *
 * ── Why this file is careful about bandwidth ─────────────────────────────────
 * This element loads the SAME url the preview player is streaming, and it has to
 * carry `crossOrigin` (the canvas is read back with `toDataURL`, which a tainted
 * canvas refuses) while the preview deliberately does not. Different CORS modes
 * mean different HTTP cache entries, so the browser treats them as two unrelated
 * downloads of one file. With `preload="auto"` that was a full second copy of a
 * multi-hundred-megabyte recording, pulled while the user was trying to watch
 * the first one — which showed up as the preview stalling and resuming.
 *
 * So: `preload="metadata"` (seeking still works; it fetches only the ranges it
 * lands on), and the per-URL queue the paragraph above promised is now real —
 * before, N pills mounting together all wrote `currentTime` on ONE element and
 * raced on a single `seeked` handler, turning a screenful of pills into a seek
 * storm on the same connection the player needs.
 */

import { resolveSourceRect } from "@/lib/timeline/source-crop";
import type { SourceCrop } from "@/lib/recording/types";

interface VideoSlot {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  ready: Promise<void>;
  /** Width:height ratio derived from the decoded (EFFECTIVE) video frame. */
  aspect: number;
  width: number;
  height: number;
  /** Source rect to sample (Frame Crop sub-rectangle); cropActive=false = full frame. */
  cropActive: boolean;
  cropSrcX: number;
  cropSrcY: number;
  cropSrcW: number;
  cropSrcH: number;
}

const TARGET_WIDTH = 160;
const slots = new Map<string, VideoSlot>();
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
/** Tail of the per-URL seek queue — see `acquire`. */
const queues = new Map<string, Promise<void>>();

/**
 * Preview-priority gate, registered by the player (RealVideoPlayer).
 *
 * A screenful of pills mounting when the editor opens turns into dozens of
 * range requests against the SAME url the preview is trying to buffer — on a
 * thin connection the two starve each other, and the loser the user notices is
 * always the preview. When the registered predicate says the preview needs the
 * bandwidth (rebuffering, or playing on a thin buffer — see
 * `previewNeedsBandwidth` in buffer-health.ts), captures WAIT; thumbnails are
 * a nicety with no deadline, and they resume the moment playback pauses or
 * the buffer is healthy. No player mounted (or a local source) ⇒ no gate.
 */
let previewBusy: (() => boolean) | null = null;
const PRIORITY_POLL_MS = 500;

export function setThumbnailPriorityGate(busy: (() => boolean) | null): void {
  previewBusy = busy;
}

async function awaitPreviewIdle(): Promise<void> {
  while (previewBusy && previewBusy()) {
    await new Promise((resolve) => setTimeout(resolve, PRIORITY_POLL_MS));
  }
}

function ensureSlot(url: string, crop?: SourceCrop): VideoSlot {
  const existing = slots.get(url);
  if (existing) return existing;

  const video = document.createElement("video");
  // Required: the frame is read back with `toDataURL`, and a canvas drawn from a
  // cross-origin video without this is tainted and throws.
  video.crossOrigin = "anonymous";
  // NOT "auto" — see the header. This element must never race the preview player
  // for the same file; metadata plus on-demand range fetches is all a seek-and-
  // grab-one-frame extractor needs.
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  // Don't attach to DOM — keeps it out of layout but lets it decode.
  video.style.position = "absolute";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  video.style.width = "1px";
  video.style.height = "1px";

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  const ready = new Promise<void>((resolve, reject) => {
    const onMeta = () => {
      // Sample only the Frame Crop sub-rectangle so the thumbnail aspect +
      // sampled rect match the editor + export (effective source frame).
      const rect = resolveSourceRect(video.videoWidth, video.videoHeight, crop);
      const effW = rect.sWidth || video.videoWidth;
      const effH = rect.sHeight || video.videoHeight;
      const aspect = effW > 0 && effH > 0 ? effW / effH : 16 / 9;
      const w = TARGET_WIDTH;
      const h = Math.round(w / aspect);
      canvas.width = w;
      canvas.height = h;
      const slot = slots.get(url);
      if (slot) {
        slot.aspect = aspect;
        slot.width = w;
        slot.height = h;
        slot.cropActive = rect.cropActive;
        slot.cropSrcX = rect.sx;
        slot.cropSrcY = rect.sy;
        slot.cropSrcW = rect.sWidth;
        slot.cropSrcH = rect.sHeight;
      }
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onErr);
      reject(new Error(`Thumbnail video failed to load: ${url}`));
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("error", onErr);
  });

  const slot: VideoSlot = {
    video,
    canvas,
    ctx,
    ready,
    aspect: 16 / 9,
    width: TARGET_WIDTH,
    height: Math.round(TARGET_WIDTH * (9 / 16)),
    cropActive: false,
    cropSrcX: 0,
    cropSrcY: 0,
    cropSrcW: 0,
    cropSrcH: 0,
  };
  slots.set(url, slot);
  return slot;
}

/**
 * Capture a single frame at `time` (seconds). Returns a data-URL JPEG or
 * `null` if extraction fails (CORS, decode error, etc.). Concurrent calls
 * for the same key dedupe to a single seek + draw.
 */
export async function captureFrame(
  url: string,
  time: number,
  crop?: SourceCrop
): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const key = `${url}::${time.toFixed(2)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const slot = ensureSlot(url, crop);
      await slot.ready;
      if (!slot.ctx) return null;

      // Take the per-URL lock. One element, one `seeked` event stream — two
      // captures in flight at once would each see the other's `seeked` and draw
      // the wrong frame, and every extra concurrent seek is another range
      // request competing with the preview player.
      const release = await acquire(url);
      try {
        // Yield to the preview player before spending its bandwidth — holding
        // the per-URL lock while waiting is deliberate, since every queued
        // capture behind this one would only have to wait the same way.
        await awaitPreviewIdle();

        await new Promise<void>((resolve, reject) => {
          const onSeeked = () => {
            slot.video.removeEventListener("seeked", onSeeked);
            slot.video.removeEventListener("error", onErr);
            resolve();
          };
          const onErr = () => {
            slot.video.removeEventListener("seeked", onSeeked);
            slot.video.removeEventListener("error", onErr);
            reject(new Error("seek failed"));
          };
          slot.video.addEventListener("seeked", onSeeked);
          slot.video.addEventListener("error", onErr);
          try {
            slot.video.currentTime = Math.max(0, time);
          } catch (err) {
            onErr();
            throw err;
          }
        });

        return drawSlot(slot, key);
      } finally {
        release();
      }
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Serialise work per URL.
 *
 * The file's header has always claimed captures were queued; they weren't. Each
 * caller awaits the previous one's release, so exactly one seek is ever in
 * flight against a given hidden element.
 */
function acquire(url: string): Promise<() => void> {
  const prev = queues.get(url) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(
    url,
    prev.then(() => next)
  );
  return prev.then(() => release);
}

/** Draw the current frame of `slot` into its canvas and cache the data URL. */
function drawSlot(slot: VideoSlot, key: string): string | null {
  if (!slot.ctx) return null;
  if (slot.cropActive) {
    // 9-arg: sample only the Frame Crop sub-rectangle.
    slot.ctx.drawImage(
      slot.video,
      slot.cropSrcX,
      slot.cropSrcY,
      slot.cropSrcW,
      slot.cropSrcH,
      0,
      0,
      slot.width,
      slot.height
    );
  } else {
    slot.ctx.drawImage(slot.video, 0, 0, slot.width, slot.height);
  }
  const data = slot.canvas.toDataURL("image/jpeg", 0.72);
  cache.set(key, data);
  return data;
}

/**
 * Drop the cached frames and tear down the hidden `<video>` for a URL. Call
 * when the editor unmounts so we don't leak decoded video buffers across
 * navigations.
 */
export function disposeThumbnails(url?: string): void {
  if (typeof window === "undefined") return;
  if (url) {
    const slot = slots.get(url);
    if (slot) {
      slot.video.src = "";
      slot.video.load?.();
      slots.delete(url);
    }
    for (const k of Array.from(cache.keys())) {
      if (k.startsWith(`${url}::`)) cache.delete(k);
    }
    return;
  }
  for (const slot of slots.values()) {
    slot.video.src = "";
    slot.video.load?.();
  }
  slots.clear();
  cache.clear();
  inflight.clear();
  queues.clear();
}
