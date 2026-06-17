"use client";

/**
 * Export FORMAT (container) system — the single source of truth for which file
 * the browser produces. This is DISTINCT from `ExportFormat` in the schema,
 * which is the aspect/canvas preset ("Source" | "TikTok 9:16" | …). Here we
 * choose the CONTAINER + codec:
 *
 *   • WebM — rendered reliably by MediaRecorder (VP9/VP8 + Opus). The default.
 *   • MP4  — H.264 + AAC, produced by a WebCodecs encode + `mp4-muxer` muxer
 *            (NOT MediaRecorder — Chrome's MediaRecorder MP4 muxer throws
 *            `EncodingError: "Internal Error."` mid-record, which was the
 *            production export failure this system replaces).
 *
 * The MP4 path needs WebCodecs (`VideoEncoder`/`AudioEncoder`) AND
 * `MediaStreamTrackProcessor`, which today means Chrome/Edge. Everywhere else,
 * `canEncodeMp4` returns false and the exporter falls back to WebM.
 */

export type ExportContainer = "webm" | "mp4";

export interface ContainerInfo {
  id: ExportContainer;
  label: string;
  /** File extension (no dot). */
  ext: string;
  /** Container MIME (without codecs). */
  mimeType: string;
  description: string;
}

export const CONTAINERS: Record<ExportContainer, ContainerInfo> = {
  webm: {
    id: "webm",
    label: "WebM",
    ext: "webm",
    mimeType: "video/webm",
    description: "Reliable, high quality. Recommended.",
  },
  mp4: {
    id: "mp4",
    label: "MP4",
    ext: "mp4",
    mimeType: "video/mp4",
    description: "H.264 — most compatible for sharing. Chrome & Edge only.",
  },
};

export const DEFAULT_CONTAINER: ExportContainer = "webm";

export function containerExt(c: ExportContainer): string {
  return CONTAINERS[c]?.ext ?? "webm";
}

export function isExportContainer(v: unknown): v is ExportContainer {
  return v === "webm" || v === "mp4";
}

// ── Quality ───────────────────────────────────────────────────────────────
// High bitrates by resolution × fps — shared by BOTH the WebM (VP9/Opus) and
// MP4 (H.264/AAC) sinks, so WebM is NOT lower quality just because it's WebM.

export function videoBitrateFor(resolution: "1080p" | "4K", fps: 30 | 60): number {
  if (resolution === "4K") return fps >= 60 ? 45_000_000 : 28_000_000;
  return fps >= 60 ? 14_000_000 : 10_000_000;
}

export const AUDIO_BITRATE_OPUS = 160_000;
export const AUDIO_BITRATE_AAC = 192_000;

/**
 * H.264 (AVC) codec string sized to the output. High profile (0x64=100); the
 * level (last byte) must be high enough for the frame size or
 * `isConfigSupported` rejects it: 4.0 (0x28) ≤1080p, 5.1 (0x33) ≤4K, 5.2 (0x34)
 * for 4K60-class.
 */
export function avcCodecFor(width: number, height: number): string {
  const megapixels = (width * height) / 1_000_000;
  if (megapixels > 9) return "avc1.640034"; // High@5.2
  if (megapixels > 3) return "avc1.640033"; // High@5.1
  return "avc1.640028"; // High@4.0
}

/** AAC-LC. */
export const AAC_CODEC = "mp4a.40.2";

/**
 * True when this browser can produce a real MP4 via WebCodecs (NOT the unstable
 * MediaRecorder MP4 path). Requires `VideoEncoder` + `AudioEncoder` +
 * `MediaStreamTrackProcessor`, and that the H.264/AAC configs are supported for
 * the requested dimensions. Conservative — anything uncertain returns false so
 * the exporter falls back to WebM. Mirrors `canUseWebCodecs` in cv/engine/select.
 */
export async function canEncodeMp4(opts: {
  width: number;
  height: number;
  fps: 30 | 60;
}): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") {
    return false;
  }
  // `MediaStreamTrackProcessor` (Insertable Streams) — Chrome/Edge only, and not
  // in lib.dom typings, so probe it off globalThis.
  if (
    typeof (globalThis as { MediaStreamTrackProcessor?: unknown })
      .MediaStreamTrackProcessor === "undefined"
  ) {
    return false;
  }
  try {
    const v = await VideoEncoder.isConfigSupported({
      codec: avcCodecFor(opts.width, opts.height),
      width: opts.width,
      height: opts.height,
      bitrate: videoBitrateFor("1080p", opts.fps),
      framerate: opts.fps,
    });
    const a = await AudioEncoder.isConfigSupported({
      codec: AAC_CODEC,
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: AUDIO_BITRATE_AAC,
    });
    return v.supported === true && a.supported === true;
  } catch {
    return false;
  }
}
