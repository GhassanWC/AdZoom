/**
 * Canvas-parity render pipeline. Turns the OUTPUT timeline into frames by
 * decoding the source (FFmpeg), compositing EACH output frame with the SHARED
 * `composeFrame` on an @napi-rs/canvas context (the exact code the browser
 * exporter runs), and piping the composited RGBA into an FFmpeg encoder for
 * H.264/AAC. Cuts + speed are honored via the recipe's timeline map; audio is
 * rebuilt by `buildAudioFilterComplex` from the same segments.
 */
import v8 from "node:v8";
import vm from "node:vm";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { buildRenderRecipe } from "@/lib/render/recipe";
import { composeFrame } from "@/lib/render/compose-frame";
import type { SerializedRenderRecipe } from "@/lib/firebase/schema";
import type { TimelineMap } from "@/lib/timeline/crop-speed";
import {
  probeSource,
  canDecodeAudio,
  canDecodeVideo,
  spawnDecoder,
  spawnEncoder,
  type EncoderAudio,
} from "./ffmpeg.js";
import { buildAudioFilterComplex } from "./audio.js";
import { AUDIO_UNSUPPORTED_WARNING, isUnsupportedAudioCodec } from "./preflight.js";

export type RenderStage = "decoding" | "rendering" | "encoding";

export class CanceledError extends Error {
  constructor() {
    super("Export canceled");
    this.name = "CanceledError";
  }
}

export interface RenderOptions {
  serialized: SerializedRenderRecipe;
  /** Local path of the downloaded source video. */
  sourcePath: string;
  /** Local path to write the MP4 to. */
  outputPath: string;
  crf: number;
  preset: string;
  /** Aborting kills both ffmpeg processes (breaks a hung await) → CanceledError. */
  signal: AbortSignal;
  /**
   * The normalization step already stripped unsupported audio from the source
   * (so the file has no audio). The render then treats it as silent WITHOUT
   * emitting its own "source has no audio" notice — the handler owns the
   * AUDIO_UNSUPPORTED_WARNING in that case (avoids a wrong/duplicate warning).
   */
  audioAlreadyDropped?: boolean;
  onProgress: (p: { stage: RenderStage; progress: number }) => void;
}

/** No frames for this long ⇒ the render is wedged; kill it and fail the job. */
const STALL_MS = 90_000;

/** Cadence (in output frames) for the heartbeat progress + memory log + leak guard. */
const PROGRESS_LOG_EVERY = 250;

/**
 * Force a GC this often (output frames). The composited frame each `getImageData`
 * hands us is @napi-rs/canvas EXTERNAL (skia) memory that V8's GC heuristics
 * under-count — so without a nudge the garbage piles up ~one 8 MB frame per
 * output frame (500 frames → ~4 GB RSS) until the container OOM-restarts. The
 * buffers are unreferenced once ffmpeg accepts the frame; a periodic full GC
 * reclaims them and keeps RSS flat. 50 frames ≈ a small sawtooth, ~sub-percent CPU.
 */
const GC_EVERY = 50;

/**
 * Hard RSS ceiling — a correctly-streaming 1080p / concurrency-1 render plateaus
 * well under ~1.5 GB. Blow past this and we fail fast (`memory_leak_detected`)
 * instead of letting the container OOM-restart in a loop. Override via env.
 */
const MAX_RSS_MB = Number(process.env.RENDER_MAX_RSS_MB) || 4096;

/** Linear-growth tripwire: this much RSS gain on EACH of 3 consecutive
 *  heartbeats (past warmup) means frames aren't being released — fail fast. */
const LEAK_SLOPE_MB = 400;

/**
 * Force-GC handle. Prefer an already-exposed `global.gc` (node --expose-gc);
 * otherwise enable it at runtime (no launch flag needed) via the v8 flag + a
 * fresh VM context. Null only if both are somehow unavailable (then we still
 * have the ceiling/slope guards + bounded buffering as the safety net).
 */
function resolveForceGc(): (() => void) | null {
  try {
    const existing = (globalThis as { gc?: () => void }).gc;
    if (typeof existing === "function") return existing;
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as unknown;
    v8.setFlagsFromString("--no-expose-gc");
    return typeof gc === "function" ? (gc as () => void) : null;
  } catch {
    return null;
  }
}
const forceGc = resolveForceGc();

export interface RenderResult {
  warnings: string[];
  outputWidth: number;
  outputHeight: number;
  fps: number;
}

/** Map an output time to the source time it samples, via the timeline map. */
function sourceTimeForOutput(map: TimelineMap, outputTime: number): number {
  const segs = map.segments;
  for (const s of segs) {
    if (outputTime >= s.outputStart && outputTime < s.outputEnd) {
      const st = s.sourceStart + (outputTime - s.outputStart) * s.speedMultiplier;
      return Math.min(s.sourceEnd, Math.max(s.sourceStart, st));
    }
  }
  // Past the last segment (rounding at the tail) → clamp to its end.
  const last = segs[segs.length - 1];
  return last ? last.sourceEnd : outputTime;
}

export async function renderToMp4(opts: RenderOptions): Promise<RenderResult> {
  const warnings: string[] = [];
  const recipe = buildRenderRecipe({ ...opts.serialized, debugBorders: false });
  const { canvasW, canvasH, sourceWidth, sourceHeight, fps, outputDuration, timelineMap } =
    recipe;

  const info = await probeSource(opts.sourcePath);

  // Fast-fail preflight: if the bundled ffmpeg can't decode even one video frame,
  // the render would otherwise hang until the 90s stall watchdog. Fail NOW with a
  // clear decode error (cheap — a single-frame decode) so the job never wedges.
  if (!(await canDecodeVideo(opts.sourcePath))) {
    console.error("[worker:decode] source video is undecodable — failing fast", {
      videoCodec: info.videoCodec,
      width: info.width,
      height: info.height,
    });
    throw new Error("preflight: source video could not be decoded — no frames were produced");
  }

  // `hasAudio` may be demoted to false below if the source has an audio stream
  // the bundled ffmpeg can't decode — we then export silently rather than let
  // the encoder abort (and the frame writer EPIPE) trying to transcode it.
  let hasAudio = info.hasAudio;
  if (opts.audioAlreadyDropped) {
    // Normalization stripped unsupported audio; the handler already queued the
    // AUDIO_UNSUPPORTED_WARNING. Render silently without a second notice.
    hasAudio = false;
  } else if (!hasAudio) {
    warnings.push(
      "Source has no audio track — the export will be silent. This matches the source."
    );
  } else if (
    isUnsupportedAudioCodec(info.audioCodec, info.audioCodecTag) ||
    !(await canDecodeAudio(opts.sourcePath))
  ) {
    // Unsupported codec (e.g. Apple `apac`, codec_name "none"). The codec-name
    // check is AUTHORITATIVE and short-circuits the decode probe — so apac/none/
    // unknown audio can NEVER reach `direct`/`filter` (which would abort the
    // encoder with "no decoder found"), even if `canDecodeAudio` flakily passes.
    // Drop audio and export silently. AAC/Opus/etc. that genuinely decode are kept.
    hasAudio = false;
    warnings.push(AUDIO_UNSUPPORTED_WARNING);
    console.warn("[worker:audio] audio_dropped_unsupported", {
      codec: info.audioCodec || "(none)",
      tag: info.audioCodecTag || "(none)",
    });
  }

  // One scratch canvas for the decoded source frame, one for the output. Reused
  // every frame (no per-frame allocation churn).
  const srcCanvas = createCanvas(sourceWidth, sourceHeight);
  const srcCtx = srcCanvas.getContext("2d");
  const outCanvas = createCanvas(canvasW, canvasH);
  const outCtx = outCanvas.getContext("2d");
  // Parity tuning point: match the browser's drawImage scaling. The browser
  // leaves smoothing at its enabled default; mirror that here.
  outCtx.imageSmoothingEnabled = true;

  const decoder = spawnDecoder(opts.sourcePath, fps, sourceWidth, sourceHeight);

  // Choose how to source audio. Cuts/speed remap the timeline, so the audio has
  // to be rebuilt from the segments (filter). With NEITHER, the video is the
  // full source linearly → map the source audio straight through (direct):
  // simpler, perfectly in sync, and immune to filtergraph edge cases. This is
  // the common case (e.g. zoom-only edits don't touch the timeline).
  const hasSpeed = recipe.moments.some((m) => m.effectType === "speed-up");
  const hasCuts = timelineMap.totalRemoved > 0;
  let audio: EncoderAudio;
  if (!hasAudio) {
    audio = { kind: "none" };
  } else if (!hasSpeed && !hasCuts) {
    audio = { kind: "direct" };
  } else {
    const fc = buildAudioFilterComplex(
      timelineMap.segments,
      recipe.moments,
      info.audioSampleRate
    );
    audio = fc ? { kind: "filter", filterComplex: fc } : { kind: "direct" };
  }
  console.info("[worker:audio]", {
    hasAudio,
    mode: audio.kind,
    hasSpeed,
    hasCuts,
    segments: timelineMap.segments.length,
    sampleRate: info.audioSampleRate,
  });

  const encoder = await spawnEncoder({
    width: canvasW,
    height: canvasH,
    fps,
    outputPath: opts.outputPath,
    sourcePath: opts.sourcePath,
    audio,
    crf: opts.crf,
    preset: opts.preset,
  });

  const totalFrames = Math.max(1, Math.round(outputDuration * fps));
  const frameBytes = sourceWidth * sourceHeight * 4;

  let decodedIndex = -1;
  let currentFrame: Buffer | null = null;
  let eof = false;

  /** Advance the decoder to the frame nearest `sourceTime` (forward-only). */
  async function frameForSourceTime(sourceTime: number): Promise<Buffer | null> {
    const targetIndex = Math.round(sourceTime * fps);
    while (!eof && decodedIndex < targetIndex) {
      const f = await decoder.reader.next();
      if (f === null) {
        eof = true;
        break;
      }
      currentFrame = f;
      decodedIndex++;
    }
    return currentFrame;
  }

  // Aborting (cancel) OR a stall both kill the ffmpeg processes, which unblocks
  // any pending decoder read / encoder write so the loop can't wedge forever.
  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const killBoth = () => {
    decoder.kill();
    encoder.kill();
  };
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      killBoth();
    }, STALL_MS);
  };
  const onAbort = () => killBoth();
  opts.signal.addEventListener("abort", onAbort);

  let lastPct = -1;
  const renderStartMs = Date.now();
  // Recent RSS samples (one per heartbeat) for the linear-growth tripwire.
  const rssSamples: number[] = [];
  try {
    if (opts.signal.aborted) throw new CanceledError();
    console.info("[worker:render-start]", {
      canvasW,
      canvasH,
      fps,
      totalFrames,
      audio: audio.kind,
    });
    // Nudge the UI off 0% while the first frame decodes (it can take a moment on
    // a big GOP) — without this the bar looks frozen between "downloading" and
    // the first rendered frame.
    opts.onProgress({ stage: "decoding", progress: 0.01 });
    armWatchdog();
    for (let i = 0; i < totalFrames; i++) {
      if (opts.signal.aborted) throw new CanceledError();

      const pct = Math.floor((i / totalFrames) * 95);
      if (pct !== lastPct) {
        lastPct = pct;
        opts.onProgress({ stage: "rendering", progress: pct / 100 });
      }

      // Reclaim the external composited-frame buffers before they pile up. They
      // were handed to ffmpeg + dereferenced already; a periodic full GC keeps
      // RSS flat instead of growing one ~8 MB frame per output frame.
      if (forceGc && i > 0 && i % GC_EVERY === 0) forceGc();

      // Heartbeat progress + memory every N frames — proves the render is
      // advancing AND that frames are being streamed (queue stays at 1–3, RSS
      // plateaus). A runaway is failed fast as `memory_leak_detected` rather than
      // left to OOM-restart the container mid-render.
      if (i > 0 && i % PROGRESS_LOG_EVERY === 0) {
        const mem = process.memoryUsage();
        const rssMB = Math.round(mem.rss / 1048576);
        const queueLen = decoder.reader.bufferedFrames();
        console.info("[worker:progress]", {
          frame: i,
          totalFrames,
          pct,
          queueLen,
          rssMB,
          heapUsedMB: Math.round(mem.heapUsed / 1048576),
          externalMB: Math.round(mem.external / 1048576),
        });

        // (a) Hard ceiling.
        if (rssMB > MAX_RSS_MB) {
          throw new Error(
            `memory_leak_detected: RSS ${rssMB}MB exceeded ${MAX_RSS_MB}MB at frame ${i}/${totalFrames} — frames are not being released to ffmpeg`
          );
        }
        // (b) Linear-growth tripwire — RSS climbing by > LEAK_SLOPE_MB on each of
        // the last 3 heartbeats (past warmup) means it isn't stabilizing.
        rssSamples.push(rssMB);
        if (rssSamples.length >= 4) {
          const [a, b, c, d] = rssSamples.slice(-4);
          if (b - a > LEAK_SLOPE_MB && c - b > LEAK_SLOPE_MB && d - c > LEAK_SLOPE_MB) {
            throw new Error(
              `memory_leak_detected: RSS rising ${a}→${b}→${c}→${d}MB across heartbeats — frames are not being released to ffmpeg`
            );
          }
        }
      }

      const outputTime = i / fps;
      const sourceTime = sourceTimeForOutput(timelineMap, outputTime);
      const frame = await frameForSourceTime(sourceTime);
      if (i === 0) {
        console.info("[worker:first-decoded-frame]", {
          afterMs: Date.now() - renderStartMs,
          decodedToIndex: decodedIndex,
        });
      }

      if (frame && frame.length === frameBytes) {
        srcCtx.putImageData(
          new ImageData(
            new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.length),
            sourceWidth,
            sourceHeight
          ),
          0,
          0
        );
      }
      // If `frame` is null (decoder underran), the previous frame stays on the
      // scratch canvas — a 1-frame hold at the tail rather than a black flash.

      composeFrame(
        outCtx as unknown as CanvasRenderingContext2D,
        srcCanvas as unknown as CanvasImageSource,
        recipe,
        sourceTime
      );
      if (i === 0) {
        console.info("[worker:first-composed-frame]", { afterMs: Date.now() - renderStartMs });
      }

      // Read the composited frame via canvas.data() (a fresh, owned RGBA copy) —
      // NOT getImageData. @napi-rs/canvas's getImageData leaks ~one frame of
      // native (skia) memory PER CALL, invisible to V8/GC, which OOM-kills a long
      // render (~8 MB/frame at 1080p). canvas.data() returns the SAME RGBA bytes
      // with no such leak (verified) and is GC-tracked, so it streams cleanly.
      const composited = outCanvas.data();
      await encoder.writeFrame(composited);
      if (i === 0) {
        // First frame accepted by the encoder — the pipeline is flowing.
        console.info("[worker:first-frame]", { afterMs: Date.now() - renderStartMs });
      }
      armWatchdog(); // progress was made — reset the stall timer
    }

    opts.onProgress({ stage: "encoding", progress: 0.97 });
    await encoder.finish();
    decoder.kill();
    console.info("[worker:complete]", {
      outputWidth: canvasW,
      outputHeight: canvasH,
      fps,
      frames: totalFrames,
      elapsedMs: Date.now() - renderStartMs,
      warnings: warnings.length,
    });
    return { warnings, outputWidth: canvasW, outputHeight: canvasH, fps };
  } catch (err) {
    killBoth();
    if (opts.signal.aborted) throw new CanceledError();
    if (stalled) {
      throw new Error(
        "Render stalled — no frames were produced within the timeout. The source video may be unreadable or in an unsupported format."
      );
    }
    throw err;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    opts.signal.removeEventListener("abort", onAbort);
  }
}
