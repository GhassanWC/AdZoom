"use client";

import type { VisualAnalysis } from "../../firebase/schema";
import { runVisualAnalysis } from "../pipeline";
import type { CvChunkEngine, CvChunkRequest, CvSource } from "./types";

/**
 * Fallback CV engine: a dedicated, off-DOM hidden `<video>` decoded by seeking
 * (the proven `runVisualAnalysis` path), windowed per chunk.
 *
 * It uses its OWN hidden video — not the editor's preview element — so CV
 * doesn't fight playback and the user can keep watching/editing while chunks
 * process. Seeking a single element can't be parallelised safely, so the
 * orchestrator runs this engine at concurrency 1.
 */
export class HiddenVideoCvEngine implements CvChunkEngine {
  readonly kind = "hidden-video" as const;
  private video: HTMLVideoElement | null = null;
  private ready: Promise<HTMLVideoElement> | null = null;

  constructor(private source: CvSource) {}

  private ensure(): Promise<HTMLVideoElement> {
    if (this.ready) return this.ready;
    this.ready = new Promise<HTMLVideoElement>((resolve, reject) => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.style.position = "absolute";
      video.style.opacity = "0";
      video.style.pointerEvents = "none";
      video.style.width = "1px";
      video.style.height = "1px";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onErr);
      };
      const fail = (message: string) => {
        cleanup();
        // Clear the cached promise so a retry can re-attempt the load rather than
        // resolving to this same rejection instantly.
        this.ready = null;
        reject(new Error(message));
      };
      const onMeta = () => {
        cleanup();
        resolve(video);
      };
      const onErr = () => fail(`CV video failed to load: ${this.source.url}`);
      // Some arbitrary uploads (unsupported codec, HEVC, a stalled URL) never fire
      // `loadedmetadata` OR `error`. Without this the CV pass would hang at 0%
      // forever; instead we fail fast so the orchestrator falls back / marks the
      // chunk failed and still finalizes via the server pass.
      timer = setTimeout(
        () => fail(`CV video metadata load timed out: ${this.source.url}`),
        30_000
      );
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("error", onErr);
      video.src = this.source.url;
      this.video = video;
    });
    return this.ready;
  }

  async analyzeChunk(req: CvChunkRequest): Promise<VisualAnalysis> {
    const video = await this.ensure();
    return runVisualAnalysis(video, {
      duration: req.duration,
      startTime: req.startTime,
      endTime: req.endTime,
      signal: req.signal,
      sourceCrop: this.source.sourceCrop,
      onProgress: req.onProgress ? (p) => req.onProgress!(p.done) : undefined,
    });
  }

  dispose(): void {
    const v = this.video;
    if (v) {
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch {
        /* ignore */
      }
    }
    this.video = null;
    this.ready = null;
  }
}
