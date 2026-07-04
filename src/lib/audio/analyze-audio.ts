/**
 * Browser audio analysis — the DOM shell around the pure `detectSilence` core.
 * Fetches the media, decodes its audio track (Web Audio, no API key), reduces it
 * to a mono RMS-per-bucket loudness timeline, and derives speech/silence
 * structure. REAL + free; never fabricates. Best-effort: ANY failure (no audio
 * track, decode error, oversized/long media, offline) resolves to a safe
 * `unavailable`/`failed` status with `hasUsableSpeech: false` and NEVER throws,
 * so it can't break the surrounding analysis pipeline.
 */
import type { AudioAnalysis } from "@/lib/firebase/schema";
import { detectSilence } from "./silence";

/** RMS buckets per second used for detection. */
const RMS_HZ = 40;
/** Cap the stored loudness timeline so the Firestore doc stays small. */
const MAX_LOUDNESS_SAMPLES = 1800;
/** Skip audio analysis above these bounds (keeps memory + time bounded). */
const MAX_DURATION_SEC = 900;
const MAX_BYTES = 260 * 1024 * 1024;

function unavailable(reason: string): AudioAnalysis {
  return { status: "unavailable", hasUsableSpeech: false, error: reason };
}

function quantize01(v: number): number {
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  return Math.round(c * 255);
}

/** Compute a mono RMS-per-bucket timeline from a decoded AudioBuffer. */
function rmsBuckets(buffer: AudioBuffer, hz: number): number[] {
  const sr = buffer.sampleRate;
  const per = Math.max(1, Math.round(sr / hz));
  const nBuckets = Math.ceil(buffer.length / per);
  const ch = buffer.numberOfChannels;
  const out = new Array<number>(nBuckets).fill(0);
  // Accumulate sum-of-squares per bucket across channels, then RMS.
  const counts = new Array<number>(nBuckets).fill(0);
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const b = (i / per) | 0;
      const s = data[i];
      out[b] += s * s;
      if (c === 0) counts[b]++;
    }
  }
  for (let b = 0; b < nBuckets; b++) {
    const cnt = counts[b] * ch;
    out[b] = cnt > 0 ? Math.sqrt(out[b] / cnt) : 0;
  }
  return out;
}

/** Evenly downsample a series to at most `max` points (peak-preserving). */
function downsampleLoudness(rms: number[], max: number): { loudness: number[]; hz: number } {
  if (rms.length <= max) return { loudness: rms.map(quantize01), hz: RMS_HZ };
  const factor = Math.ceil(rms.length / max);
  const out: number[] = [];
  for (let i = 0; i < rms.length; i += factor) {
    let peak = 0;
    for (let j = i; j < Math.min(rms.length, i + factor); j++) peak = Math.max(peak, rms[j]);
    out.push(quantize01(peak));
  }
  return { loudness: out, hz: RMS_HZ / factor };
}

export async function analyzeAudio(
  url: string | undefined | null,
  durationSeconds: number | undefined,
  signal?: AbortSignal
): Promise<AudioAnalysis> {
  try {
    if (typeof window === "undefined") return unavailable("no browser audio context");
    if (!url) return unavailable("no source url");
    if (durationSeconds && durationSeconds > MAX_DURATION_SEC) {
      return unavailable(`media too long for audio analysis (${Math.round(durationSeconds)}s)`);
    }
    const AudioCtx: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return unavailable("Web Audio unsupported");

    const res = await fetch(url, { signal });
    if (!res.ok) return unavailable(`fetch ${res.status}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > MAX_BYTES) return unavailable("media too large for audio analysis");
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) return unavailable("media too large for audio analysis");
    if (signal?.aborted) return unavailable("cancelled");

    const ctx = new AudioCtx();
    let buffer: AudioBuffer;
    try {
      // decodeAudioData demuxes the container + decodes the audio track.
      buffer = await ctx.decodeAudioData(bytes.slice(0));
    } catch {
      return unavailable("no decodable audio track");
    } finally {
      void ctx.close().catch(() => {});
    }
    if (!buffer || buffer.numberOfChannels === 0 || buffer.length === 0) {
      return unavailable("empty audio");
    }

    const rms = rmsBuckets(buffer, RMS_HZ);
    // A completely flat/near-silent track (music-only export stripped, or true
    // silence) → no usable speech, but still a valid "complete" analysis.
    const detected = detectSilence(rms, RMS_HZ);
    const { loudness, hz } = downsampleLoudness(rms, MAX_LOUDNESS_SAMPLES);

    return {
      status: "complete",
      ...detected,
      loudness,
      loudnessSampleRate: hz,
    };
  } catch (err) {
    if (signal?.aborted) return unavailable("cancelled");
    return {
      status: "failed",
      hasUsableSpeech: false,
      error: err instanceof Error ? err.message : "audio analysis failed",
    };
  }
}
