/**
 * The Editframe BETA render loop — the full-parity browser bridge.
 *
 * DECODE  : mediabunny `Input`/`VideoSampleSink` (Editframe's decode stack) pulls
 *           the source frame at an exact source time.
 * COMPOSIT: Framevo's SHARED `composeFrame(ctx, frame, recipe, sourceTime)` draws
 *           every enabled edit — identical to the Cloud/Remotion worker.
 * ENCODE  : mediabunny `Output`/`CanvasSource` (Editframe's encode stack) encodes
 *           the composited canvas to MP4/H.264; audio is muxed as AAC.
 *
 * Frame-accurate (like the worker), not real-time — so cuts/speed/overlays can
 * never desync. Progress is reported per frame; cancellation is an `AbortSignal`
 * that tears the encoder down (`output.cancel()`). Browser-only; imported lazily.
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
import { composeFrame } from "@/lib/render/compose-frame";
import { sourceTimeForOutput } from "@/lib/timeline/crop-speed";
import {
  AUDIO_BITRATE_AAC,
  videoBitrateFor,
} from "@/components/dashboard/real-editor/export-format";
import { buildOutputAudioBuffer } from "./audio";
import type { EditframePlan, EditframeProgress } from "./types";

function abortError(): DOMException {
  return new DOMException("Editframe export cancelled", "AbortError");
}

export interface EditframeRenderResult {
  blob: Blob;
  /** Non-fatal notice (silent audio / pitch-correct fallback), if any. */
  warning?: string;
  /** Output (post cuts/speed) duration, seconds — for analytics. */
  videoDurationSec: number;
}

export interface RunEditframeExportOptions {
  onProgress?: (p: EditframeProgress) => void;
  signal?: AbortSignal;
}

export async function runEditframeExport(
  plan: EditframePlan,
  opts: RunEditframeExportOptions = {}
): Promise<EditframeRenderResult> {
  const { onProgress, signal } = opts;
  const { recipe } = plan;
  const fps = plan.fps;
  const { canvasW, canvasH, timelineMap, outputDuration } = recipe;
  const totalFrames = Math.max(1, Math.round(outputDuration * fps));
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError();
  };

  throwIfAborted();

  // ── Decode (Editframe / mediabunny) ──────────────────────────────────────
  const input = new Input({ source: new UrlSource(plan.sourceUrl), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    throw new Error("This source has no video track to export.");
  }
  if (!(await videoTrack.canDecode())) {
    throw new Error(
      "This recording's video can't be processed in this browser."
    );
  }
  const videoSink = new VideoSampleSink(videoTrack);

  // ── Compose target + source scratch canvas ───────────────────────────────
  const outCanvas = document.createElement("canvas");
  outCanvas.width = canvasW;
  outCanvas.height = canvasH;
  const outCtx = outCanvas.getContext("2d", { alpha: false });
  if (!outCtx) throw new Error("Could not create the export canvas (2D context unavailable).");

  // The full source frame is drawn here (rotation-aware) so `composeFrame` can
  // sample its Frame-Crop sub-rect exactly like it does off an <video> element.
  const srcCanvas = document.createElement("canvas");
  const srcCtx = srcCanvas.getContext("2d", { alpha: false });
  if (!srcCtx) throw new Error("Could not create the decode canvas (2D context unavailable).");
  let srcSized = false;

  // ── Audio (offline; exact cuts/speed/mute, pitch-follows caveat) ─────────
  let warning: string | undefined;
  let outputAudio: AudioBuffer | null = null;
  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    if (audioTrack && (await audioTrack.canDecode())) {
      const a = await buildOutputAudioBuffer(audioTrack, timelineMap, recipe.moments);
      outputAudio = a.buffer;
      if (a.pitchApprox) {
        warning = "Sped-up sections keep their original pitch.";
      }
    } else if (audioTrack) {
      warning =
        "This recording's audio couldn't be included, so the export has no sound.";
    }
  } catch (err) {
    console.warn("[editframe] audio build failed — exporting silent", err);
    warning = "Audio couldn't be prepared, so the export has no sound.";
    outputAudio = null;
  }
  throwIfAborted();

  // ── Encode (Editframe / mediabunny → MP4/H.264 + AAC) ────────────────────
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(outCanvas, {
    codec: "avc",
    bitrate: videoBitrateFor(plan.resolution, fps),
    keyFrameInterval: 2,
  });
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

  // ── Frame loop — Framevo composeFrame per OUTPUT frame ───────────────────
  const startedAt =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const frameDur = 1 / fps;
  try {
    for (let i = 0; i < totalFrames; i++) {
      throwIfAborted();
      const outputTime = i / fps;
      const sourceTime = sourceTimeForOutput(timelineMap, outputTime);

      const sample = await videoSink.getSample(sourceTime);
      if (sample) {
        if (
          !srcSized ||
          srcCanvas.width !== sample.displayWidth ||
          srcCanvas.height !== sample.displayHeight
        ) {
          srcCanvas.width = sample.displayWidth;
          srcCanvas.height = sample.displayHeight;
          srcSized = true;
        }
        sample.draw(srcCtx, 0, 0);
        sample.close();
      }
      // A null sample (before the first / after the last source frame) reuses the
      // last drawn frame — the same forward-only behavior as the worker.
      composeFrame(outCtx, srcCanvas, recipe, sourceTime);
      await videoSource.add(outputTime, frameDur);

      const done = i + 1;
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      const elapsed = now - startedAt;
      onProgress?.({
        percent: done / totalFrames,
        currentFrame: done,
        totalFrames,
        etaMs: done > 0 ? (elapsed / done) * (totalFrames - done) : undefined,
      });
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

  return {
    blob: new Blob([buffer], { type: "video/mp4" }),
    warning,
    videoDurationSec: outputDuration,
  };
}
