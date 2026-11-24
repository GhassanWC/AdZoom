/**
 * The Editframe render loop — the full-parity in-browser exporter.
 *
 * DECODE  : mediabunny `Input`/`VideoSampleSink` per ASSET pulls the frame at an
 *           exact source time (random access, so any item order works).
 * TIMING  : `evaluateTimeline(revision, outputTime)` — the same contract the
 *           worker, Remotion and the preview use — resolves the layer(s),
 *           source times, opacities and overlay-local times per output frame.
 * COMPOSIT: Framevo's shared `composeEvaluatedFrame`.
 * ENCODE  : mediabunny `Output`/`CanvasSource` → MP4/H.264; audio from
 *           `buildSequenceAudio` (the evaluator's audio plan) muxed as AAC.
 *
 * Frame-accurate, not real-time. Progress per frame; cancellation tears the
 * encoder down. Browser-only; imported lazily.
 */
import {
  ALL_FORMATS,
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  UrlSource,
  VideoSampleSink,
} from "mediabunny";
import { composeEvaluatedFrame } from "@/lib/render/compose-frame";
import { evaluateTimeline, layoutOf, planAudio, type EvalLayer } from "@/lib/timeline/evaluate";
import { SOURCE_ASSET_ID } from "@/lib/timeline/sequence";
import { AUDIO_BITRATE_AAC, videoBitrateFor } from "@/components/dashboard/real-editor/export-format";
import { buildSequenceAudio, decodeTrack } from "./audio";
import type { EditframePlan, EditframeProgress } from "./types";

function abortError(): DOMException {
  return new DOMException("Editframe export cancelled", "AbortError");
}

export interface EditframeRenderResult {
  blob: Blob;
  warning?: string;
  videoDurationSec: number;
}

export interface RunEditframeExportOptions {
  onProgress?: (p: EditframeProgress) => void;
  signal?: AbortSignal;
}

interface AssetDecoder {
  input: Input;
  sink: VideoSampleSink | null;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Source time of the frame currently on `canvas` (so a held frame isn't re-decoded). */
  drawnAt: number | null;
}

export async function runEditframeExport(plan: EditframePlan, opts: RunEditframeExportOptions = {}): Promise<EditframeRenderResult> {
  const { onProgress, signal } = opts;
  const { recipe } = plan;
  const fps = plan.fps;
  const { canvasW, canvasH, outputDuration } = recipe;
  const rev = recipe.revision;
  const totalFrames = Math.max(1, Math.round(outputDuration * fps));
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError();
  };
  throwIfAborted();

  const assetUrls: Record<string, string> = { [SOURCE_ASSET_ID]: plan.sourceUrl, ...(plan.assetUrls ?? {}) };
  const layout = layoutOf(rev);
  const referenced = new Set<string>();
  for (const l of layout.items) {
    referenced.add(l.item.assetId);
    if (l.item.kind === "clip" && l.item.audio?.assetId) referenced.add(l.item.audio.assetId);
  }
  for (const tr of rev.sequence?.audioTracks ?? []) referenced.add(tr.assetId);

  // ── Decoders per asset (video sinks are random-access; two scratch canvases suffice per asset) ──
  const decoders = new Map<string, AssetDecoder>();
  const audioBuffers = new Map<string, AudioBuffer>();
  let pitchWarning = false;
  for (const id of referenced) {
    const url = assetUrls[id];
    if (!url) throw new Error(`The sequence uses an asset ("${id}") that isn't available to export.`);
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    let sink: VideoSampleSink | null = null;
    if (vt) {
      if (!(await vt.canDecode())) throw new Error(id === SOURCE_ASSET_ID ? "This recording's video can't be processed in this browser." : `The video of "${id}" can't be processed in this browser.`);
      sink = new VideoSampleSink(vt);
    } else if (id === SOURCE_ASSET_ID) {
      throw new Error("This source has no video track to export.");
    }
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not create the decode canvas (2D context unavailable).");
    decoders.set(id, { input, sink, canvas, ctx, drawnAt: null });
    try {
      const at = await input.getPrimaryAudioTrack();
      if (at && (await at.canDecode())) {
        const buf = await decodeTrack(at, id === SOURCE_ASSET_ID ? rev.sourceDuration : 0);
        if (buf) audioBuffers.set(id, buf);
      }
    } catch (err) {
      console.warn("[editframe] audio decode failed for asset", id, err);
    }
    throwIfAborted();
  }

  // ── Audio (the evaluator's plan) ──────────────────────────────────────────
  let warning: string | undefined;
  let outputAudio: AudioBuffer | null = null;
  try {
    const a = await buildSequenceAudio(planAudio(rev), audioBuffers, outputDuration);
    outputAudio = a.buffer;
    pitchWarning = a.pitchApprox;
    if (!outputAudio && audioBuffers.size === 0 && referenced.has(SOURCE_ASSET_ID)) {
      warning = "This recording's audio couldn't be included, so the export has no sound.";
    }
  } catch (err) {
    console.warn("[editframe] audio build failed — exporting silent", err);
    warning = "Audio couldn't be prepared, so the export has no sound.";
    outputAudio = null;
  }
  if (pitchWarning) warning = warning ?? "Retimed sections keep their original pitch in the browser export.";
  throwIfAborted();

  // ── Output ────────────────────────────────────────────────────────────────
  const outCanvas = document.createElement("canvas");
  outCanvas.width = canvasW;
  outCanvas.height = canvasH;
  const outCtx = outCanvas.getContext("2d", { alpha: false });
  if (!outCtx) throw new Error("Could not create the export canvas (2D context unavailable).");

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const videoSource = new CanvasSource(outCanvas, { codec: "avc", bitrate: videoBitrateFor(plan.resolution, fps), keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: fps });
  let audioSource: AudioBufferSource | null = null;
  if (outputAudio) {
    audioSource = new AudioBufferSource({ codec: "aac", bitrate: AUDIO_BITRATE_AAC });
    output.addAudioTrack(audioSource);
  }
  await output.start();
  if (audioSource && outputAudio) {
    await audioSource.add(outputAudio);
    audioSource.close();
  }

  // A layer's frame: decode the asset at its source time onto that asset's canvas.
  // During a dissolve two different assets are on screen, each with its own canvas;
  // a dissolve between two uses of the SAME asset needs a second canvas for it.
  const spare = document.createElement("canvas");
  const spareCtx = spare.getContext("2d", { alpha: false })!;
  async function frameOf(layer: EvalLayer, useSpare: boolean): Promise<CanvasImageSource | null> {
    const d = decoders.get(layer.assetId);
    if (!d?.sink) return null;
    const canvas = useSpare ? spare : d.canvas;
    const ctx = useSpare ? spareCtx : d.ctx;
    if (!useSpare && d.drawnAt != null && Math.abs(d.drawnAt - layer.sourceTime) < 1 / (fps * 4)) return canvas;
    const sample = await d.sink.getSample(layer.sourceTime);
    if (sample) {
      if (canvas.width !== sample.displayWidth || canvas.height !== sample.displayHeight) {
        canvas.width = sample.displayWidth;
        canvas.height = sample.displayHeight;
      }
      sample.draw(ctx, 0, 0);
      sample.close();
      if (!useSpare) d.drawnAt = layer.sourceTime;
    }
    // A null sample (before the first / after the last frame) holds the last drawn frame.
    return canvas.width ? canvas : null;
  }

  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const frameDur = 1 / fps;
  try {
    for (let i = 0; i < totalFrames; i++) {
      throwIfAborted();
      const outputTime = i / fps;
      const ev = evaluateTimeline(rev, outputTime);
      const frames = new Map<string, CanvasImageSource>();
      const seenAssets = new Set<string>();
      for (const layer of ev.layers) {
        const f = await frameOf(layer, seenAssets.has(layer.assetId));
        seenAssets.add(layer.assetId);
        if (f) frames.set(layer.itemId, f);
      }
      composeEvaluatedFrame(outCtx, ev, (layer) => frames.get(layer.itemId) ?? null, recipe);
      await videoSource.add(outputTime, frameDur);
      const done = i + 1;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const elapsed = now - startedAt;
      onProgress?.({ percent: done / totalFrames, currentFrame: done, totalFrames, etaMs: done > 0 ? (elapsed / done) * (totalFrames - done) : undefined });
    }
  } catch (err) {
    try {
      await output.cancel();
    } catch {
      /* already torn down */
    }
    throw err;
  }

  await output.finalize();
  const buffer = output.target.buffer;
  if (!buffer) throw new Error("The Editframe encoder produced no output.");
  return { blob: new Blob([buffer], { type: "video/mp4" }), warning, videoDurationSec: outputDuration };
}
