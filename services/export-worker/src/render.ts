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
import { SUPPORTED_CHUNK_EFFECT_TYPES } from "@/lib/export/chunk-plan";
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
  /**
   * Chunked render of a long video. RENDER the OUTPUT window [renderStartSec,
   * renderEndSec) but EMIT only [trimStartSec, trimEndSec) to `outputPath`. The
   * pad frames outside the trim window (renderStart..trimStart, trimEnd..renderEnd)
   * are decoded/composited for temporal warm-up ONLY and are NEVER written to the
   * encoder — so the emitted clip starts on an IDR keyframe and concats losslessly.
   * Output time is mapped to SOURCE time via the recipe's timeline map, so cuts +
   * speed are fully supported (NOT just linear). Chunks are ALWAYS silent: final
   * audio is composed once, globally, after the video chunks are concatenated
   * (see the CLI `audiomux` mode). Undefined ⇒ render the whole video (default).
   */
  chunk?: {
    /** 0-based chunk index (diagnostics/logs only). */
    index?: number;
    renderStartSec: number;
    renderEndSec: number;
    trimStartSec: number;
    trimEndSec: number;
  };
  onProgress: (p: { stage: RenderStage; progress: number }) => void;
}

/** No frames for this long ⇒ the render is wedged; kill it and fail the job. */
const STALL_MS = 90_000;

/** Cadence (in output frames) for the heartbeat progress + memory log + leak guard. */
const PROGRESS_LOG_EVERY = 250;

/** Wall-clock cadence (ms) for the rich render-progress log — so progress stays
 *  VISIBLE in the orchestrator logs even when a single frame is slow (a high-res
 *  upscale can render < PROGRESS_LOG_EVERY frames between heartbeats). */
const CHUNK_PROGRESS_LOG_MS = 10_000;

/** Warn once if render throughput stays below this (fps) past warmup. */
const LOW_FPS_WARN = 1;

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

  // Chunk render window (OUTPUT seconds). The decoder seeks to the SOURCE time the
  // chunk's first RENDERED output frame samples (mapped via the timeline map) so
  // cuts + speed work — NOT just linear. Whole-video render seeks to 0.
  const renderStartSec = opts.chunk ? Math.max(0, opts.chunk.renderStartSec) : 0;
  const seekSourceTime = opts.chunk ? sourceTimeForOutput(timelineMap, renderStartSec) : 0;
  const decoder = spawnDecoder(
    opts.sourcePath,
    fps,
    sourceWidth,
    sourceHeight,
    opts.chunk ? seekSourceTime : undefined
  );

  // Choose how to source audio. Cuts/speed remap the timeline, so the audio has
  // to be rebuilt from the segments (filter). With NEITHER, the video is the
  // full source linearly → map the source audio straight through (direct):
  // simpler, perfectly in sync, and immune to filtergraph edge cases. This is
  // the common case (e.g. zoom-only edits don't touch the timeline).
  const hasSpeed = recipe.moments.some((m) => m.effectType === "speed-up");
  const hasCuts = timelineMap.totalRemoved > 0;

  // ── Chunk backstop (fail-closed) ────────────────────────────────────────────
  // Cuts + speed ARE chunkable: each output frame is mapped to source time via the
  // timeline map, so a chunk renders the correct edited window. The ONLY thing a
  // chunk can't reproduce is an effect TYPE outside the allowlist (e.g. a future
  // transition that reads neighbor frames). The app's eligibility gate
  // (chunk-plan.ts) already refuses those; this mirrors that allowlist so a stale/
  // buggy caller can never slip an unsupported effect into a chunk task.
  if (opts.chunk) {
    const supported = new Set<string>(SUPPORTED_CHUNK_EFFECT_TYPES);
    const unsupported = [
      ...new Set(recipe.moments.map((m) => m.effectType as string)),
    ].filter((t) => !supported.has(t));
    if (unsupported.length > 0) {
      throw new Error(
        `chunk_unsupported_effects: timeline has effect types the chunk renderer can't reproduce: ${unsupported.join(", ")}`
      );
    }
  }

  // Audio source. Chunks are ALWAYS silent — final audio is composed once over the
  // WHOLE timeline after the video chunks are concatenated (CLI `audiomux`). For a
  // whole-video render: no cuts/speed → map the source audio straight through
  // ("direct"); otherwise rebuild it from the timeline segments ("filter").
  let audio: EncoderAudio;
  if (opts.chunk || !hasAudio) {
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
    chunked: !!opts.chunk,
    hasSpeed,
    hasCuts,
    segments: timelineMap.segments.length,
    sampleRate: info.audioSampleRate,
  });

  const totalFrames = Math.max(1, Math.round(outputDuration * fps));
  // Two windows (integer OUTPUT frames so chunks tile exactly at the seams):
  //   RENDER window — frames we decode/composite, incl. boundary-padding warm-up.
  //   TRIM (emit) window — frames we actually WRITE to the encoder.
  // Without a chunk both are the full span [0, totalFrames).
  const renderStartFrame = opts.chunk
    ? Math.min(totalFrames, Math.max(0, Math.round(renderStartSec * fps)))
    : 0;
  const renderEndFrame = opts.chunk
    ? Math.min(totalFrames, Math.round(opts.chunk.renderEndSec * fps))
    : totalFrames;
  const trimStartFrame = opts.chunk
    ? Math.min(totalFrames, Math.max(0, Math.round(opts.chunk.trimStartSec * fps)))
    : 0;
  const trimEndFrame = opts.chunk
    ? Math.min(totalFrames, Math.round(opts.chunk.trimEndSec * fps))
    : totalFrames;
  const renderWindowFrames = Math.max(1, renderEndFrame - renderStartFrame);
  const emittedFrames = Math.max(1, trimEndFrame - trimStartFrame);

  const encoder = await spawnEncoder({
    width: canvasW,
    height: canvasH,
    fps,
    outputPath: opts.outputPath,
    sourcePath: opts.sourcePath,
    // Chunks are silent (audio is muxed globally after concat) ⇒ no audioWindow.
    audio,
    crf: opts.crf,
    preset: opts.preset,
  });

  const frameBytes = sourceWidth * sourceHeight * 4;

  // The decoder was accurately input-seeked to `seekSourceTime`, so its FIRST
  // emitted frame is the SOURCE frame at that time. Seed the absolute source-frame
  // counter to one before it; frameForSourceTime advances it forward (forward-only,
  // valid because source time is monotonic in output time across the timeline).
  let decodedIndex = Math.round(seekSourceTime * fps) - 1;
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
  let wroteFirstFrame = false;
  let writtenFrames = 0;
  const renderStartMs = Date.now();
  // Rich render-progress (wall-clock) + diagnostics state.
  const chunkIndex = opts.chunk?.index ?? -1;
  const decodedStartIndex = Math.round(seekSourceTime * fps); // source frame the seek lands on
  let lastChunkLogMs = renderStartMs;
  let lowFpsWarned = false;
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
      chunked: !!opts.chunk,
      ...(opts.chunk
        ? {
            renderWindow: [renderStartFrame, renderEndFrame],
            trimWindow: [trimStartFrame, trimEndFrame],
            seekSourceTime: Number(seekSourceTime.toFixed(3)),
          }
        : {}),
    });
    // Nudge the UI off 0% while the first frame decodes (it can take a moment on
    // a big GOP) — without this the bar looks frozen between "downloading" and
    // the first rendered frame.
    opts.onProgress({ stage: "decoding", progress: 0.01 });
    armWatchdog();
    for (let i = renderStartFrame; i < renderEndFrame; i++) {
      if (opts.signal.aborted) throw new CanceledError();

      // Progress is reported RELATIVE to this render's window (0..95), so a chunk
      // reads 0→95% over its own frames (the orchestrator scales it across chunks).
      const pct = Math.floor(((i - renderStartFrame) / renderWindowFrames) * 95);
      if (pct !== lastPct) {
        lastPct = pct;
        opts.onProgress({ stage: "rendering", progress: pct / 100 });
      }

      // Rich render-progress on a WALL-CLOCK cadence (every CHUNK_PROGRESS_LOG_MS)
      // so a slow high-res chunk still reports progress + render throughput, and
      // so it's clear the chunk is rendering its OUTPUT window (not the whole video).
      const nowMs = Date.now();
      if (nowMs - lastChunkLogMs >= CHUNK_PROGRESS_LOG_MS) {
        lastChunkLogMs = nowMs;
        const framesRendered = i - renderStartFrame;
        const elapsedSeconds = (nowMs - renderStartMs) / 1000;
        const renderFps = elapsedSeconds > 0 ? framesRendered / elapsedSeconds : 0;
        const remaining = renderFps > 0 ? (renderWindowFrames - framesRendered) / renderFps : -1;
        console.info("[worker:chunk-progress]", {
          chunkIndex,
          outputStart: Number((opts.chunk?.trimStartSec ?? 0).toFixed(2)),
          outputEnd: Number((opts.chunk?.trimEndSec ?? outputDuration).toFixed(2)),
          sourceSeekTime: Number(seekSourceTime.toFixed(2)),
          framesExpected: renderWindowFrames,
          framesRendered,
          renderFps: Number(renderFps.toFixed(2)),
          elapsedSeconds: Number(elapsedSeconds.toFixed(1)),
          estimatedRemainingSeconds: remaining < 0 ? null : Number(remaining.toFixed(1)),
        });
        // Diagnostic: extremely low throughput (a chunk this slow won't finish in
        // its task budget — surfaces a perf problem instead of a silent hang).
        if (!lowFpsWarned && elapsedSeconds > 30 && renderFps > 0 && renderFps < LOW_FPS_WARN) {
          lowFpsWarned = true;
          console.warn("[worker:chunk-diag] render_fps_extremely_low", {
            chunkIndex,
            renderFps: Number(renderFps.toFixed(2)),
            framesRendered,
            framesExpected: renderWindowFrames,
          });
        }
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
      if (i === renderStartFrame) {
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
      if (i === renderStartFrame) {
        console.info("[worker:first-composed-frame]", { afterMs: Date.now() - renderStartMs });
      }

      // EMIT only the trim window. Pad frames (outside [trimStartFrame, trimEndFrame))
      // are composited for temporal warm-up but MUST NOT reach the encoder — the
      // chunk's first WRITTEN frame must be `trimStartFrame` so libx264 makes it an
      // IDR and the chunks concat losslessly. With padding 0 every rendered frame
      // is emitted.
      if (i >= trimStartFrame && i < trimEndFrame) {
        // Read the composited frame via canvas.data() (a fresh, owned RGBA copy) —
        // NOT getImageData. @napi-rs/canvas's getImageData leaks ~one frame of
        // native (skia) memory PER CALL, invisible to V8/GC, which OOM-kills a long
        // render (~8 MB/frame at 1080p). canvas.data() returns the SAME RGBA bytes
        // with no such leak (verified) and is GC-tracked, so it streams cleanly.
        const composited = outCanvas.data();
        await encoder.writeFrame(composited);
        writtenFrames++;
        if (!wroteFirstFrame) {
          // First frame accepted by the encoder — the pipeline is flowing.
          wroteFirstFrame = true;
          console.info("[worker:first-frame]", { afterMs: Date.now() - renderStartMs });
        }
      }
      armWatchdog(); // progress was made — reset the stall timer
    }

    opts.onProgress({ stage: "encoding", progress: 0.97 });
    await encoder.finish();
    decoder.kill();
    const elapsedMs = Date.now() - renderStartMs;
    const renderFps = elapsedMs > 0 ? writtenFrames / (elapsedMs / 1000) : 0;
    if (opts.chunk) {
      // Integrity: a chunk must EMIT exactly its trim window (and decode FROM the
      // seek point, not source 0). Surface both so "rendering outside the window"
      // is impossible to miss.
      console.info("[worker:chunk-complete]", {
        chunkIndex,
        outputStart: Number(opts.chunk.trimStartSec.toFixed(2)),
        outputEnd: Number(opts.chunk.trimEndSec.toFixed(2)),
        sourceSeekTime: Number(seekSourceTime.toFixed(2)),
        framesExpected: emittedFrames,
        framesEmitted: writtenFrames,
        framesRendered: renderWindowFrames,
        decodedFromIndex: decodedStartIndex,
        decodedToIndex: decodedIndex,
        chunkDurationSec: Number((writtenFrames / fps).toFixed(2)),
        renderFps: Number(renderFps.toFixed(2)),
        elapsedSeconds: Number((elapsedMs / 1000).toFixed(1)),
      });
      // Diagnostic: emitted more than the trim window (off-by-one / overrun).
      if (writtenFrames > emittedFrames * 1.05) {
        console.warn("[worker:chunk-diag] frames_emitted_exceeds_expected", {
          chunkIndex,
          framesEmitted: writtenFrames,
          framesExpected: emittedFrames,
        });
      }
    }
    console.info("[worker:complete]", {
      outputWidth: canvasW,
      outputHeight: canvasH,
      fps,
      frames: totalFrames,
      ...(opts.chunk ? { emittedFrames, renderedFrames: renderWindowFrames } : {}),
      renderFps: Number(renderFps.toFixed(2)),
      elapsedMs,
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
