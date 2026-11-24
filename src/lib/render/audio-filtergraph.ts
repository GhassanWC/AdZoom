/**
 * ffmpeg `filter_complex` for a sequence's audio, built from the evaluator's
 * {@link planAudio} runs — so the mix the worker (and desktop) encodes is the
 * same gain/rate/time contract the preview and the browser exporter apply.
 *
 * One chain per run:  [k:a] atrim → asetpts → rate (asetrate|atempo) → volume
 * envelope → adelay(outputStart)  → [rN];  then amix of all runs, padded and
 * trimmed to the exact output length → [aout].
 *
 * Pure string building (no ffmpeg here) so it is unit-tested in node.
 */

import type { AudioRun } from "@/lib/timeline/evaluate";

const f6 = (n: number) => (Math.round(n * 1e6) / 1e6).toFixed(6);
const EPS = 1e-6;

/** Decompose a tempo ratio into atempo stages (each within [0.5, 2]). */
export function atempoChain(rate: number): string[] {
  const parts: string[] = [];
  let r = rate;
  while (r > 2 + 1e-9) {
    parts.push("atempo=2.0");
    r /= 2;
  }
  while (r < 0.5 - 1e-9) {
    parts.push("atempo=0.5");
    r /= 0.5;
  }
  parts.push(`atempo=${r.toFixed(6)}`);
  return parts;
}

/**
 * A `volume` filter whose expression traces the gain breakpoints (linear
 * between) in the run's LOCAL time. Constant gain collapses to a number; unity
 * is omitted.
 */
export function volumeFilter(points: { at: number; gain: number }[], runStart: number): string | null {
  const pts = points.map((p) => ({ t: Math.max(0, p.at - runStart), g: Math.max(0, p.gain) }));
  if (!pts.length) return null;
  const allSame = pts.every((p) => Math.abs(p.g - pts[0].g) < EPS);
  if (allSame) return Math.abs(pts[0].g - 1) < EPS ? null : `volume=${f6(pts[0].g)}`;
  // The plan samples the envelope on a 20 ms grid, so a 6 s track with a fade
  // and ducking arrives as ~300 points. Keep only the BREAKPOINTS (drop points
  // that sit on the line between their neighbours) — the envelope is piecewise
  // linear by construction, so this is lossless — and emit a FLAT sum of
  // segments rather than a nested if(): ffmpeg's expression parser rejected
  // the deeply nested form ("Error initializing filters") above ~100 points,
  // which killed every worker render of a ducked or faded track.
  const keep: { t: number; g: number }[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = keep[keep.length - 1];
    const c = pts[i + 1];
    const b = pts[i];
    const span = c.t - a.t;
    const onLine = span > 1e-9 ? Math.abs(a.g + ((c.g - a.g) * (b.t - a.t)) / span - b.g) < 1e-4 : Math.abs(b.g - a.g) < 1e-4;
    if (!onLine) keep.push(b);
  }
  keep.push(pts[pts.length - 1]);
  const segs: string[] = [];
  for (let i = 0; i < keep.length - 1; i++) {
    const a = keep[i];
    const b = keep[i + 1];
    const span = Math.max(1e-6, b.t - a.t);
    const lerp = Math.abs(b.g - a.g) < EPS ? f6(a.g) : `(${f6(a.g)}+(${f6(b.g)}-${f6(a.g)})*(t-${f6(a.t)})/${f6(span)})`;
    segs.push(`gte(t,${f6(a.t)})*lt(t,${f6(b.t)})*${lerp}`);
  }
  segs.push(`gte(t,${f6(keep[keep.length - 1].t)})*${f6(keep[keep.length - 1].g)}`);
  return `volume='${segs.join("+")}':eval=frame`;
}

export interface SequenceAudioGraphInput {
  runs: AudioRun[];
  /** ffmpeg input index of each asset's file (null = asset has no usable audio → run skipped). */
  inputIndexOf: (assetId: string) => number | null;
  /**
   * Channel count of an asset's audio (0/undefined = unknown). A MONO source is
   * upmixed with an explicit pan so each channel carries the full signal — the
   * default stereo upmix in aformat/aresample applies a -3 dB pan law, which made
   * worker renders 3 dB quieter than the in-browser export of the same mono clip.
   */
  channelsOf?: (assetId: string) => number | undefined;
  sampleRate: number;
  outputDuration: number;
}

/** Null when no run has audio (caller muxes `-an`). */
export function buildSequenceAudioGraph(input: SequenceAudioGraphInput): string | null {
  const chains: string[] = [];
  const labels: string[] = [];
  let n = 0;
  for (const run of input.runs) {
    const idx = input.inputIndexOf(run.assetId);
    if (idx == null) continue;
    const outLen = run.outputEnd - run.outputStart;
    if (outLen <= EPS) continue;
    const rate = run.rate > 0 ? run.rate : 1;
    const filters: string[] = [
      `atrim=start=${f6(run.sourceStart)}:end=${f6(run.sourceStart + outLen * rate)}`,
      "asetpts=PTS-STARTPTS",
    ];
    if (Math.abs(rate - 1) > 1e-4) {
      if (run.pitch === "follow") filters.push(`asetrate=${Math.round(input.sampleRate * rate)}`);
      else filters.push(...atempoChain(rate));
    }
    // Common format for amix: one sample rate, stereo, float planar. Mono is
    // duplicated into both channels at full level (see channelsOf).
    filters.push(`aresample=${input.sampleRate}`);
    if (input.channelsOf?.(run.assetId) === 1) filters.push("pan=stereo|c0=c0|c1=c0");
    filters.push("aformat=sample_fmts=fltp:channel_layouts=stereo");
    const vol = volumeFilter(run.gain, run.outputStart);
    if (vol) filters.push(vol);
    const delayMs = Math.round(run.outputStart * 1000);
    if (delayMs > 0) filters.push(`adelay=${delayMs}:all=1`);
    const label = `r${n++}`;
    chains.push(`[${idx}:a]${filters.join(",")}[${label}]`);
    labels.push(`[${label}]`);
  }
  if (!labels.length) return null;
  const D = f6(input.outputDuration);
  // Several runs mix over a SILENT BASE that spans the whole output. Without
  // it amix stalls when every run is silent at once (a freeze or a gap between
  // clips): the finished run has hit EOF and the delayed one hasn't started, so
  // amix never gets a frame to mix and ffmpeg blocks on its video stdin forever
  // (the encoder watchdog then kills it — "render_stalled"). The base keeps the
  // mixer fed, and `duration=first` pins the length to it.
  const mix =
    labels.length === 1
      ? `${labels[0]}anull`
      : `anullsrc=r=${input.sampleRate}:cl=stereo,atrim=0:${D}[base];[base]${labels.join("")}amix=inputs=${labels.length + 1}:normalize=0:duration=first:dropout_transition=0`;
  chains.push(`${mix},apad,atrim=0:${D},asetpts=PTS-STARTPTS[aout]`);
  return chains.join(";");
}
