/**
 * Sequence render — the worker's multi-source path.
 *
 * Same contract as `renderToMp4` (canvas compositing + ffmpeg encode), driven
 * by `evaluateTimeline` instead of the single-source timeline map:
 *
 *   per output frame → evaluateTimeline(revision, t)
 *                    → one ffmpeg decoder PER SEQUENCE ITEM (opened when the
 *                      item first shows, forward-only inside it, closed when it
 *                      ends — so reordered or repeated uses of one asset never
 *                      need a backwards seek, and a freeze decodes one frame)
 *                    → composeEvaluatedFrame (layers, fades, dissolves, overlays)
 *                    → encoder stdin.
 *
 * Audio is one ffmpeg filter graph built from `planAudio` (every asset with a
 * usable track is an encoder input), so gain, fades, crossfades, ducking and
 * ramps are the evaluator's numbers, not a second implementation.
 */

import { createCanvas, ImageData, type Canvas } from "@napi-rs/canvas";
import { composeEvaluatedFrame } from "@/lib/render/compose-frame";
import type { RenderRecipe } from "@/lib/render/recipe";
import { buildSequenceAudioGraph } from "@/lib/render/audio-filtergraph";
import { evaluateTimeline, layoutOf, planAudio, type EvalLayer } from "@/lib/timeline/evaluate";
import { SOURCE_ASSET_ID, itemSourceTimeAt, type LaidOutItem } from "@/lib/timeline/sequence";
import { fromTicks } from "@/lib/timeline/ticks";
import { canDecodeAudio, isUnsupportedAudioCodec, probeSource, spawnDecoder, spawnEncoder, type Decoder, type EncoderAudio } from "./ffmpeg.js";
import { CanceledError, type RenderOptions, type RenderResult } from "./render.js";

const STALL_MS = 90_000;

interface ItemDecoder {
  decoder: Decoder;
  /** Source second of the decoder's first frame. */
  startSec: number;
  decodedK: number;
  current: Buffer | null;
  eof: boolean;
  frozen: boolean;
}

export async function renderSequenceToMp4(opts: RenderOptions, recipe: RenderRecipe): Promise<RenderResult> {
  if (opts.chunk) throw new Error("chunk_unsupported_sequence: a multi-source sequence renders as one pass (no chunking).");
  const warnings: string[] = [];
  const { canvasW, canvasH, sourceWidth, sourceHeight, fps, outputDuration } = recipe;
  const rev = recipe.revision;
  const assetPaths: Record<string, string> = { [SOURCE_ASSET_ID]: opts.sourcePath, ...(opts.assetPaths ?? {}) };
  const layout = layoutOf(rev);

  // Probe every referenced asset once: dimensions (for aspect-preserving fit)
  // and whether its audio can feed the mix.
  const referenced = new Set<string>();
  for (const l of layout.items) {
    referenced.add(l.item.assetId);
    if (l.item.kind === "clip" && l.item.audio?.assetId) referenced.add(l.item.audio.assetId);
  }
  for (const tr of rev.sequence?.audioTracks ?? []) referenced.add(tr.assetId);
  const probes = new Map<string, { width: number; height: number; audio: boolean; sampleRate: number }>();
  for (const id of referenced) {
    const path = assetPaths[id];
    if (!path) throw new Error(`missing_asset: no local file for asset "${id}"`);
    const info = await probeSource(path);
    let audio = info.hasAudio && !(id === SOURCE_ASSET_ID && opts.audioAlreadyDropped);
    if (audio && (isUnsupportedAudioCodec(info.audioCodec, info.audioCodecTag) || !(await canDecodeAudio(path)))) {
      audio = false;
      warnings.push(`The audio of "${id}" couldn't be decoded and was left out of the mix.`);
    }
    probes.set(id, { width: info.width, height: info.height, audio, sampleRate: info.audioSampleRate || 48000 });
  }

  // ── Audio graph ───────────────────────────────────────────────────────────
  const audioInputs: string[] = [];
  const inputIndex = new Map<string, number>();
  for (const [id, p] of probes) {
    if (!p.audio) continue;
    inputIndex.set(id, 1 + audioInputs.length); // input 0 = rawvideo stdin
    audioInputs.push(assetPaths[id]);
  }
  const SAMPLE_RATE = 48000;
  const graph = buildSequenceAudioGraph({ runs: planAudio(rev), inputIndexOf: (id) => inputIndex.get(id) ?? null, sampleRate: SAMPLE_RATE, outputDuration });
  const audio: EncoderAudio = graph ? { kind: "graph", filterComplex: graph, inputs: audioInputs } : { kind: "none" };
  if (!graph) warnings.push("No audible track in this sequence — the export is silent.");
  console.info("[worker:audio]", { mode: audio.kind, inputs: audioInputs.length, runs: graph ? graph.split(";").length - 1 : 0 });

  // ── Canvases ──────────────────────────────────────────────────────────────
  const outCanvas = createCanvas(canvasW, canvasH);
  const outCtx = outCanvas.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  const scratch: Canvas[] = [createCanvas(sourceWidth, sourceHeight), createCanvas(sourceWidth, sourceHeight)];
  const frameBytes = sourceWidth * sourceHeight * 4;

  const encoder = await spawnEncoder({ width: canvasW, height: canvasH, fps, outputPath: opts.outputPath, sourcePath: opts.sourcePath, audio, crf: opts.crf, preset: opts.preset, videoEncoder: opts.videoEncoder });

  // ── Decoders per item ─────────────────────────────────────────────────────
  const decoders = new Map<string, ItemDecoder>();
  const open = (l: LaidOutItem): ItemDecoder => {
    const hit = decoders.get(l.item.id);
    if (hit) return hit;
    const path = assetPaths[l.item.assetId];
    const p = probes.get(l.item.assetId)!;
    const fit = l.item.assetId !== SOURCE_ASSET_ID && (p.width !== sourceWidth || p.height !== sourceHeight);
    const frozen = l.item.kind === "freeze";
    const startSec = frozen ? l.item.sourceAt : Math.max(0, itemSourceTimeAt(l, l.start));
    const endSec = frozen ? startSec : itemSourceTimeAt(l, l.end);
    const decoder = spawnDecoder(path, fps, sourceWidth, sourceHeight, startSec > 0 ? startSec : undefined, {
      durationSec: frozen ? 1 / fps + 0.05 : Math.max(0.1, endSec - startSec + 2 / fps),
      fit: fit ? "pad" : "stretch",
    });
    const d: ItemDecoder = { decoder, startSec, decodedK: -1, current: null, eof: false, frozen };
    decoders.set(l.item.id, d);
    return d;
  };
  const close = (itemId: string) => {
    const d = decoders.get(itemId);
    if (!d) return;
    d.decoder.kill();
    decoders.delete(itemId);
  };
  async function frameFor(d: ItemDecoder, sourceTime: number): Promise<Buffer | null> {
    const k = d.frozen ? 0 : Math.max(0, Math.round((sourceTime - d.startSec) * fps));
    while (!d.eof && d.decodedK < k) {
      const f = await d.decoder.reader.next();
      if (f === null) {
        d.eof = true;
        break;
      }
      d.current = f;
      d.decodedK++;
    }
    return d.current;
  }

  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const killAll = () => {
    for (const d of decoders.values()) d.decoder.kill();
    encoder.kill();
  };
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      killAll();
    }, STALL_MS);
  };
  const onAbort = () => killAll();
  opts.signal.addEventListener("abort", onAbort);

  const totalFrames = Math.max(1, Math.round(outputDuration * fps));
  const byItem = new Map(layout.items.map((l) => [l.item.id, l]));
  let lastPct = -1;
  const t0 = Date.now();
  try {
    if (opts.signal.aborted) throw new CanceledError();
    console.info("[worker:render-start]", { canvasW, canvasH, fps, totalFrames, audio: audio.kind, items: layout.items.length, mode: "sequence" });
    opts.onProgress({ stage: "decoding", progress: 0.01 });
    armWatchdog();
    for (let i = 0; i < totalFrames; i++) {
      if (opts.signal.aborted) throw new CanceledError();
      if (stalled) throw new Error("render_stalled: no frame produced for 90s");
      const t = i / fps;
      const ev = evaluateTimeline(rev, t);
      // Release decoders of items that have ended.
      for (const id of [...decoders.keys()]) {
        const l = byItem.get(id);
        if (l && t >= fromTicks(l.end) + 1 / fps) close(id);
      }
      const frames = new Map<string, Canvas>();
      for (let li = 0; li < ev.layers.length && li < scratch.length; li++) {
        const layer: EvalLayer = ev.layers[li];
        const l = byItem.get(layer.itemId)!;
        const d = open(l);
        const buf = await frameFor(d, layer.sourceTime);
        if (buf && buf.length === frameBytes) {
          scratch[li].getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), sourceWidth, sourceHeight), 0, 0);
          frames.set(layer.itemId, scratch[li]);
        } else if (buf) frames.set(layer.itemId, scratch[li]);
      }
      composeEvaluatedFrame(outCtx as unknown as CanvasRenderingContext2D, ev, (layer) => (frames.get(layer.itemId) as unknown as CanvasImageSource) ?? null, recipe);
      await encoder.writeFrame(outCanvas.data());
      armWatchdog();
      const pct = Math.floor((i / totalFrames) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        opts.onProgress({ stage: "rendering", progress: 0.02 + 0.95 * (i / totalFrames) });
      }
    }
    opts.onProgress({ stage: "encoding", progress: 0.97 });
    await encoder.finish();
    for (const id of [...decoders.keys()]) close(id);
    console.info("[worker:render-done]", { ms: Date.now() - t0, frames: totalFrames, mode: "sequence" });
    opts.onProgress({ stage: "encoding", progress: 1 });
    return { warnings, outputWidth: canvasW, outputHeight: canvasH, fps };
  } catch (err) {
    killAll();
    if (opts.signal.aborted) throw new CanceledError();
    throw err;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    opts.signal.removeEventListener("abort", onAbort);
  }
}
