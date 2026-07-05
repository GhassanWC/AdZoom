/// <reference lib="webworker" />
/**
 * WebCodecs decode worker. Receives a chunk's encoded samples + decoder config,
 * decodes them with `VideoDecoder` into `VideoFrame`s (off the main thread),
 * samples frames at the target fps into compact grayscale buffers, then runs
 * the SHARED `analyzeFrameStream` to produce the window-local `VisualAnalysis`.
 *
 * Memory discipline: every `VideoFrame` is drawn to a small `OffscreenCanvas`
 * and `.close()`d immediately — we never retain decoded frames, only the tiny
 * grayscale `ExtractedFrame`s.
 */
import { analyzeFrameStream } from "../../pipeline";
import {
  toGrayscale,
  downsample2x,
  sampleFpsFor,
  type ExtractedFrame,
} from "../../frame-extractor";
import { DETECT_W, DETECT_H } from "../../types";
import { resolveSourceRect } from "../../../timeline/source-crop";
import type { VisualAnalysis } from "../../../firebase/schema";
import type { SourceCrop } from "../../../recording/types";

interface AnalyzeMsg {
  type: "analyze";
  reqId: number;
  config: VideoDecoderConfig;
  samples: Array<{
    data: ArrayBuffer;
    timestampUs: number;
    durationUs: number;
    isSync: boolean;
  }>;
  startTime: number;
  endTime: number;
  duration: number;
  sourceCrop?: SourceCrop;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<AnalyzeMsg>) => {
  const msg = ev.data;
  if (msg.type !== "analyze") return;
  try {
    const va = await decodeAndAnalyze(msg);
    ctx.postMessage({ type: "result", reqId: msg.reqId, va });
  } catch (err) {
    ctx.postMessage({
      type: "error",
      reqId: msg.reqId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function decodeAndAnalyze(msg: AnalyzeMsg): Promise<VisualAnalysis> {
  const { config, samples, startTime, endTime, duration, sourceCrop } = msg;
  const fps = sampleFpsFor(duration);
  const stepUs = 1e6 / fps;
  const startUs = startTime * 1e6;
  const endUs = endTime * 1e6;

  const canvas = new OffscreenCanvas(DETECT_W, DETECT_H);
  const c2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!c2d) throw new Error("OffscreenCanvas 2D context unavailable");

  const frames: ExtractedFrame[] = [];
  let nextSampleUs = startUs;
  let decodeError: Error | null = null;

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const ts = frame.timestamp;
        if (ts < startUs - stepUs || ts > endUs + stepUs) return;
        if (ts + 1 < nextSampleUs) return; // not yet at the next sample point
        nextSampleUs = ts + stepUs;
        // Sample only the source-crop sub-rectangle of the decoded frame, so
        // cropped-out areas never reach the CV pass.
        const rect = resolveSourceRect(
          frame.displayWidth,
          frame.displayHeight,
          sourceCrop
        );
        if (rect.cropActive) {
          c2d.drawImage(
            frame,
            rect.sx,
            rect.sy,
            rect.sWidth,
            rect.sHeight,
            0,
            0,
            DETECT_W,
            DETECT_H
          );
        } else {
          c2d.drawImage(frame, 0, 0, DETECT_W, DETECT_H);
        }
        const img = c2d.getImageData(0, 0, DETECT_W, DETECT_H);
        const detectFrame = toGrayscale(img.data, DETECT_W, DETECT_H);
        frames.push({
          t: ts / 1e6,
          frame: downsample2x(detectFrame),
          detectFrame,
        });
      } finally {
        frame.close();
      }
    },
    error: (e) => {
      decodeError = e instanceof Error ? e : new Error(String(e));
    },
  });

  decoder.configure(config);

  for (const s of samples) {
    decoder.decode(
      new EncodedVideoChunk({
        type: s.isSync ? "key" : "delta",
        timestamp: s.timestampUs,
        duration: s.durationUs,
        data: new Uint8Array(s.data),
      })
    );
  }
  await decoder.flush();
  decoder.close();
  if (decodeError) throw decodeError;

  // Frames arrive in decode order; presentation order can differ with B-frames.
  frames.sort((a, b) => a.t - b.t);

  async function* gen(): AsyncGenerator<ExtractedFrame> {
    for (const f of frames) yield f;
  }

  return analyzeFrameStream(gen(), { duration, startTime, endTime });
}
