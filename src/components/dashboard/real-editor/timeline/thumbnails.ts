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

interface VideoSlot {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  ready: Promise<void>;
  /** Width:height ratio derived from the decoded video. */
  aspect: number;
  width: number;
  height: number;
}

const TARGET_WIDTH = 160;
const slots = new Map<string, VideoSlot>();
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function ensureSlot(url: string): VideoSlot {
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
      const aspect = video.videoWidth > 0 && video.videoHeight > 0
        ? video.videoWidth / video.videoHeight
        : 16 / 9;
      const w = TARGET_WIDTH;
      const h = Math.round(w / aspect);
      canvas.width = w;
      canvas.height = h;
      const slot = slots.get(url);
      if (slot) {
        slot.aspect = aspect;
        slot.width = w;
        slot.height = h;
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
  time: number
): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const key = `${url}::${time.toFixed(2)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const slot = ensureSlot(url);
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

      slot.ctx.drawImage(slot.video, 0, 0, slot.width, slot.height);
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
