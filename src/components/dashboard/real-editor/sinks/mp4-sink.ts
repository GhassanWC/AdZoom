"use client";

import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { ExportError, describeError } from "../export-error";
import { AAC_CODEC, avcCodecFor } from "../export-format";
import type { ExportSink } from "./types";

// `MediaStreamTrackProcessor` (Insertable Streams, Chrome/Edge) isn't in
// lib.dom typings — and lib.webworker's incidental declaration omits `track`
// and types `readable` as `ReadableStream<any>`. Access it via a precise cast so
// the sink is fully typed without fighting the platform libs. Guarded by
// `canEncodeMp4` before this sink is ever chosen.
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => {
  readable: ReadableStream<VideoFrame | AudioData>;
};
const TrackProcessor = (
  globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor }
).MediaStreamTrackProcessor;

/**
 * MP4 sink — produces a real H.264/AAC MP4 via WebCodecs, bypassing Chrome's
 * unstable MediaRecorder MP4 muxer (the `EncodingError: "Internal Error."`
 * source). The SAME `outputStream` the WebM sink uses (canvas video + mixed
 * audio) is read frame-by-frame through `MediaStreamTrackProcessor`, encoded
 * with `VideoEncoder`/`AudioEncoder`, and muxed by `mp4-muxer`. Because both
 * tracks come from one MediaStream clock, A/V stay in sync
 * (`firstTimestampBehavior: "cross-track-offset"`).
 *
 * Cuts: the render loop calls `pause()` while seeking past a cut. While paused
 * we drop frames and accumulate the gap (`droppedUs`); each kept frame is muxed
 * at `originalTs - droppedUs` (via `addVideoChunk`'s timestamp override, so no
 * frame/audio reconstruction), making the skipped span genuinely absent — parity
 * with `MediaRecorder.pause()`. Speed needs no special handling: `playbackRate`
 * already compresses realtime capture, so frame timestamps already reflect it.
 *
 * Runs on the main thread for v1 (parity with MediaRecorder; the encoders are
 * GPU/thread-offloaded internally). Moving the encode to a worker is a future
 * optimization.
 */
export interface Mp4SinkOptions {
  outputStream: MediaStream;
  width: number;
  height: number;
  fps: 30 | 60;
  videoBitrate: number;
  audioBitrate: number;
  currentTime?: () => number;
}

export function createMp4Sink(opts: Mp4SinkOptions): ExportSink {
  const { outputStream, width, height, fps, videoBitrate, audioBitrate } = opts;
  const videoTrack = outputStream.getVideoTracks()[0];
  if (!videoTrack) {
    throw new ExportError("recorder", "No video track to encode for the MP4 export.");
  }
  const audioTrack = outputStream.getAudioTracks()[0] ?? null;
  const avcCodec = avcCodecFor(width, height);

  let muxer: Muxer<ArrayBufferTarget> | null = null;
  let videoEncoder: VideoEncoder | null = null;
  let audioEncoder: AudioEncoder | null = null;
  let videoReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  let audioReader: ReadableStreamDefaultReader<AudioData> | null = null;

  let ready = false; // muxer + encoders configured
  let stopping = false;
  let disposed = false;
  let finalized = false;
  let paused = false;
  let forceKeyNext = false; // force a keyframe on the first frame after a cut
  let gapStartUs: number | null = null; // capture ts where the current cut began
  let droppedUs = 0; // total cut time removed so far (capture-clock µs)
  let frameCount = 0;
  let lastVideoOutUs = -1;
  let droppedForBackpressure = 0;

  // Adjusted (gap-removed) timestamps, keyed by the ORIGINAL chunk timestamp,
  // so the muxer gets continuous timestamps without rebuilding frames/audio.
  const videoTsAdjust = new Map<number, number>();
  const audioTsAdjust = new Map<number, number>();

  let settled = false;
  let resolveDone!: (b: Blob) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<Blob>((res, rej) => {
    resolveDone = (b) => {
      if (!settled) {
        settled = true;
        res(b);
      }
    };
    rejectDone = (e) => {
      if (!settled) {
        settled = true;
        rej(e);
      }
    };
  });
  void done.catch(() => {}); // avoid unhandled-rejection if torn down un-awaited

  const fail = (err: unknown) => {
    if (settled) return;
    const d = describeError(err);
    console.error("[export-render-loop] MP4 encode error", d);
    rejectDone(
      err instanceof ExportError
        ? err
        : new ExportError(
            "render",
            "The MP4 encoder failed during export. Try WebM, or use Chrome/Edge.",
            { cause: err }
          )
    );
    hardTeardown();
  };

  function initPipeline(
    audioParams: { sampleRate: number; numberOfChannels: number } | null
  ): void {
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      fastStart: "in-memory", // moov at the front → seekable/streamable playback
      firstTimestampBehavior: "cross-track-offset", // both tracks share one clock
      video: { codec: "avc", width, height, frameRate: fps },
      ...(audioParams
        ? {
            audio: {
              codec: "aac",
              numberOfChannels: audioParams.numberOfChannels,
              sampleRate: audioParams.sampleRate,
            },
          }
        : {}),
    });

    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (!muxer || finalized) return;
        const t = videoTsAdjust.get(chunk.timestamp);
        if (t !== undefined) videoTsAdjust.delete(chunk.timestamp);
        try {
          muxer.addVideoChunk(chunk, meta, t ?? chunk.timestamp);
        } catch (e) {
          fail(e);
        }
      },
      error: (e) => fail(e),
    });
    videoEncoder.configure({
      codec: avcCodec,
      width,
      height,
      bitrate: videoBitrate,
      framerate: fps,
      latencyMode: "realtime", // no B-frames → in-order output, low latency
    });

    if (audioParams) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          if (!muxer || finalized) return;
          const t = audioTsAdjust.get(chunk.timestamp);
          if (t !== undefined) audioTsAdjust.delete(chunk.timestamp);
          try {
            muxer.addAudioChunk(chunk, meta, t ?? chunk.timestamp);
          } catch (e) {
            fail(e);
          }
        },
        error: (e) => fail(e),
      });
      audioEncoder.configure({
        codec: AAC_CODEC,
        numberOfChannels: audioParams.numberOfChannels,
        sampleRate: audioParams.sampleRate,
        bitrate: audioBitrate,
      });
    }
    ready = true;
  }

  function handleVideoFrame(frame: VideoFrame): void {
    if (disposed || stopping || !ready || !videoEncoder) {
      frame.close();
      return;
    }
    if (paused) {
      if (gapStartUs === null) gapStartUs = frame.timestamp;
      frame.close();
      return;
    }
    // First frame after a cut resolves the gap length removed from the output.
    if (gapStartUs !== null) {
      droppedUs += frame.timestamp - gapStartUs;
      gapStartUs = null;
    }
    const outUs = frame.timestamp - droppedUs;
    if (outUs <= lastVideoOutUs) {
      frame.close(); // keep timestamps strictly monotonic
      return;
    }
    // Soft backpressure: if the encoder falls behind (e.g. software 4K60), drop
    // this frame rather than grow the queue unbounded. Realtime capture tolerates
    // an occasional dropped frame.
    if (videoEncoder.encodeQueueSize > 30) {
      droppedForBackpressure++;
      frame.close();
      return;
    }
    lastVideoOutUs = outUs;
    videoTsAdjust.set(frame.timestamp, outUs);
    const keyFrame = forceKeyNext || frameCount % (fps * 2) === 0;
    forceKeyNext = false;
    frameCount++;
    try {
      videoEncoder.encode(frame, { keyFrame });
    } catch (e) {
      fail(e);
    } finally {
      frame.close();
    }
  }

  function handleAudioData(data: AudioData): void {
    // Gate audio on the SAME paused/gap state as video so a cut removes audio in
    // lock-step (gapStartUs is cleared by video's first post-cut frame, after
    // droppedUs is updated — so audio never encodes with a stale offset).
    if (
      disposed ||
      stopping ||
      !ready ||
      !audioEncoder ||
      paused ||
      gapStartUs !== null
    ) {
      data.close();
      return;
    }
    const outUs = data.timestamp - droppedUs;
    audioTsAdjust.set(data.timestamp, outUs);
    try {
      audioEncoder.encode(data);
    } catch (e) {
      fail(e);
    } finally {
      data.close();
    }
  }

  async function pumpVideo(): Promise<void> {
    try {
      if (!TrackProcessor) throw new Error("MediaStreamTrackProcessor unavailable");
      const proc = new TrackProcessor({ track: videoTrack });
      videoReader = (proc.readable as ReadableStream<VideoFrame>).getReader();
      for (;;) {
        const { value, done: rdone } = await videoReader.read();
        if (rdone) break;
        if (value) handleVideoFrame(value);
      }
    } catch (e) {
      if (!stopping && !disposed) fail(e);
    }
  }

  async function pumpAudio(): Promise<void> {
    if (!audioTrack) return;
    try {
      if (!TrackProcessor) throw new Error("MediaStreamTrackProcessor unavailable");
      const proc = new TrackProcessor({ track: audioTrack });
      audioReader = (proc.readable as ReadableStream<AudioData>).getReader();
      for (;;) {
        const { value, done: rdone } = await audioReader.read();
        if (rdone) break;
        if (!value) continue;
        if (!ready) {
          // First AudioData defines the real sampleRate/channels — build the
          // muxer + encoders now so they agree with the data being fed in.
          initPipeline({
            sampleRate: value.sampleRate,
            numberOfChannels: value.numberOfChannels,
          });
        }
        handleAudioData(value);
      }
    } catch (e) {
      if (!stopping && !disposed) fail(e);
    }
  }

  function hardTeardown(): void {
    if (disposed) return;
    disposed = true;
    stopping = true;
    try {
      void videoReader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      void audioReader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      if (videoEncoder && videoEncoder.state !== "closed") videoEncoder.close();
    } catch {
      /* ignore */
    }
    try {
      if (audioEncoder && audioEncoder.state !== "closed") audioEncoder.close();
    } catch {
      /* ignore */
    }
  }

  return {
    container: "mp4",
    mimeType: "video/mp4",
    videoCodec: avcCodec,
    done,
    start() {
      // Audio-gated init: WITH audio the pipeline is built on the first AudioData
      // (so the muxer/encoder get the true sampleRate/channels); the few video
      // frames before that are dropped (handleVideoFrame !ready). WITHOUT audio,
      // build immediately so video encodes from frame 0.
      if (!audioTrack) initPipeline(null);
      void pumpVideo();
      void pumpAudio();
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      forceKeyNext = true; // start the post-cut span on a clean keyframe
    },
    stop() {
      if (stopping) return;
      stopping = true;
      void (async () => {
        try {
          try {
            await videoReader?.cancel();
          } catch {
            /* ignore */
          }
          try {
            await audioReader?.cancel();
          } catch {
            /* ignore */
          }
          if (videoEncoder && videoEncoder.state === "configured") {
            await videoEncoder.flush();
          }
          if (audioEncoder && audioEncoder.state === "configured") {
            await audioEncoder.flush();
          }
          if (!muxer) {
            throw new ExportError("render", "The MP4 export captured no frames.");
          }
          finalized = true;
          muxer.finalize();
          const { buffer } = muxer.target;
          if (droppedForBackpressure > 0) {
            console.warn("[export-recorder] MP4 dropped frames for backpressure", {
              dropped: droppedForBackpressure,
            });
          }
          resolveDone(new Blob([buffer], { type: "video/mp4" }));
        } catch (e) {
          rejectDone(
            e instanceof ExportError
              ? e
              : new ExportError("render", "Finalizing the MP4 failed.", { cause: e })
          );
        } finally {
          hardTeardown();
        }
      })();
    },
    dispose() {
      hardTeardown();
    },
  };
}
