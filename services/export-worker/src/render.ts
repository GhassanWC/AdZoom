/**
 * Canvas-parity render pipeline. Turns the OUTPUT timeline into frames by
 * decoding the source (FFmpeg), compositing EACH output frame with the SHARED
 * `composeFrame` on an @napi-rs/canvas context (the exact code the browser
 * exporter runs), and piping the composited RGBA into an FFmpeg encoder for
 * H.264/AAC. Cuts + speed are honored via the recipe's timeline map; audio is
 * rebuilt by `buildAudioFilterComplex` from the same segments.
 */
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { buildRenderRecipe } from "@/lib/render/recipe";
import { composeFrame } from "@/lib/render/compose-frame";
import type { SerializedRenderRecipe } from "@/lib/firebase/schema";
import type { TimelineMap } from "@/lib/timeline/crop-speed";
import {
  probeSource,
  canDecodeAudio,
  spawnDecoder,
  spawnEncoder,
  type EncoderAudio,
} from "./ffmpeg.js";
import { buildAudioFilterComplex } from "./audio.js";

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
  onProgress: (p: { stage: RenderStage; progress: number }) => void;
}

/** No frames for this long ⇒ the render is wedged; kill it and fail the job. */
const STALL_MS = 90_000;

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
  // `hasAudio` may be demoted to false below if the source has an audio stream
  // the bundled ffmpeg can't decode — we then export silently rather than let
  // the encoder abort (and the frame writer EPIPE) trying to transcode it.
  let hasAudio = info.hasAudio;
  if (!hasAudio) {
    warnings.push(
      "Source has no audio track — the export will be silent. This matches the source."
    );
  } else if (!(await canDecodeAudio(opts.sourcePath))) {
    // Unsupported codec (e.g. Apple `apac`). No decoder ⇒ no transcode possible,
    // so drop audio and tell the user. Keep working for AAC/Opus/etc., which
    // pass the decode test above.
    hasAudio = false;
    const codec = info.audioCodec || info.audioCodecTag || "unknown";
    warnings.push(
      `Source audio codec "${codec}" is unsupported, exported without audio.`
    );
    console.warn("[worker:audio] unsupported codec — exporting silent", {
      codec: info.audioCodec,
      tag: info.audioCodecTag,
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
  try {
    if (opts.signal.aborted) throw new CanceledError();
    armWatchdog();
    for (let i = 0; i < totalFrames; i++) {
      if (opts.signal.aborted) throw new CanceledError();

      const pct = Math.floor((i / totalFrames) * 95);
      if (pct !== lastPct) {
        lastPct = pct;
        opts.onProgress({ stage: "rendering", progress: pct / 100 });
      }

      const outputTime = i / fps;
      const sourceTime = sourceTimeForOutput(timelineMap, outputTime);
      const frame = await frameForSourceTime(sourceTime);

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

      const img = outCtx.getImageData(0, 0, canvasW, canvasH);
      await encoder.writeFrame(
        Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength)
      );
      armWatchdog(); // progress was made — reset the stall timer
    }

    opts.onProgress({ stage: "encoding", progress: 0.97 });
    await encoder.finish();
    decoder.kill();
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
