"use client";

import {
  serverTimestamp,
  setDoc,
  doc,
  updateDoc,
} from "firebase/firestore";
import { getDownloadURL, ref as storageRef, uploadBytesResumable } from "firebase/storage";
import { getFirebase } from "@/lib/firebase/client";
import { safeVideoContentType } from "@/lib/firebase/projects";
import { cameraDiagnostic } from "@/lib/timeline/camera";
import {
  activeSpeedAt,
  activeCutAt,
  isActiveSpeed,
  DEFAULT_SPEED,
} from "@/lib/timeline/crop-speed";
import { probeVideoBottomBand } from "@/lib/recording/health-check";
import {
  buildRenderRecipe,
  type BasePlacement,
} from "@/lib/render/recipe";
import { composeFrame } from "@/lib/render/compose-frame";
import {
  ExportError,
  describeError,
  friendlyStorageMessage,
} from "./export-error";
import {
  type ExportContainer,
  AUDIO_BITRATE_OPUS,
  AUDIO_BITRATE_AAC,
  canEncodeMp4,
  videoBitrateFor,
} from "./export-format";
import type { ExportSink } from "./sinks/types";
import { createWebmSink } from "./sinks/webm-sink";
import { createMp4Sink } from "./sinks/mp4-sink";
import type {
  BackgroundMode,
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
  SourceCrop,
  SpeedSettings,
  VisualAnalysis,
} from "@/lib/firebase/schema";

// `BasePlacement` + the per-export geometry now live in `@/lib/render/recipe`,
// shared with the cloud worker. `BasePlacement` is imported above for the
// dev-only manifest/camera-snapshot log helpers.

// MediaRecorder is used ONLY for WebM here. MP4 via MediaRecorder is removed on
// purpose: Chrome reports `isTypeSupported("video/mp4;codecs=avc1…,mp4a…")` as
// true, then its experimental MP4 muxer throws `EncodingError: "Internal Error."`
// mid-record — the production export failure. MP4 is produced instead by the
// WebCodecs `Mp4WebCodecsSink` (see sinks/mp4-sink.ts). VP9 first (best quality),
// then VP8, then a bare container — every entry carries Opus/UA-negotiated audio
// (never add a video-only `codecs=` string: it silently drops the audio track).
const PREFERRED_MIMES = [
  "video/webm;codecs=vp9,opus", // VP9 + Opus
  "video/webm;codecs=vp8,opus", // VP8 + Opus
  "video/webm", // UA negotiates codecs — keeps audio
];

function pickMime(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const mime of PREFERRED_MIMES) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return { mime, ext: mime.startsWith("video/mp4") ? "mp4" : "webm" };
    }
  }
  return null;
}

/** Diagnostics: which of the preferred MIMEs this browser actually supports. */
function supportedMimes(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof MediaRecorder === "undefined") return out;
  for (const m of PREFERRED_MIMES) out[m] = MediaRecorder.isTypeSupported(m);
  return out;
}

// ── Export audio mixing ─────────────────────────────────────────────────────
// canvas.captureStream() yields VIDEO ONLY. The source's audio has to be mixed
// into the recorded stream separately, or the export is silent.
//
// IMPORTANT history: feeding the recorder the RAW HTMLMediaElement.captureStream()
// audio track caused a mid-stream "MediaRecorder error" (~38% in). That raw track
// is tied to the shared, actively-playing element, and its parent MediaStream was
// discarded (only the track kept) — so it could be GC-orphaned and go `ended`,
// which throws once the track is actually being ENCODED (it wasn't, under the old
// video-only MIME — which is why the bug only appeared after we forced an audio
// codec). The screen-recorder never hits this because it muxes a SYNTHETIC Web
// Audio MediaStreamDestination track, which stays live for the AudioContext's life.
//
// So the strategy is:
//   1. PRIMARY — tap the element's captureStream() audio, then RE-SYNTHESIZE it
//      through Web Audio with createMediaStreamSource → MediaStreamDestination.
//      The recorder gets a stable synthetic track (like the recorder), every node
//      + the parent stream is retained (no GC orphan), and — crucially — this uses
//      createMediaStreamSource, NOT createMediaElementSource, so the preview
//      <video>'s native audio is NOT rerouted (zero preview-audio risk). The
//      per-export AudioContext is closed in `cleanup` after recording stops.
//      Section-mute = an export-only gain node (never touches `video.muted`).
//   2. RAW — if no AudioContext exists, record the captured track directly but
//      RETAIN its parent stream so it can't be GC-orphaned.
//   3. ELEMENT-SOURCE FALLBACK — only when captureStream surfaces no audio at all
//      (e.g. a browser without HTMLMediaElement.captureStream): createMediaElement
//      Source → MediaStreamDestination. That reroutes the element (once per element
//      for its lifetime, cached), so a monitor path (→ ctx.destination, mirroring
//      muted/volume) keeps the preview audible.

interface ElementAudioGraph {
  ctx: AudioContext;
  exportGain: GainNode;
  dest: MediaStreamAudioDestinationNode;
}

const elementAudioGraphs = new WeakMap<HTMLMediaElement, ElementAudioGraph>();

function getOrCreateAudioGraph(video: HTMLMediaElement): ElementAudioGraph | null {
  const existing = elementAudioGraphs.get(video);
  if (existing) return existing;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx();
  let source: MediaElementAudioSourceNode;
  try {
    // Throws if the element is cross-origin without CORS (ours is
    // crossOrigin="anonymous", so a correctly-served source is fine) or if a
    // source node already exists for it (can't happen here — we cache it).
    source = ctx.createMediaElementSource(video);
  } catch (err) {
    void ctx.close();
    throw err;
  }
  const monitorGain = ctx.createGain();
  const exportGain = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  source.connect(monitorGain);
  monitorGain.connect(ctx.destination); // keep the preview audible post-reroute
  source.connect(exportGain);
  exportGain.connect(dest);
  // Mirror the element's own mute/volume so the preview's mute button + volume
  // slider keep working now that audio flows through us, not natively.
  const syncMonitor = () => {
    monitorGain.gain.value = video.muted ? 0 : video.volume;
  };
  syncMonitor();
  video.addEventListener("volumechange", syncMonitor);
  // The UA can suspend the context (e.g. tab hidden); every play() in this app
  // follows a user gesture, so resume on play to avoid a silent preview.
  video.addEventListener("play", () => {
    if (ctx.state === "suspended") void ctx.resume();
  });
  const graph: ElementAudioGraph = { ctx, exportGain, dest };
  elementAudioGraphs.set(video, graph);
  return graph;
}

type AudioPath =
  | "element-capture-webaudio"
  | "element-capture-raw"
  | "web-audio-element-source"
  | "none";

interface ExportAudio {
  /** The audio track to mix into the export, or null if none was obtainable. */
  track: MediaStreamTrack | null;
  /** How it was obtained (diagnostics). */
  path: AudioPath;
  /** Mute ONLY the current section, leaving the rest of the export audible. */
  setSectionMuted: (muted: boolean) => void;
  /**
   * Opaque references (nodes / parent streams) kept alive for the whole export
   * so MediaRecorder's tracks can't be garbage-collected mid-record. The caller
   * just has to keep the returned ExportAudio object reachable.
   */
  keepAlive?: unknown;
  /** Release per-export resources (close the per-export AudioContext) — call AFTER recording stops. */
  cleanup?: () => void;
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ||
    null
  );
}

/**
 * Obtain a stable audio track to mix into the export, plus a section-scoped mute
 * control. See the strategy comment above `ElementAudioGraph`. Returns
 * `{ track: null, path: "none" }` if no audio could be obtained at all.
 */
function acquireExportAudio(video: HTMLVideoElement): ExportAudio {
  const AudioCtx = getAudioContextCtor();

  // 1) PRIMARY — tap the element's captureStream audio, then re-synthesize it
  //    through Web Audio (createMediaStreamSource, NOT createMediaElementSource)
  //    so the recorder gets a stable synthetic track without rerouting the
  //    preview element. All refs retained; section-mute via an export gain node.
  try {
    const captureStream = (
      video as unknown as { captureStream?: () => MediaStream }
    ).captureStream;
    if (captureStream) {
      const capStream = captureStream.call(video);
      const rawTrack = capStream.getAudioTracks()[0] ?? null;
      if (rawTrack && AudioCtx) {
        const ctx = new AudioCtx();
        const srcNode = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
        const gain = ctx.createGain();
        const dest = ctx.createMediaStreamDestination();
        srcNode.connect(gain);
        gain.connect(dest);
        if (ctx.state === "suspended") void ctx.resume();
        const track = dest.stream.getAudioTracks()[0] ?? null;
        if (track) {
          return {
            track,
            path: "element-capture-webaudio",
            setSectionMuted: (muted) => {
              gain.gain.value = muted ? 0 : 1;
            },
            // Retain the whole graph + the parent capture stream against GC.
            keepAlive: { ctx, srcNode, gain, dest, capStream },
            cleanup: () => {
              try {
                void ctx.close();
              } catch {
                /* already closed — ignore */
              }
            },
          };
        }
        try {
          void ctx.close();
        } catch {
          /* ignore */
        }
      }
      if (rawTrack) {
        // No AudioContext — record the captured track directly, but RETAIN its
        // parent stream so it can't be GC-orphaned mid-record. Section-mute then
        // falls back to element mute (scoped to the section, applied live).
        return {
          track: rawTrack,
          path: "element-capture-raw",
          setSectionMuted: (muted) => {
            if (video.muted !== muted) video.muted = muted;
          },
          keepAlive: { capStream },
        };
      }
    }
  } catch (err) {
    console.warn("[export] element captureStream audio failed", err);
  }

  // 2) FALLBACK — the element exposed no audio via captureStream (browser without
  //    HTMLMediaElement.captureStream). createMediaElementSource is then the only
  //    way to recover audio; it reroutes the element, so the cached graph keeps a
  //    monitor path to preserve preview audio.
  try {
    const graph = getOrCreateAudioGraph(video);
    if (graph) {
      if (graph.ctx.state === "suspended") void graph.ctx.resume();
      graph.exportGain.gain.value = 1;
      const track = graph.dest.stream.getAudioTracks()[0] ?? null;
      if (track) {
        // The element must stay UNMUTED so the source node receives signal;
        // section-mute is done via the export gain, not element `muted`.
        if (video.muted) video.muted = false;
        return {
          track,
          path: "web-audio-element-source",
          setSectionMuted: (muted) => {
            graph.exportGain.gain.value = muted ? 0 : 1;
          },
        };
      }
    }
  } catch (err) {
    console.warn("[export] web-audio element-source fallback failed", err);
  }

  return { track: null, path: "none", setSectionMuted: () => {} };
}

/**
 * Best-effort "does the source have an audio track?" probe. The standards are a
 * mess across browsers, so this returns "unknown" rather than guessing wrong:
 *  - Firefox: `mozHasAudio`.
 *  - Chrome/WebKit: `webkitAudioDecodedByteCount` — only > 0 AFTER some audio
 *    has decoded (i.e. after playback), so 0 here means "unknown", not "no".
 *  - `audioTracks` exists only behind a flag in Chrome; trusted when present.
 */
function detectSourceHasAudio(video: HTMLVideoElement): boolean | "unknown" {
  const v = video as HTMLVideoElement & {
    mozHasAudio?: boolean;
    webkitAudioDecodedByteCount?: number;
    audioTracks?: { length: number };
  };
  if (typeof v.mozHasAudio === "boolean") return v.mozHasAudio;
  if (v.audioTracks && typeof v.audioTracks.length === "number") {
    return v.audioTracks.length > 0;
  }
  if (typeof v.webkitAudioDecodedByteCount === "number") {
    return v.webkitAudioDecodedByteCount > 0 ? true : "unknown";
  }
  return "unknown";
}

/**
 * TEMPORARY DEBUG MODE — draws a RED border at the video's on-canvas bounds
 * and a BLUE border at the canvas bounds, every frame. If the two don't
 * perfectly overlap, the renderer is leaving pixels uncovered (the classic
 * cause of a baked-in band). Enabled in dev via `?debugBorders=1` in the
 * URL or `localStorage['framevo:debugBorders'] = '1'`. NEVER on in prod.
 *
 * Remove once the green-band investigation is closed.
 */
function debugBordersEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("debugBorders") === "1") return true;
    return window.localStorage.getItem("framevo:debugBorders") === "1";
  } catch {
    return false;
  }
}

export interface ExportProgress {
  stage:
    | "preparing"
    | "rendering"
    | "uploading"
    | "complete"
    | "failed"
    | "unsupported";
  pct: number; // 0..1
  message?: string;
  downloadURL?: string;
  /**
   * Non-fatal heads-up surfaced to the user (e.g. "this export will have no
   * audio"). The export still completes; the panel latches this so it stays
   * visible for the whole render.
   */
  warning?: string;
}

interface RenderInput {
  uid: string;
  projectId: string;
  projectTitle: string;
  video: HTMLVideoElement;
  duration: number;
  moments: DetectedMoment[];
  effects: EffectsSettings;
  resolution: "720p" | "1080p" | "4K";
  fps: 30 | 60;
  format: ExportFormat;
  /**
   * Client CV pass — feeds Smart-Fit's importance signals. Optional; absent
   * on older projects (Smart-Fit then falls back to a blurred fit).
   */
  visualAnalysis?: VisualAnalysis;
  /**
   * Global source-frame crop. When enabled, the exporter samples only the crop
   * sub-rectangle of the SOURCE so cropped-out areas never reach the rendered
   * file. Absent / disabled → full frame (no crop).
   */
  sourceCrop?: SourceCrop;
  /**
   * Desired output container. "webm" (default) renders via MediaRecorder;
   * "mp4" renders via the WebCodecs sink when the browser supports it, else
   * falls back to "webm" with a non-fatal warning. The ACTUAL container used is
   * reported back on the returned `ExportResult`.
   */
  container?: ExportContainer;
  onProgress: (p: ExportProgress) => void;
  signal?: AbortSignal;
  /**
   * When true, draw a "Made with Framevo" watermark on every frame. Set by
   * the server's /api/billing/export-permit response based on the user's
   * plan at permit-time. The client is expected to honour this flag; a
   * tampered client could ignore it (see plan notes: full tamper-proof
   * watermarking requires server-side rendering, deferred).
   */
  applyWatermark?: boolean;
}

/** The rendered blob plus the container that was ACTUALLY produced (MP4 may
 *  have fallen back to WebM), so the caller names/uploads the file correctly. */
export interface ExportResult {
  blob: Blob;
  container: ExportContainer;
}

/**
 * Render the source video to a canvas, applying preview transforms per moment,
 * and capture via an `ExportSink` (WebM = MediaRecorder, MP4 = WebCodecs).
 * Returns the encoded blob + the container actually produced.
 *
 * Honest limits:
 * - Audio: the canvas stream is video-only, so the source's audio is mixed in
 *   explicitly (`acquireExportAudio`) — preferring the element's own
 *   captureStream(), falling back to a Web Audio graph. A visible warning is
 *   surfaced via `onProgress` if neither yields a track.
 * - Output long edge is bounded by the resolution (1920 / 3840) via
 *   resolveOutputDims / resolveCanvasDims to stay within the encode budget.
 * - MP4 requires WebCodecs + MediaStreamTrackProcessor (Chrome/Edge); elsewhere
 *   it falls back to WebM with a non-fatal warning.
 */
export async function renderProjectClientSide(
  input: RenderInput
): Promise<ExportResult> {
  const {
    video,
    moments,
    effects,
    resolution,
    fps,
    format,
    onProgress,
    signal,
  } = input;

  // ── Stage: load-video (defensive re-check) ───────────────────────────────
  // The provider already awaited `loadeddata`, but a source that decoded a
  // header yet has no real frame (expired signed URL, decode error, codec the
  // UA can't play) lands here with zero dims. Catch it BEFORE we build a canvas
  // around bogus numbers so the failure is "video couldn't be loaded", not a
  // downstream black-frame mystery.
  const vw0 = video.videoWidth;
  const vh0 = video.videoHeight;
  console.info("[export-load-video]", {
    videoWidth: vw0,
    videoHeight: vh0,
    duration: video.duration,
    readyState: video.readyState,
    networkState: video.networkState,
    declaredDuration: input.duration,
    error: video.error
      ? { code: video.error.code, message: video.error.message }
      : null,
  });
  if (
    !(vw0 > 0) ||
    !(vh0 > 0) ||
    video.readyState < 2 /* HAVE_CURRENT_DATA */
  ) {
    throw new ExportError(
      "load-video",
      "The source video could not be loaded for export. It may have expired or be unavailable — reopen the project and try again.",
      {
        detail: {
          videoWidth: vw0,
          videoHeight: vh0,
          readyState: video.readyState,
          networkState: video.networkState,
          mediaErrorCode: video.error?.code,
        },
      }
    );
  }

  // ── Stage: recorder (MIME probe) ─────────────────────────────────────────
  // `pickMime` walks the WebM PREFERRED_MIMES and returns the first the UA
  // supports (null = no WebM MediaRecorder). The actual encoder is chosen later
  // by container (WebM = MediaRecorder, MP4 = WebCodecs) — so we DON'T throw
  // here; the sink-selection block decides + fails with a clear reason.
  const webmMime = pickMime();
  console.info("[export-recorder] mime probe", {
    picked: webmMime?.mime ?? null,
    supported: supportedMimes(),
  });

  onProgress({ stage: "preparing", pct: 0 });

  // ── Per-export render recipe (SHARED with the cloud worker) ──────────────
  // `buildRenderRecipe` resolves the source rect (Frame Crop), the output canvas
  // (Canvas Fit / Resize), the source's base placement, the background layer,
  // and the cut/speed timeline map using the SAME pure helpers as the preview —
  // the single source of truth for geometry. The browser exporter and the server
  // worker both call `buildRenderRecipe` + `composeFrame`, so the two render
  // paths agree by construction. The load-video guard above already verified the
  // video has real dimensions; the recipe clamps any degenerate crop to the full
  // frame internally rather than encoding garbage.
  const debugBorders = debugBordersEnabled();
  const recipe = buildRenderRecipe({
    sourceWidth: video.videoWidth,
    sourceHeight: video.videoHeight,
    fps,
    resolution,
    format,
    sourceDuration: input.duration,
    moments,
    effects,
    visualAnalysis: input.visualAnalysis,
    sourceCrop: input.sourceCrop,
    applyWatermark: input.applyWatermark === true,
    debugBorders,
  });
  const { canvasW, canvasH, base, bgActive, bgMode, outMode, outCropped, effectiveFit } = recipe;
  const sourceX = recipe.sourceRect.sx;
  const sourceY = recipe.sourceRect.sy;
  const sourceW = recipe.sourceRect.sWidth;
  const sourceH = recipe.sourceRect.sHeight;
  // Drives the audit log + bottom-band probe below — the rect actually drawn.
  const auditCover = { drawW: base.drawW, drawH: base.drawH };

  // ── Stage: canvas (prod-safe summary) ────────────────────────────────────
  // One line, ALWAYS logged (not dev-gated like the dimension audit below), so
  // a production "Internal Error" report carries the resolved output geometry +
  // the exact source rect that will feed every drawImage.
  console.info("[export-canvas]", {
    outputWidth: canvasW,
    outputHeight: canvasH,
    sourceRect: { sx: sourceX, sy: sourceY, sw: sourceW, sh: sourceH },
    canvasFit: outMode,
    cropActive: recipe.sourceRect.cropActive,
    willCrop: outCropped,
  });

  // ── Pipeline dimension audit ────────────────────────────────────────
  // The full capture → render → export chain in one log, so a "there's a
  // band / it's cropped" report can be diagnosed from the console alone.
  //
  //   drawImage SOURCE rect      = the whole source frame (0,0 → src W×H)
  //   drawImage DESTINATION rect = the cover-fit rect, centred on canvas
  //   gapBelowVideoPx            = canvas rows NOT covered by the video at
  //                                the bottom edge. Anything > 0 here is a
  //                                renderer-introduced band; the black
  //                                fill colours it black (never green), so
  //                                a GREEN band cannot originate here.
  if (process.env.NODE_ENV !== "production") {
    const srcAspect = sourceW / sourceH;
    const outAspect = canvasW / canvasH;
    const destX = canvasW / 2 + base.offsetX - auditCover.drawW / 2;
    const destY = canvasH / 2 + base.offsetY - auditCover.drawH / 2;
    // Bottom gap with the camera at identity (worst case for a bottom band).
    const gapBelow = Math.max(0, canvasH - (destY + auditCover.drawH));
    console.info("[export] dimension audit", {
      videoWidth: sourceW,
      videoHeight: sourceH,
      sourceAspect: srcAspect.toFixed(4),
      format,
      verticalExport: effects.verticalExport === true,
      mode: outMode,
      fitMode: recipe.fitMode,
      effectiveFit,
      background: bgActive ? bgMode : "none",
      baseOffset: { x: +base.offsetX.toFixed(1), y: +base.offsetY.toFixed(1) },
      resolution,
      canvasWidth: canvasW,
      canvasHeight: canvasH,
      exportWidth: canvasW,
      exportHeight: canvasH,
      exportAspect: outAspect.toFixed(4),
      willCrop: outCropped,
      drawImageSourceRect: { sx: sourceX, sy: sourceY, sw: sourceW, sh: sourceH },
      drawImageDestRect: {
        dx: +destX.toFixed(1),
        dy: +destY.toFixed(1),
        dw: +auditCover.drawW.toFixed(1),
        dh: +auditCover.drawH.toFixed(1),
      },
      gapBelowVideoPx: +gapBelow.toFixed(2),
      gapAboveVideoPx: +Math.max(0, destY).toFixed(2),
      debugBorders,
    });
    if (!bgActive && (gapBelow > 0.5 || destY > 0.5)) {
      console.warn(
        `[export] renderer leaves ${gapBelow.toFixed(1)}px below / ${Math.max(0, destY).toFixed(1)}px above the video uncovered — these rows are BLACK-filled, not green. A green band there is NOT from this renderer.`
      );
    } else if (bgActive) {
      console.info(
        `[export] Canvas Fit "${effectiveFit}" leaves empty space, intentionally filled by the "${bgMode}" background.`
      );
    }
    if (outCropped && Math.abs(srcAspect - outAspect) > 0.001) {
      console.warn(
        `[export] CROP active (${outMode}): source ${srcAspect.toFixed(3)} ≠ output ${outAspect.toFixed(3)} — content at the ${
          srcAspect > outAspect ? "left/right" : "top/bottom"
        } edges is cropped. Use Fit (with a background) in the Canvas panel to keep the whole frame.`
      );
    }

    // Decisive green-origin probe: sample the SOURCE video's own bottom
    // rows. If they're green HERE, the band is baked into the recorded
    // file at capture time (Chrome's tab-share strip) and no canvas
    // change can remove it without cropping. If they're NOT green here but
    // the export IS, the bug is downstream in our rendering.
    const probe = probeVideoBottomBand(video);
    if (probe) {
      const verdict =
        probe.bandHeightPx >= 3
          ? `GREEN BAND IN SOURCE (${probe.bandHeightPx}px, bottom-row ${(probe.bottomRowGreenRatio * 100).toFixed(0)}% green) — baked in at capture, NOT a render bug. Removed via sourceCrop (source-rect crop) when active; this probe reads the raw source.`
          : `source bottom is clean (bottom-row ${(probe.bottomRowGreenRatio * 100).toFixed(0)}% green) — any band in the export would be renderer-introduced.`;
      console.info("[export] source bottom-band probe", { ...probe, verdict });
    } else {
      console.info(
        "[export] source bottom-band probe: unreadable (no metadata or CORS taint)"
      );
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new ExportError(
      "canvas",
      "Couldn't create the export canvas (no 2D context available in this browser).",
      { detail: { canvasW, canvasH } }
    );
  }

  // Pre-fill black BEFORE the canvas is captured so MediaRecorder never
  // sees uninitialised GPU pixels (which often encode as green/magenta on
  // H.264 — that was the "green bar" in the broken export).
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvasW, canvasH);

  // canvas.captureStream() is VIDEO ONLY — the source audio is mixed in below.
  let canvasStream: MediaStream;
  try {
    canvasStream = canvas.captureStream(fps);
  } catch (err) {
    throw new ExportError(
      "canvas",
      "Couldn't capture the export canvas in this browser. Try Chrome or Edge.",
      { cause: err }
    );
  }

  // Rewind to the start and UNMUTE the element BEFORE we tap its audio, so the
  // captured track isn't a leftover muted / mid-seek state. We remember the
  // preview's prior mute + rate to restore them afterwards. (Per-section mute is
  // re-applied during the draw loop, scoped to that section only.)
  const prevMuted = video.muted;
  const prevPlaybackRate = video.playbackRate;
  video.pause();
  video.currentTime = 0;
  video.muted = false;
  // The pre-roll seek runs BEFORE the draw loop's abort handler is registered,
  // so it must honour cancellation + a stall timeout itself — otherwise a cancel
  // during pre-roll (or a decode stall on a flaky source) hangs the export in
  // "rendering" forever instead of resolving to "canceled"/a tagged error.
  await new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function teardown() {
      video.removeEventListener("seeked", onSeek);
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    }
    function onSeek() {
      if (done) return;
      done = true;
      teardown();
      resolve();
    }
    function onAbort() {
      if (done) return;
      done = true;
      teardown();
      for (const t of canvasStream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
      reject(new DOMException("Aborted", "AbortError"));
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      teardown();
      for (const t of canvasStream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
      reject(
        new ExportError(
          "load-video",
          "The source video stalled while preparing to export. It may be unavailable — reopen the project and try again."
        )
      );
    }, 15000);
    video.addEventListener("seeked", onSeek);
    signal?.addEventListener("abort", onAbort);
  });

  // ── Stage: canvas (one-time taint probe) ─────────────────────────────────
  // Drawing a cross-origin video that ISN'T CORS-readable taints the canvas.
  // A tainted canvas doesn't throw on drawImage — it fails LATER and opaquely
  // (captureStream produces black / MediaRecorder errors mid-record), which is
  // a prime "Internal Error" candidate in production. Detect it NOW with a
  // single 1px readback so we can fail with an actionable message. We restore
  // the black priming fill right after so the probe pixel never reaches a frame.
  try {
    ctx.drawImage(video, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);
  } catch (err) {
    const d = describeError(err);
    if (d.name === "SecurityError") {
      for (const t of canvasStream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
      throw new ExportError(
        "canvas",
        "The source video isn't CORS-accessible, so the export canvas is tainted and can't be encoded. Configure Storage CORS to allow this domain, then retry.",
        { cause: err, detail: { videoWidth: video.videoWidth, videoHeight: video.videoHeight } }
      );
    }
    // Any other readback failure is non-fatal for the probe — log and continue.
    console.warn("[export-canvas] taint probe inconclusive", d);
  }
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Mix the source audio into the recorded stream explicitly: one MediaStream
  // built from the canvas VIDEO track + the source AUDIO track. This combine is
  // what carries narration into the file — without it the canvas stream is mute.
  const audio = acquireExportAudio(video);
  const outputStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...(audio.track ? [audio.track] : []),
  ]);

  // ── Export audio diagnostics (req) ──────────────────────────────────────
  // Answers "why is/isn't there audio?" from the console alone.
  const sourceHasAudio = detectSourceHasAudio(video);
  // Only speed sections that actually apply — a disabled one mutes nothing.
  const speedMoments = moments.filter(isActiveSpeed);
  const mutedSectionsCount = speedMoments.filter(
    (m) => (m.speed?.audioMode ?? DEFAULT_SPEED.audioMode) === "mute"
  ).length;
  const speedAudioModes = Array.from(
    new Set(speedMoments.map((m) => m.speed?.audioMode ?? DEFAULT_SPEED.audioMode))
  );
  const exportAudioTracksCount = outputStream.getAudioTracks().length;
  const finalStreamHasAudio = exportAudioTracksCount > 0;
  console.info("[export-audio]", {
    sourceHasAudio,
    audioTrackCount: exportAudioTracksCount,
    audioTrackState: audio.track?.readyState ?? "none",
    audioMode: speedAudioModes.length ? speedAudioModes.join(",") : "source (unmodified)",
    mutedSectionsCount,
    finalStreamHasAudio,
    audioPath: audio.path,
  });

  // Visible warning when the export will be silent (surfaced via onProgress;
  // the panel latches it). Only warn when there's actually a problem — a track
  // present means audio is carried (a genuinely-silent source gets a silent
  // track, which is fine and shouldn't nag the user).
  let audioWarning: string | undefined;
  if (!finalStreamHasAudio) {
    audioWarning =
      sourceHasAudio === true
        ? "Your recording has audio, but this browser couldn't capture it for export. Try Chrome or Edge."
        : "This export has no audio track. If your recording has narration and this looks wrong, try Chrome or Edge.";
  }

  // ── Stage: recorder (sink selection by container) ────────────────────────
  // The render loop + `outputStream` are container-agnostic. WebM is recorded by
  // MediaRecorder (reliable); MP4 is encoded by the WebCodecs sink (avoids
  // Chrome's unstable MediaRecorder MP4 muxer). MP4 falls back to WebM when the
  // browser lacks WebCodecs / MediaStreamTrackProcessor, with a non-fatal notice.
  const requestedContainer: ExportContainer = input.container ?? "webm";
  const videoBitsPerSecond = videoBitrateFor(resolution, fps);
  const mp4Capable =
    requestedContainer === "mp4"
      ? await canEncodeMp4({ width: canvasW, height: canvasH, fps, resolution })
      : false;

  // Build the sink inside a guard: sink construction (and the no-recorder throw)
  // happens AFTER acquireExportAudio() created the per-export AudioContext, and
  // BEFORE the `cleanup` machinery below exists — so any throw here would orphan
  // that AudioContext (which the project notes BREAKS the next export). On
  // failure, release the audio graph + both capture-track sets before rethrowing.
  let sink: ExportSink;
  try {
    if (requestedContainer === "mp4" && mp4Capable) {
      sink = createMp4Sink({
        outputStream,
        width: canvasW,
        height: canvasH,
        fps,
        videoBitrate: videoBitsPerSecond,
        audioBitrate: AUDIO_BITRATE_AAC,
        currentTime: () => video.currentTime,
        onWarning: (msg) => {
          audioWarning = audioWarning ?? msg;
        },
      });
    } else {
      if (requestedContainer === "mp4") {
        audioWarning =
          audioWarning ??
          "MP4 isn't supported in this browser, so the export was rendered as WebM.";
      }
      if (!webmMime) {
        onProgress({
          stage: "unsupported",
          pct: 0,
          message: "Your browser does not support video export. Try Chrome or Edge.",
        });
        throw new ExportError(
          "recorder",
          "This browser can't export video (no supported recorder). Try Chrome or Edge.",
          { detail: { supported: supportedMimes() } }
        );
      }
      sink = createWebmSink({
        outputStream,
        mimeType: webmMime.mime,
        videoBitsPerSecond,
        audioBitsPerSecond: AUDIO_BITRATE_OPUS,
        onAudioDropped: () => {
          audio.cleanup?.();
          audioWarning =
            audioWarning ??
            "Audio couldn't be added to this export in this browser, so it's video-only. Try Chrome or Edge.";
        },
        currentTime: () => video.currentTime,
        audioPath: audio.path,
      });
    }
  } catch (err) {
    audio.cleanup?.();
    for (const t of outputStream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    }
    for (const t of canvasStream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
  const actualContainer = sink.container;
  // The sink resolves this with the encoded blob (or rejects with an ExportError).
  const recordedPromise = sink.done;
  console.info("[export-recorder]", {
    requestedContainer,
    container: actualContainer,
    videoCodec: sink.videoCodec,
    mimeType: sink.mimeType,
    videoBitsPerSecond,
    audioBitsPerSecond:
      actualContainer === "mp4" ? AUDIO_BITRATE_AAC : AUDIO_BITRATE_OPUS,
    hasAudio: finalStreamHasAudio,
  });

  // `base` (the source placement: drawW/drawH + offsetX/offsetY) and `cover`
  // were resolved once above — they depend only on source + canvas + fit mode,
  // all fixed for the export. `base.drawW`/`drawH` (not canvasW/canvasH) drive
  // the pan pixel offsets so an aspect mismatch places the focal point at the
  // canvas centre instead of off-screen; `base.offsetX/Y` shifts the whole
  // placement (Smart-Fit pan / Manual drag).

  // Paint the t=0 frame BEFORE the recorder picks up its first chunk so the
  // start of the export isn't a green/black flash. `composeFrame` re-fills black
  // under the video in case the canvas got reset by the captureStream pipeline.
  composeFrame(ctx, video, recipe, video.currentTime);
  // The recipe already resolved the vignette flag (strict `=== true` so a stray
  // truthy Firestore value can't flip it on); reuse it for the manifest log.
  const vignetteOn = recipe.effects.vignette;

  // ── Lifecycle teardown: cancel / natural-end / error all funnel through one
  // idempotent cleanup so the recorder, capture tracks, rAF and audio graph are
  // fully released. Fixes "Cancel does nothing" + the CPU/audio leak that broke
  // the NEXT export (the per-export AudioContext was never closed). ──
  let rafId = 0;
  let cleanedUp = false;
  const trackCounts = () => ({
    container: actualContainer,
    tracks: outputStream.getTracks().length,
    videoTracks: outputStream.getVideoTracks().length,
    audioTracks: outputStream.getAudioTracks().length,
  });
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (rafId) cancelAnimationFrame(rafId);
    // Hard-teardown the sink (recorder / WebCodecs encoders + readers).
    sink.dispose();
    // Stop EVERY capture track so the canvas + audio pipelines stop the CPU.
    for (const t of outputStream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    }
    for (const t of canvasStream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      video.pause();
    } catch {
      /* ignore */
    }
    // Recording has stopped — safe to release the per-export AudioContext.
    audio.cleanup?.();
    // Restore the preview's pre-export audio + speed state.
    try {
      video.playbackRate = prevPlaybackRate;
      video.muted = prevMuted;
    } catch {
      /* ignore */
    }
    console.info("[export] cleanup-complete", trackCounts());
  };

  try {
    sink.start();
  } catch (err) {
    // start() can still throw even though the capability probe passed (start-time
    // codec/track negotiation, a track already ended). Cleanup is otherwise only
    // reached via the recordedPromise finally — which we never get to — so tear
    // the pipeline down HERE (idempotent cleanup stops both track sets, closes
    // the per-export AudioContext, restores the preview) before a tagged error.
    cleanup();
    if (err instanceof ExportError) throw err;
    throw new ExportError(
      "recorder",
      "This browser couldn't start the video encoder for the export. Try Chrome or Edge.",
      { cause: err, detail: { container: actualContainer } }
    );
  }
  console.info("[export] started", trackCounts());

  onProgress({ stage: "rendering", pct: 0, warning: audioWarning });

  // Drive a draw loop
  let stopped = false;
  let aborted = false;
  let loggedDecile = -1;
  let frame = 0;
  const abortHandler = () => {
    aborted = true;
    stopped = true;
    console.info("[export] cancel-requested", {
      at: +video.currentTime.toFixed(2),
    });
    if (rafId) cancelAnimationFrame(rafId);
    // Stop the sink so it finalizes and `recordedPromise` (sink.done) resolves —
    // otherwise the await below hangs forever and cleanup never runs. The partial
    // blob is discarded below (`if (aborted) throw`).
    sink.stop();
  };
  signal?.addEventListener("abort", abortHandler);

  // Swallow the AbortError that fires when the user cancels mid-export and we
  // pause the element before the play promise settles. The pause itself does
  // the right thing — the only thing rejecting is the play() promise. Anything
  // else (most likely an autoplay-policy NotAllowedError) is fatal: the recorder
  // has already started, so tear it down BEFORE surfacing a clear render-stage
  // error, otherwise the recorder + capture tracks would leak.
  try {
    await video.play();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      // benign — cancellation; the abort handler tears the pipeline down.
    } else {
      signal?.removeEventListener("abort", abortHandler);
      cleanup();
      const d = describeError(err);
      const msg =
        d.name === "NotAllowedError"
          ? "The browser blocked the playback needed to render this export. Click anywhere on the page, then run the export again."
          : "Couldn't start playing the source video to render the export.";
      throw new ExportError("render", msg, { cause: err, detail: { name: d.name } });
    }
  }

  // Dev-mode: log the per-export render manifest + a few camera
  // snapshots so the user can verify exactly what's about to be baked
  // into the file. The manifest answers "where did this dark gradient
  // come from?" by listing every conditional layer and its enabled
  // state for THIS export. Production builds skip both.
  if (process.env.NODE_ENV !== "production") {
    logRenderManifest({
      vignette: vignetteOn,
      watermark: !!input.applyWatermark,
      clickHighlights: effects.clickHighlights === true,
      clickHighlightStyle: effects.clickHighlightStyle,
      clickHighlightSize: effects.clickHighlightSize,
      momentCount: moments.length,
      canvasW,
      canvasH,
      base,
      background: bgActive ? bgMode : "none",
    });
    logExportCameraSnapshots(moments, effects.autoZoom, base);
  }

  // Cut/Speed export diagnostics (req): the source→output map. Active cuts are
  // removed by pausing the recorder while we seek past them (real-time capture,
  // so the paused span is genuinely absent from the file); speed uses
  // playbackRate. Reported honestly so "did cuts/speed apply?" is answerable.
  {
    const map = recipe.timelineMap;
    const speedSections = moments.filter(isActiveSpeed).length;
    console.info("[cut-map]", {
      sourceDuration: +map.sourceDuration.toFixed(2),
      activeCuts: map.activeCuts,
      inactiveCuts: map.inactiveCuts,
      totalRemoved: +map.totalRemoved.toFixed(2),
      outputDuration: +map.outputDuration.toFixed(2),
      speedSections,
      segments: map.segments.map((s) => ({
        src: [+s.sourceStart.toFixed(2), +s.sourceEnd.toFixed(2)],
        out: [+s.outputStart.toFixed(2), +s.outputEnd.toFixed(2)],
        x: s.speedMultiplier,
      })),
      timingMode: "realtime-playbackRate + recorder-pause-on-cut",
    });
  }

  // Cut removal: while seeking past an active cut, the recorder is PAUSED so
  // the skipped span is never captured (a plain seek would record a frozen
  // frame). Resumed on `seeked`. This makes the file genuinely shorter.
  let seekingPastCut = false;

  const draw = () => {
    if (stopped) return;
    // Idle while a cut-seek is in flight — sink is paused, capture nothing.
    if (seekingPastCut) {
      rafId = requestAnimationFrame(draw);
      return;
    }
    // Active cut under the playhead → pause, seek past it, resume on seeked.
    const cut = activeCutAt(moments, video.currentTime);
    if (cut) {
      seekingPastCut = true;
      // Pause the sink so the skipped span is never captured (WebM: recorder
      // pause; MP4: drop frames + accumulate the gap so output is shorter).
      sink.pause();
      const from = video.currentTime;
      const to = Math.min(input.duration, cut.endTime + 1e-3);
      console.info("[export-cut]", {
        skippedRange: [+cut.startTime.toFixed(2), +cut.endTime.toFixed(2)],
        from: +from.toFixed(2),
        to: +to.toFixed(2),
      });
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        seekingPastCut = false;
        sink.resume();
      };
      video.addEventListener("seeked", onSeeked);
      try {
        video.currentTime = to;
      } catch {
        /* ignore */
      }
      rafId = requestAnimationFrame(draw);
      return;
    }
    // Speed sections: real-time capture at a higher playbackRate makes the
    // recorded output genuinely shorter for that span (not faked). Audio
    // follows the section's mode — muted ONLY for that section via the audio
    // mixer (never the whole export), kept/pitch-shifted otherwise.
    const activeSpeed = applySpeedForFrame(video, moments);
    audio.setSectionMuted(activeSpeed?.audioMode === "mute");
    // Composite this frame through the SHARED render core — black backdrop,
    // Canvas-Fit background, source + per-moment camera, click-highlight,
    // vignette, watermark — exactly the layers the cloud worker bakes too.
    composeFrame(ctx, video, recipe, video.currentTime);

    // progress
    frame++;
    if (input.duration > 0) {
      const pct = Math.min(0.99, video.currentTime / input.duration);
      // Re-send the latched warning each tick so a LATE warning (e.g. the MP4
      // sink's video-only watchdog firing mid-render) reaches the panel.
      onProgress({
        stage: "rendering",
        pct,
        ...(audioWarning ? { warning: audioWarning } : {}),
      });
      const decile = Math.floor(pct * 10);
      if (decile !== loggedDecile) {
        loggedDecile = decile;
        console.info("[export-render-loop]", {
          frame,
          currentTime: +video.currentTime.toFixed(2),
          progress: +pct.toFixed(2),
          playbackRate: video.playbackRate,
        });
      }
    }

    if (video.ended || video.currentTime >= input.duration - 0.05) {
      stopped = true;
      sink.stop();
      return;
    }

    rafId = requestAnimationFrame(draw);
  };
  rafId = requestAnimationFrame(draw);

  // Safety stop
  const maxDurationMs = Math.max(1, input.duration + 5) * 1000;
  const safety = setTimeout(() => {
    if (!stopped) {
      stopped = true;
      sink.stop();
    }
  }, maxDurationMs);

  let blob: Blob;
  try {
    blob = await recordedPromise;
  } finally {
    clearTimeout(safety);
    signal?.removeEventListener("abort", abortHandler);
    cleanup();
  }

  if (aborted) {
    console.info("[export] canceled");
    throw new Error("Export cancelled");
  }
  console.info("[export] completed", { size: blob.size, container: actualContainer });
  onProgress({ stage: "rendering", pct: 1 });

  return { blob, container: actualContainer };
}

// ─────────────────────────────────────────────────────────────────────────
// EXPORT RENDER MANIFEST — the contract for what gets baked into the file —
// now lives in `@/lib/render/compose-frame` (`composeFrame`), the single
// per-frame compositor shared by this browser exporter and the cloud worker.
// The ordered layers (black backdrop → Canvas-Fit background → source+camera →
// click-highlight → vignette → watermark) are documented there. The dev-mode
// `[export] render manifest` log below mirrors that contract for the console.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Set the source element's playbackRate + pitch handling for the speed section
 * under the current playhead, and RETURN that section (or null). Real-time
 * MediaRecorder capture then records that span faster, shortening the output.
 *
 * Audio (un)muting is intentionally NOT done here — the caller applies it via
 * the export audio mixer's `setSectionMuted`. Toggling `video.muted` would be
 * wrong for the Web Audio path (a muted element feeds the source node silence,
 * killing audio for the WHOLE export), so mute is scoped to the mixer instead.
 * Pitch: "keep" lets pitch shift up with speed; "mute"/"pitch-correct" preserve
 * pitch. Reset to 1× / pitch-preserved outside sections.
 */
function applySpeedForFrame(
  video: HTMLVideoElement,
  moments: DetectedMoment[]
): SpeedSettings | null {
  const sp = activeSpeedAt(moments, video.currentTime);
  const rate = sp ? Math.max(0.0625, Math.min(16, sp.multiplier)) : 1;
  if (Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
  try {
    (video as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = sp
      ? sp.audioMode !== "keep"
      : true;
  } catch {
    /* not supported — ignore */
  }
  return sp;
}

/**
 * Dev-mode render manifest — logged once per export at the start of the
 * render loop. Lists every layer the canvas will paint and whether it
 * is enabled for THIS export. The contract on `applyCameraFrame` is the
 * canonical list of what can be drawn; this log makes that contract
 * observable from the console so the user can answer "what's in this
 * file?" without inspecting source.
 *
 * If you add a new conditional draw layer to the export, extend this
 * type AND the contract block above `applyCameraFrame`. The render
 * manifest is the user-facing audit surface — keep it accurate.
 */
function logRenderManifest(state: {
  vignette: boolean;
  watermark: boolean;
  clickHighlights: boolean;
  clickHighlightStyle: "ring" | "pulse" | "burst";
  clickHighlightSize: number;
  momentCount: number;
  canvasW: number;
  canvasH: number;
  base: BasePlacement;
  background: BackgroundMode | "none";
}): void {
  console.groupCollapsed(
    `[export] render manifest — ${state.canvasW}×${state.canvasH}, ${state.momentCount} moments`
  );
  console.table([
    {
      layer: "1. Black backdrop",
      enabled: "ALWAYS",
      detail: "Fills canvas before video draw — masked by cover-fit video",
    },
    {
      layer: "1b. Canvas background",
      enabled: state.background === "none" ? "off" : "ON",
      detail:
        state.background === "none"
          ? "Fit mode covers / no empty space"
          : `"${state.background}" fills the empty space (Canvas Fit)`,
    },
    {
      layer: "2. Source video",
      enabled: "ALWAYS",
      detail: `place=${state.base.drawW.toFixed(0)}×${state.base.drawH.toFixed(0)} @ offset(${state.base.offsetX.toFixed(0)},${state.base.offsetY.toFixed(0)})`,
    },
    {
      layer: "3. Click highlight",
      enabled: state.clickHighlights ? "ON" : "off",
      detail: state.clickHighlights
        ? `style=${state.clickHighlightStyle}, size=${state.clickHighlightSize} (per click-highlight moment)`
        : "effects.clickHighlights !== true",
    },
    {
      layer: "4. Vignette",
      enabled: state.vignette ? "ON" : "off",
      detail: state.vignette
        ? "Radial darkening at frame edges (effects.vignette === true)"
        : "effects.vignette !== true",
    },
    {
      layer: "5. Watermark",
      enabled: state.watermark ? "ON" : "off",
      detail: state.watermark
        ? "Bottom-right pill (free tier)"
        : "input.applyWatermark !== true (paid plan)",
    },
  ]);
  console.groupEnd();
}

/**
 * Dev-mode safety check — sample the shared resolver at a handful of
 * timestamps and log the camera snapshots that the export will apply. The
 * editor's "Camera diagnostics" toggle hits the same resolver on the same
 * `moments` array; copy-paste the two console outputs and they MUST match.
 * If they diverge, the bug is in the consumers (the CSS transform string
 * builder or the canvas transform chain), not in the resolver.
 */
function logExportCameraSnapshots(
  moments: DetectedMoment[],
  autoZoom: number,
  base: BasePlacement
): void {
  if (moments.length === 0) return;
  const samples: number[] = [];
  for (const m of moments.slice(0, 4)) {
    const mid = (m.startTime + m.endTime) / 2;
    samples.push(m.startTime + 0.05, mid, m.endTime - 0.05);
  }
  const rows = samples.map((t) =>
    cameraDiagnostic(moments, t, {
      autoZoom,
      drawW: base.drawW,
      drawH: base.drawH,
    })
  );
  console.groupCollapsed(
    `[export] camera snapshots (autoZoom=${autoZoom}, place=${base.drawW.toFixed(0)}×${base.drawH.toFixed(0)})`
  );
  console.table(
    rows.map((r) => ({
      t: r.t.toFixed(2),
      moment: r.momentId,
      scale: r.scale.toFixed(3),
      cx: r.cx.toFixed(3),
      cy: r.cy.toFixed(3),
      panXPct: r.panXPct.toFixed(2),
      panYPct: r.panYPct.toFixed(2),
      tx: r.canvasTranslate.tx.toFixed(1),
      ty: r.canvasTranslate.ty.toFixed(1),
    }))
  );
  console.groupEnd();
}

/**
 * Upload a rendered export blob using a permit that was issued by
 * `POST /api/billing/export-permit`. The permit creates the Firestore
 * export doc server-side (with status: "permitted") and tells the client
 * exactly where to upload the bytes. This function:
 *
 *   1. Uploads the blob to `uploadPath` (Storage rules enforce ownership
 *      + size + MIME; Firestore rules forbid the client from creating the
 *      export doc, so a bytes upload without a permit is orphaned and
 *      invisible).
 *   2. Patches the export doc with the completion whitelist:
 *      status: "permitted" → "ready", + storagePath, exportUrl, fileSize,
 *      completedAt. Firestore rules forbid touching resolution / format /
 *      applyWatermark / projectId / projectTitle here.
 *   3. Updates the parent project doc to surface the latest export URL.
 *
 * The caller (RealExportPanel) is responsible for calling /export-permit
 * BEFORE rendering, so `applyWatermark` was already determined at permit
 * time and passed to `renderProjectClientSide`.
 */
export async function uploadExport({
  uid,
  projectId,
  exportId,
  uploadPath,
  blob,
  onProgress,
  signal,
}: {
  uid: string;
  projectId: string;
  exportId: string;
  uploadPath: string;
  blob: Blob;
  /** Byte-level upload progress, 0..1. A 4K export is ~300+ MB, so a
   *  feedback-less upload reads as a hang — the panel surfaces this %. */
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}): Promise<{ exportId: string; downloadURL: string }> {
  const { db, storage } = getFirebase();

  const sRef = storageRef(storage, uploadPath);
  console.info("[export-upload] started", {
    // Path only — NEVER the download URL (it carries an access token).
    storagePath: uploadPath,
    bytes: blob.size,
    contentType: safeVideoContentType(blob.type),
  });

  // Resumable upload so we can report real progress (uploadBytes is one-shot
  // and exposes none). Cancelling the export aborts the in-flight upload too.
  // Firebase Storage failures (CORS not configured for this domain, rules
  // denial, expired auth, retry-limit) are mapped to a clear, actionable
  // reason so the user never sees a raw "Internal Error".
  try {
    await new Promise<void>((resolve, reject) => {
      const task = uploadBytesResumable(sRef, blob, {
        // Bare media type (no MediaRecorder codecs) so the stored Content-Type
        // is a valid header for downstream typed clients.
        contentType: safeVideoContentType(blob.type),
      });
      const onAbort = () => task.cancel();
      signal?.addEventListener("abort", onAbort);
      task.on(
        "state_changed",
        (snap) => {
          if (snap.totalBytes > 0) {
            onProgress?.(snap.bytesTransferred / snap.totalBytes);
          }
        },
        (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }
      );
    });

    const downloadURL = await getDownloadURL(sRef);

    await setDoc(
      doc(db, "users", uid, "exports", exportId),
      {
        storagePath: uploadPath,
        exportUrl: downloadURL,
        fileSize: blob.size,
        status: "ready",
        completedAt: serverTimestamp(),
      },
      { merge: true }
    );

    await updateDoc(doc(db, "users", uid, "projects", projectId), {
      exportUrl: downloadURL,
      status: "exported",
      updatedAt: serverTimestamp(),
    });

    console.info("[export-upload] success", { storagePath: uploadPath, downloadUrlExists: !!downloadURL });
    return { exportId, downloadURL };
  } catch (err) {
    // Cancellation surfaces here as storage/canceled — let the provider's
    // abort handling treat it as a cancel, not a failure.
    if (signal?.aborted) throw err;
    const d = describeError(err);
    console.error("[export-upload] failed", { storagePath: uploadPath, ...d });
    // The bytes upload + getDownloadURL throw storage/* codes; the completion
    // setDoc/updateDoc throw Firestore codes (permission-denied / unavailable /
    // failed-precondition). Map each to an accurate reason — a Firestore failure
    // means the render + upload SUCCEEDED and only the record write failed, so
    // don't dress it up in storage-flavoured text.
    const isStorage = (d.code ?? "").startsWith("storage/");
    const friendly = isStorage
      ? friendlyStorageMessage(d.code, d.message)
      : "Your export uploaded, but saving its record failed (permission or network). Please retry.";
    throw new ExportError("upload", friendly, {
      cause: err,
      detail: { code: d.code, storagePath: uploadPath, bytes: blob.size },
    });
  }
}

export function pickedMimeAvailable(): boolean {
  return pickMime() !== null;
}

export function pickedMimeExt(): string {
  return pickMime()?.ext ?? "webm";
}

/** The MIME the recorder will use, or null if none is supported (debug panel). */
export function pickedMimeType(): string | null {
  return pickMime()?.mime ?? null;
}

export { ExportError } from "./export-error";
export type { ExportStage } from "./export-error";
