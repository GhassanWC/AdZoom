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

function ensureSlot(url: string, crop?: SourceCrop): VideoSlot {
  const existing = slots.get(url);
  if (existing) return existing;

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "auto";
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
}
