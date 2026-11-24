/**
 * OFFLINE audio builder for the Editframe (in-browser) export.
 *
 * The mix is the evaluator's {@link planAudio}: one scheduled buffer source per
 * run (asset, source start, rate) with its gain envelope automated, so cuts,
 * speed, freezes, fades, crossfades, independent tracks and ducking are the
 * same numbers the worker's ffmpeg graph applies. Pitch always follows the
 * rate here (a BufferSource cannot time-stretch); a "preserve" run raises
 * `pitchApprox` so the UI can say so.
 *
 * mediabunny decodes each asset's audio; WebAudio assembles and renders the
 * output track. Browser-only — imported lazily by the render engine.
 */
import { AudioBufferSink, type InputAudioTrack } from "mediabunny";
import type { AudioRun } from "@/lib/timeline/evaluate";

export interface OutputAudioResult {
  buffer: AudioBuffer | null;
  pitchApprox: boolean;
}

/** Decode a whole track into one contiguous AudioBuffer (null when it yields nothing). */
export async function decodeTrack(track: InputAudioTrack, durationHint: number): Promise<AudioBuffer | null> {
  const sink = new AudioBufferSink(track);
  const chunks: Array<{ buffer: AudioBuffer; timestamp: number }> = [];
  let sampleRate = 0;
  let channels = 0;
  for await (const chunk of sink.buffers()) {
    if (!chunk) continue;
    chunks.push({ buffer: chunk.buffer, timestamp: chunk.timestamp });
    sampleRate = chunk.buffer.sampleRate;
    channels = Math.max(channels, chunk.buffer.numberOfChannels);
  }
  if (!chunks.length || !sampleRate || !channels) return null;
  const last = chunks[chunks.length - 1];
  const totalSec = Math.max(durationHint, last.timestamp + last.buffer.duration);
  const len = Math.max(1, Math.ceil(totalSec * sampleRate) + sampleRate);
  const out = new AudioBuffer({ length: len, numberOfChannels: channels, sampleRate });
  for (const { buffer, timestamp } of chunks) {
    const offset = Math.round(timestamp * sampleRate);
    if (offset >= len) continue;
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch < buffer.numberOfChannels ? ch : 0);
      const copyLen = Math.min(data.length, len - offset);
      if (copyLen > 0) out.getChannelData(ch).set(data.subarray(0, copyLen), Math.max(0, offset));
    }
  }
  return out;
}

/**
 * Render the sequence's audio. `buffers` maps asset id → decoded track (assets
 * without audio are absent, and their runs are skipped).
 */
export async function buildSequenceAudio(
  runs: AudioRun[],
  buffers: Map<string, AudioBuffer>,
  outputDuration: number
): Promise<OutputAudioResult> {
  const usable = runs.filter((r) => buffers.has(r.assetId) && r.outputEnd - r.outputStart > 1e-4);
  if (!usable.length) return { buffer: null, pitchApprox: false };
  const sampleRate = Math.max(...[...buffers.values()].map((b) => b.sampleRate));
  const channels = Math.max(2, ...[...buffers.values()].map((b) => b.numberOfChannels));
  const outLen = Math.max(1, Math.ceil(outputDuration * sampleRate));
  const ctx = new OfflineAudioContext(channels, outLen, sampleRate);
  let pitchApprox = false;

  for (const run of usable) {
    const buf = buffers.get(run.assetId)!;
    const outLenSec = run.outputEnd - run.outputStart;
    const rate = run.rate > 0 ? run.rate : 1;
    if (run.pitch === "preserve" && Math.abs(rate - 1) > 1e-4) pitchApprox = true;
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.playbackRate.value = rate;
    const gain = ctx.createGain();
    const pts = run.gain.length ? run.gain : [{ at: run.outputStart, gain: 1 }];
    gain.gain.setValueAtTime(Math.max(0, pts[0].gain), Math.max(0, pts[0].at));
    for (let i = 1; i < pts.length; i++) gain.gain.linearRampToValueAtTime(Math.max(0, pts[i].gain), Math.max(0, pts[i].at));
    node.connect(gain).connect(ctx.destination);
    // start(when, offset, duration): `duration` is SOURCE seconds — playbackRate compresses it to outLenSec.
    node.start(run.outputStart, Math.max(0, run.sourceStart), outLenSec * rate);
  }
  const rendered = await ctx.startRendering();
  return { buffer: rendered, pitchApprox };
}
