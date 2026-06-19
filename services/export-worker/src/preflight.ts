/**
 * Source preflight for cloud export. Before the (expensive) render commits to a
 * source, probe it once and decide whether it's a worker-safe input or a "risky"
 * one that should be normalized to H.264 + AAC first.
 *
 * "Risky" = anything the bundled ffmpeg might choke on mid-render: a non-H.264
 * video codec, an audio codec that isn't AAC (transcode it) or can't be decoded
 * at all (e.g. Apple `apac` → drop audio), or an unexpected stream layout. A
 * plain H.264 + (AAC | no audio) clip is left untouched.
 *
 * One ffprobe + one short audio-decode test feed BOTH the normalization decision
 * and the render, so nothing is probed twice.
 */
import { canDecodeAudio, probeSource, type SourceInfo } from "./ffmpeg.js";

/** The single source of truth for the audio-dropped warning copy. Pushed onto
 *  the job's `warnings[]` whether audio was dropped during normalization or by
 *  the render's `canDecodeAudio` guard, so the user sees identical wording. */
export const AUDIO_UNSUPPORTED_WARNING =
  "This source audio format is not supported. The video was exported without audio.";

export interface Preflight {
  info: SourceInfo;
  /** Source should be transcoded to a worker-safe H.264+AAC MP4 before render. */
  risky: boolean;
  /** Human-readable risk reasons — LOGS ONLY, never persisted or shown to users. */
  reasons: string[];
  /** Whether ffmpeg can decode the source's audio (false when there's no audio). */
  audioDecodable: boolean;
  /** Audio present but undecodable (e.g. apac) ⇒ must export/normalize silent. */
  needsAudioDrop: boolean;
}

export async function computePreflight(path: string): Promise<Preflight> {
  const info = await probeSource(path);
  const audioDecodable = info.hasAudio ? await canDecodeAudio(path) : false;
  const needsAudioDrop = info.hasAudio && !audioDecodable;

  const reasons: string[] = [];
  // Video — anything other than H.264 (hevc/vp9/av1/prores/…) is risky.
  if (info.videoCodec && info.videoCodec !== "h264") {
    reasons.push(`video codec "${info.videoCodec}" is not h264`);
  }
  // A normal editable clip has exactly one (non-cover-art) video stream.
  if (info.nbVideoStreams !== 1) {
    reasons.push(`unexpected video stream count: ${info.nbVideoStreams}`);
  }
  // Audio — present and not AAC ⇒ transcode (or drop if undecodable).
  if (info.hasAudio && info.audioCodec !== "aac") {
    reasons.push(
      needsAudioDrop
        ? `audio codec "${info.audioCodec || info.audioCodecTag || "unknown"}" is undecodable`
        : `audio codec "${info.audioCodec}" is not aac`
    );
  }

  return { info, risky: reasons.length > 0, reasons, audioDecodable, needsAudioDrop };
}
