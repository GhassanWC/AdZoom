"use client";

import type { VisualAnalysis } from "../../../firebase/schema";
import { CV_CHUNK_CONCURRENCY } from "../../../analysis/chunk-config";
import type { CvChunkEngine, CvChunkRequest, CvSource } from "../types";
import { demuxMp4, type DemuxResult } from "./mp4-demux";

/**
 * Primary CV engine: decode video windows off the main thread with WebCodecs
 * (`VideoDecoder` + `OffscreenCanvas`) across a small Web Worker pool.
 *
 * The container is fetched + demuxed ONCE; each chunk transfers only its
 * window's encoded samples (a few MB) to a worker, so we never copy the whole
 * file per chunk. Any failure is surfaced to the orchestrator, which probes
 * this engine on the first chunk and hot-swaps to the hidden-video fallback if
 * it can't run — so this path is safe even where a codec isn't decodable.
 */
export class WebCodecsCvEngine implements CvChunkEngine {
  readonly kind = "webcodecs" as const;
  private demuxed: Promise<DemuxResult> | null = null;
  private pool: PooledWorker[] = [];
  private maxWorkers = Math.max(1, CV_CHUNK_CONCURRENCY);

  constructor(private source: CvSource) {}

  private ensureDemuxed(signal?: AbortSignal): Promise<DemuxResult> {
    if (!this.demuxed) {
      this.demuxed = (async () => {
        try {
          // Signal-aware so the orchestrator's per-chunk watchdog (or a cancel)
          // can abort a stalled download instead of hanging chunk 1 forever.
          const res = await fetch(this.source.url, signal ? { signal } : undefined);
          if (!res.ok) throw new Error(`Fetch video failed: HTTP ${res.status}`);
          const bytes = await res.arrayBuffer();
          return demuxMp4(bytes);
        } catch (err) {
          this.demuxed = null; // don't cache the failure — allow a retry to re-fetch
          throw err;
        }
      })();
    }
    return this.demuxed;
  }

  private acquire(): PooledWorker {
    const free = this.pool.find((w) => !w.busy);
    if (free) {
      free.busy = true;
      return free;
    }
    if (this.pool.length < this.maxWorkers) {
      const worker = new Worker(new URL("./decoder.worker.ts", import.meta.url), {
        type: "module",
      });
      const pw: PooledWorker = { worker, busy: true };
      this.pool.push(pw);
      return pw;
    }
    // Pool exhausted — reuse the first (orchestrator caps concurrency, so this
    // is rare). Mark busy; the caller awaits its turn via the message id.
    const w = this.pool[0];
    w.busy = true;
    return w;
  }

  async analyzeChunk(req: CvChunkRequest): Promise<VisualAnalysis> {
    const { config, samples } = await this.ensureDemuxed(req.signal);

    // Select the window's samples, extended back to the keyframe at/before the
    // window start so the decoder has a random-access point.
    const startUs = req.startTime * 1e6;
    const endUs = req.endTime * 1e6;
    let firstKey = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].timestampUs > startUs) break;
      if (samples[i].isSync) firstKey = i;
    }
    const windowSamples: typeof samples = [];
    for (let i = firstKey; i < samples.length; i++) {
      if (samples[i].timestampUs > endUs) break;
      windowSamples.push(samples[i]);
    }

    const pw = this.acquire();
    const reqId = nextReqId();
    const transfer: ArrayBuffer[] = [];
    const payloadSamples = windowSamples.map((s) => {
      const copy = s.data.slice().buffer;
      transfer.push(copy);
      return {
        data: copy,
        timestampUs: s.timestampUs,
        durationUs: s.durationUs,
        isSync: s.isSync,
      };
    });

    return new Promise<VisualAnalysis>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        // Kill the in-flight decode and replace the worker.
        try {
          pw.worker.terminate();
        } catch {
          /* ignore */
        }
        this.pool = this.pool.filter((p) => p !== pw);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const onMessage = (ev: MessageEvent) => {
        const m = ev.data as
          | { type: "result"; reqId: number; va: VisualAnalysis }
          | { type: "error"; reqId: number; message: string };
        if (m.reqId !== reqId) return;
        cleanup();
        pw.busy = false;
        if (m.type === "result") resolve(m.va);
        else reject(new Error(m.message));
      };
      const cleanup = () => {
        pw.worker.removeEventListener("message", onMessage);
        req.signal?.removeEventListener("abort", onAbort);
      };

      pw.worker.addEventListener("message", onMessage);
      req.signal?.addEventListener("abort", onAbort);
      pw.worker.postMessage(
        {
          type: "analyze",
          reqId,
          config,
          samples: payloadSamples,
          startTime: req.startTime,
          endTime: req.endTime,
          duration: req.duration,
          // Crop every decoded frame to the source-crop rect in-worker.
          sourceCrop: this.source.sourceCrop,
        },
        transfer
      );
    });
  }

  dispose(): void {
    for (const pw of this.pool) {
      try {
        pw.worker.terminate();
      } catch {
        /* ignore */
      }
    }
    this.pool = [];
    this.demuxed = null;
  }
}

interface PooledWorker {
  worker: Worker;
  busy: boolean;
}

let reqCounter = 0;
function nextReqId(): number {
  reqCounter += 1;
  return reqCounter;
}
