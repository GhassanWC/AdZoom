"use client";

import { CV_CHUNK_CONCURRENCY } from "../../analysis/chunk-config";
import { HiddenVideoCvEngine } from "./hidden-video";
import { WebCodecsCvEngine } from "./webcodecs/engine";
import type { CvChunkEngine, CvEngineKind, CvSource } from "./types";

/**
 * Pick the CV engine for a source. WebCodecs (decode off-thread in a worker
 * pool) is the primary path when the browser + codec support it; the
 * hidden-`<video>` engine is the fallback everywhere else.
 *
 * Phase 5 plugs the WebCodecs engine in here behind `canUseWebCodecs`; until
 * then every source resolves to the fallback, which already delivers the full
 * progressive experience.
 */
export async function selectCvEngine(source: CvSource): Promise<CvChunkEngine> {
  // WebCodecs is the primary engine. We currently demux MP4 only (mp4box);
  // WebM/other containers use the fallback. The orchestrator probes the chosen
  // engine on the first chunk and hot-swaps to the fallback if it can't run, so
  // an unsupported codec/browser degrades gracefully.
  const m = (source.mimeType ?? "").toLowerCase();
  const isMp4 = m.startsWith("video/mp4") || m.startsWith("video/quicktime");
  if (isMp4 && (await canUseWebCodecs(source.mimeType))) {
    return new WebCodecsCvEngine(source);
  }
  return new HiddenVideoCvEngine(source);
}

/** Concurrency for an engine kind — WebCodecs parallelises, the fallback can't. */
export function cvConcurrencyFor(kind: CvEngineKind): number {
  return kind === "webcodecs" ? CV_CHUNK_CONCURRENCY : 1;
}

/**
 * Capability probe: WebCodecs `VideoDecoder` exists AND the container codec is
 * decodable. Conservative — anything uncertain returns false so we fall back.
 */
export async function canUseWebCodecs(mimeType?: string): Promise<boolean> {
  if (typeof VideoDecoder === "undefined" || !mimeType) return false;
  const codec = webCodecsCodecFor(mimeType);
  if (!codec) return false;
  try {
    const res = await VideoDecoder.isConfigSupported({ codec });
    return res.supported === true;
  } catch {
    return false;
  }
}

/**
 * Map a recording MIME type to a WebCodecs codec string. Returns null for
 * containers/codecs we don't (yet) demux. Recorder defaults: H.264 MP4
 * (`avc1.42E01E`) or VP8/VP9 WebM.
 */
export function webCodecsCodecFor(mimeType: string): string | null {
  const m = mimeType.toLowerCase();
  // Prefer an explicit codecs= tag when present.
  const tag = /codecs=([^;]+)/.exec(m)?.[1]?.replace(/["']/g, "").trim();
  if (tag) {
    if (tag.startsWith("avc1") || tag.startsWith("avc3")) return tag;
    if (tag.startsWith("vp9") || tag.startsWith("vp09")) return "vp09.00.10.08";
    if (tag.startsWith("vp8")) return "vp8";
    if (tag.startsWith("av01")) return tag;
  }
  if (m.startsWith("video/mp4") || m.startsWith("video/quicktime")) {
    return "avc1.42E01E"; // H.264 baseline — the recorder's preferred profile
  }
  if (m.startsWith("video/webm")) return "vp8";
  return null;
}
