/**
 * OFFLINE audio builder for the Editframe beta export.
 *
 * `composeFrame` handles video only; audio is rebuilt here from the SAME
 * `TimelineMap` the video frames use, so cuts, speed and mute stay perfectly in
 * sync with the picture:
 *
 *   • cuts   → removed source ranges are simply never scheduled.
 *   • speed  → each segment plays at `playbackRate = speedMultiplier`.
 *   • mute   → speed sections with `audioMode:"mute"` play at gain 0.
 *
 * This matches the Cloud worker EXACTLY for cuts, mute, and "keep" speed (both
 * let pitch follow speed — ffmpeg `asetrate`). The one divergence is
 * "pitch-correct" speed, which the worker pitch-preserves (ffmpeg `atempo`) but
 * a plain `OfflineAudioContext` playbackRate cannot — that raises `pitchApprox`
 * so the UI can surface a non-fatal notice.
 *
 * mediabunny (Editframe's decode engine) decodes the source audio; WebAudio
 * assembles + renders the output track. Browser-only (uses `AudioBuffer` /
 * `OfflineAudioContext`) — imported lazily by the render engine.
 */
import { AudioBufferSink, type InputAudioTrack } from "mediabunny";
import type { TimelineMap } from "@/lib/timeline/crop-speed";
import type { DetectedMoment } from "@/lib/firebase/schema";
import { isMomentEnabled } from "@/lib/firebase/schema";

export interface OutputAudioResult {
  /** The rendered output audio track, or null if the source had no usable audio. */
  buffer: AudioBuffer | null;
  /** True when at least one "pitch-correct" speed section had to fall back to pitch-follows. */
  pitchApprox: boolean;
}

type SpeedAudioMode = "mute" | "keep" | "pitch-correct";

/**
 * The audio mode of the active speed section at source time `t` (latest-start
 * wins, mirroring `buildTimelineMap`/`speedAt`). Missing `audioMode` defaults to
 * "mute", matching `DEFAULT_SPEED.audioMode` used across the render paths.
 */
function speedAudioModeAt(moments: DetectedMoment[], t: number): SpeedAudioMode | null {
  let mode: SpeedAudioMode | null = null;
  let bestStart = -Infinity;
  for (const m of moments) {
    if (m.effectType !== "speed-up" || !isMomentEnabled(m)) continue;
    if (t >= m.startTime && t < m.endTime && m.startTime >= bestStart) {
      bestStart = m.startTime;
      mode = m.speed?.audioMode ?? "mute";
    }
  }
  return mode;
}

/**
 * Decode the source audio and render the cut/speed/mute-adjusted output track.
 * Returns `{ buffer: null }` when the track yields no decodable audio (the
 * caller then exports silent with a warning).
 */
export async function buildOutputAudioBuffer(
  audioTrack: InputAudioTrack,
  timelineMap: TimelineMap,
  moments: DetectedMoment[]
): Promise<OutputAudioResult> {
  const sink = new AudioBufferSink(audioTrack);

  // ── 1. Decode the whole source track into a contiguous source buffer ──
  const chunks: Array<{ buffer: AudioBuffer; timestamp: number }> = [];
  let sampleRate = 0;
  let channels = 0;
  for await (const chunk of sink.buffers()) {
    if (!chunk) continue;
    chunks.push({ buffer: chunk.buffer, timestamp: chunk.timestamp });
    sampleRate = chunk.buffer.sampleRate;
    channels = Math.max(channels, chunk.buffer.numberOfChannels);
  }
  if (chunks.length === 0 || sampleRate === 0 || channels === 0) {
    return { buffer: null, pitchApprox: false };
  }

  const srcLen = Math.max(1, Math.ceil(timelineMap.sourceDuration * sampleRate) + sampleRate);
  const srcBuf = new AudioBuffer({ length: srcLen, numberOfChannels: channels, sampleRate });
  for (const { buffer, timestamp } of chunks) {
    const offset = Math.round(timestamp * sampleRate);
    if (offset >= srcLen) continue;
    for (let ch = 0; ch < channels; ch++) {
      const srcCh = ch < buffer.numberOfChannels ? ch : 0;
      const data = buffer.getChannelData(srcCh);
      const dst = srcBuf.getChannelData(ch);
      const copyLen = Math.min(data.length, srcLen - offset);
      if (copyLen > 0) dst.set(data.subarray(0, copyLen), Math.max(0, offset));
    }
  }

  // ── 2. Schedule each surviving segment onto the output timeline ──
  const outLen = Math.max(1, Math.ceil(timelineMap.outputDuration * sampleRate));
  const outCtx = new OfflineAudioContext(channels, outLen, sampleRate);
  let pitchApprox = false;

  for (const seg of timelineMap.segments) {
    const sourceLen = Math.max(0, seg.sourceEnd - seg.sourceStart);
    if (sourceLen <= 0) continue;
    const mid = (seg.sourceStart + seg.sourceEnd) / 2;
    const mode = speedAudioModeAt(moments, mid);
    if (mode === "pitch-correct" && seg.speedMultiplier !== 1) pitchApprox = true;

    const node = outCtx.createBufferSource();
    node.buffer = srcBuf;
    node.playbackRate.value = seg.speedMultiplier;
    const gain = outCtx.createGain();
    gain.gain.value = mode === "mute" ? 0 : 1;
    node.connect(gain).connect(outCtx.destination);
    // start(when=outputStart, offset=sourceStart, duration=source seconds).
    // playbackRate compresses `sourceLen` into (sourceLen / rate) output seconds,
    // which equals seg.outputEnd - seg.outputStart.
    node.start(seg.outputStart, seg.sourceStart, sourceLen);
  }

  const rendered = await outCtx.startRendering();
  return { buffer: rendered, pitchApprox };
}
