"use client";

import {
  serverTimestamp,
  setDoc,
  doc,
  updateDoc,
} from "firebase/firestore";
import { getDownloadURL, ref as storageRef, uploadBytes } from "firebase/storage";
import { getFirebase } from "@/lib/firebase/client";
import {
  resolveCameraFrame,
  canvasTranslateFor,
  cameraDiagnostic,
} from "@/lib/timeline/camera";
import { coverFitDims } from "@/lib/timeline/cover";
import { resolveOutputDims } from "@/lib/timeline/output-dims";
import { activeSpeedAt, outputDurationFor } from "@/lib/timeline/crop-speed";
import { probeVideoBottomBand } from "@/lib/recording/health-check";
import { drawClickHighlight } from "@/lib/timeline/click-highlight";
import type {
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
} from "@/lib/firebase/schema";

const PREFERRED_MIMES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8,opus",
  "video/webm",
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
}

interface RenderInput {
  uid: string;
  projectId: string;
  projectTitle: string;
  video: HTMLVideoElement;
  duration: number;
  moments: DetectedMoment[];
  effects: EffectsSettings;
  resolution: "1080p" | "4K";
  fps: 30 | 60;
  format: ExportFormat;
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

/**
 * Render the source video to a canvas, applying preview transforms per moment,
 * and capture via MediaRecorder. Returns a Blob that the caller can download
 * and/or upload.
 *
 * Honest limits:
 * - Audio is included by piping the source video's MediaElement via captureStream.
 * - 4K is capped to 1920x1080 on the canvas to keep the browser stable.
 * - Some browsers don't support MediaRecorder of MP4 — we fall back to WebM.
 */
export async function renderProjectClientSide(
  input: RenderInput
): Promise<Blob> {
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

  const mime = pickMime();
  if (!mime) {
    onProgress({
      stage: "unsupported",
      pct: 0,
      message:
        "Your browser does not support MediaRecorder for video. Try Chrome or Edge.",
    });
    throw new Error("MediaRecorder not supported");
  }

  onProgress({ stage: "preparing", pct: 0 });

  // Source video dims — used by drawCover. Default to 16:9 if not yet known.
  const sourceW = video.videoWidth || 1920;
  const sourceH = video.videoHeight || 1080;

  // Output size — resolved by the SHARED `resolveOutputDims` helper so the
  // editor preview and this renderer always agree on framing. The default
  // "Source" mode sets the canvas aspect EQUAL to the source aspect, so the
  // full captured viewport is preserved with zero crop. The fixed-aspect
  // presets ("YouTube 16:9", "TikTok 9:16", legacy verticalExport) are the
  // only paths that crop, via `coverFitDims` (object-fit: cover semantics).
  //
  // Note on `"Custom"`: the literal is still in `ExportFormat` for type
  // compatibility with persisted defaults, but the UI no longer exposes
  // it (no width/height/bitrate panel exists yet). It maps to the safe
  // 16:9 crop fallback inside `resolveOutputDims` until the Custom
  // configuration panel ships. Don't add a `"Custom"` branch without also
  // adding the UI for entering the dimensions; otherwise the renderer
  // can't know what to produce.
  const out = resolveOutputDims(sourceW, sourceH, resolution, format, effects);
  const canvasW = out.canvasW;
  const canvasH = out.canvasH;
  const debugBorders = debugBordersEnabled();

  // Cover-fit drives both the drawImage destination rect AND the per-frame
  // diagnostics below; compute it once here (also recomputed verbatim at
  // line ~209, but we need it now for the audit log).
  const auditCover = coverFitDims(sourceW, sourceH, canvasW, canvasH);

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
    const destX = canvasW / 2 - auditCover.drawW / 2;
    const destY = canvasH / 2 - auditCover.drawH / 2;
    // Bottom gap with the camera at identity (worst case for a bottom band).
    const gapBelow = Math.max(0, canvasH - (destY + auditCover.drawH));
    console.info("[export] dimension audit", {
      videoWidth: sourceW,
      videoHeight: sourceH,
      sourceAspect: srcAspect.toFixed(4),
      format,
      verticalExport: effects.verticalExport === true,
      mode: out.mode,
      resolution,
      canvasWidth: canvasW,
      canvasHeight: canvasH,
      exportWidth: canvasW,
      exportHeight: canvasH,
      exportAspect: outAspect.toFixed(4),
      willCrop: out.cropped,
      drawImageSourceRect: { sx: 0, sy: 0, sw: sourceW, sh: sourceH },
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
    if (gapBelow > 0.5 || destY > 0.5) {
      console.warn(
        `[export] renderer leaves ${gapBelow.toFixed(1)}px below / ${Math.max(0, destY).toFixed(1)}px above the video uncovered — these rows are BLACK-filled, not green. A green band there is NOT from this renderer.`
      );
    }
    if (out.cropped && Math.abs(srcAspect - outAspect) > 0.001) {
      console.warn(
        `[export] CROP PRESET active (${out.mode}): source ${srcAspect.toFixed(3)} ≠ output ${outAspect.toFixed(3)} — content at the ${
          srcAspect > outAspect ? "left/right" : "top/bottom"
        } edges will be cropped. Pick "Source" format to keep the full viewport.`
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
          ? `GREEN BAND IN SOURCE (${probe.bandHeightPx}px, bottom-row ${(probe.bottomRowGreenRatio * 100).toFixed(0)}% green) — baked in at capture, NOT a render bug. Crop it (cropBottomBand) to remove.`
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
  if (!ctx) throw new Error("Could not get 2D context");

  // Pre-fill black BEFORE the canvas is captured so MediaRecorder never
  // sees uninitialised GPU pixels (which often encode as green/magenta on
  // H.264 — that was the "green bar" in the broken export).
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Stream from canvas + audio from video element if possible
  const canvasStream = canvas.captureStream(fps);
  let audioTrack: MediaStreamTrack | null = null;
  try {
    // captureStream on HTMLMediaElement is non-standard but supported in Chromium.
    type CaptureStream = () => MediaStream;
    const captureStream = (video as unknown as { captureStream?: CaptureStream })
      .captureStream;
    if (captureStream) {
      const stream = captureStream.call(video) as MediaStream;
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length) {
        audioTrack = audioTracks[0];
        canvasStream.addTrack(audioTrack);
      }
    }
  } catch (err) {
    console.warn("[export] audio capture failed", err);
  }

  const recorder = new MediaRecorder(canvasStream, {
    mimeType: mime.mime,
    videoBitsPerSecond: resolution === "4K" ? 12_000_000 : 6_000_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const recordedPromise = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime.mime }));
    recorder.onerror = () => reject(new Error("MediaRecorder error"));
  });

  // Rewind + play
  video.pause();
  video.currentTime = 0;
  video.muted = false;
  await new Promise<void>((resolve) => {
    const onSeek = () => {
      video.removeEventListener("seeked", onSeek);
      resolve();
    };
    video.addEventListener("seeked", onSeek);
  });

  // Pre-compute cover-fit dimensions once — they only depend on source +
  // canvas sizes, both of which are fixed for the duration of the export.
  // `drawW`/`drawH` are the SCALED source dimensions inside the
  // transformed frame. They (not canvasW/canvasH) drive the pan pixel
  // offsets so vertical exports of 16:9 recordings (and any other aspect
  // mismatch) place the focal point at the canvas centre instead of
  // off-screen.
  const cover = coverFitDims(sourceW, sourceH, canvasW, canvasH);

  // Paint the t=0 frame BEFORE the recorder picks up its first chunk so the
  // start of the export isn't a green/black flash. Also re-fills black under
  // the video in case the canvas got reset by the captureStream pipeline.
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvasW, canvasH);
  applyCameraFrame(
    ctx,
    video,
    moments,
    video.currentTime,
    effects,
    canvasW,
    canvasH,
    cover,
    debugBorders
  );
  if (debugBorders) drawDebugCanvasBorder(ctx, canvasW, canvasH);
  // Defensive boolean coercion so a stray truthy value (e.g. an old
  // string "true" left in Firestore by a hand-edit) can't flip the
  // vignette on. The schema field is `vignette?: boolean` — only a
  // literal `true` should opt in to the radial darkening.
  const vignetteOn = effects.vignette === true;
  if (vignetteOn) drawVignette(ctx, canvasW, canvasH);
  if (input.applyWatermark) drawWatermark(ctx, canvasW, canvasH);

  recorder.start(500);

  onProgress({ stage: "rendering", pct: 0 });

  // Drive a draw loop
  let stopped = false;
  let aborted = false;
  const abortHandler = () => {
    aborted = true;
    stopped = true;
  };
  signal?.addEventListener("abort", abortHandler);

  // Swallow the AbortError that fires when the user cancels mid-export and we
  // pause the element before the play promise settles. The pause itself does
  // the right thing — the only thing rejecting is the play() promise.
  try {
    await video.play();
  } catch (err) {
    if (!(err instanceof DOMException) || err.name !== "AbortError") throw err;
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
      cover,
    });
    logExportCameraSnapshots(moments, effects.autoZoom, cover);
  }

  // Crop/Speed export diagnostics (req): counts, source vs output duration,
  // and the timing strategy. We use real-time playbackRate (no offline timing
  // map), reported honestly so "did speed/crop apply?" is answerable.
  {
    const cropSections = moments.filter((m) => m.effectType === "crop").length;
    const speedSections = moments.filter((m) => m.effectType === "speed-up").length;
    console.info("[export] crop/speed", {
      cropSections,
      speedSections,
      sourceDuration: +input.duration.toFixed(2),
      outputDuration: +outputDurationFor(moments, input.duration).toFixed(2),
      timingMode: "realtime-playbackRate",
      timingMapGenerated: false,
    });
  }

  const draw = () => {
    if (stopped) return;
    // Speed sections: real-time capture at a higher playbackRate makes the
    // recorded output genuinely shorter for that span (not faked). Audio
    // follows the section's mode (mute / keep-shifted / pitch-corrected).
    applySpeedForFrame(video, moments);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvasW, canvasH);
    applyCameraFrame(
      ctx,
      video,
      moments,
      video.currentTime,
      effects,
      canvasW,
      canvasH,
      cover,
      debugBorders
    );
    if (debugBorders) drawDebugCanvasBorder(ctx, canvasW, canvasH);

    // Vignette + watermark sit OUTSIDE the camera transform so they
    // stay anchored to the output frame (not zooming with the video).
    // The vignette gate uses `vignetteOn` (the same `=== true` strict
    // check the priming paint above used) so the draw loop can't drift
    // out of sync with the export-start state.
    if (vignetteOn) drawVignette(ctx, canvasW, canvasH);
    if (input.applyWatermark) drawWatermark(ctx, canvasW, canvasH);

    // progress
    if (input.duration > 0) {
      onProgress({ stage: "rendering", pct: Math.min(0.99, video.currentTime / input.duration) });
    }

    if (video.ended || video.currentTime >= input.duration - 0.05) {
      stopped = true;
      recorder.stop();
      return;
    }

    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  // Safety stop
  const maxDurationMs = Math.max(1, input.duration + 5) * 1000;
  const safety = setTimeout(() => {
    if (!stopped) {
      stopped = true;
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
  }, maxDurationMs);

  let blob: Blob;
  try {
    blob = await recordedPromise;
  } finally {
    clearTimeout(safety);
    signal?.removeEventListener("abort", abortHandler);
    video.pause();
    // Restore normal playback so the editor preview isn't left sped/muted.
    try {
      video.playbackRate = 1;
    } catch {
      /* ignore */
    }
  }

  if (aborted) throw new Error("Export cancelled");
  onProgress({ stage: "rendering", pct: 1 });

  return blob;
}

/**
 * Apply the moment-aware camera transform for the given playhead time,
 * draw the video frame, and draw any in-camera overlays. The canvas
 * transform chain (translate→scale→translate→drawImage→overlays) is
 * defined here in ONE place — both the t=0 priming paint and the main
 * draw loop delegate to this function. Identity outside moments — the
 * same transform chain runs so the source video is always centred.
 *
 * ─────────────────────────────────────────────────────────────────────
 * EXPORT RENDER MANIFEST — the only contract for what gets baked in
 * ─────────────────────────────────────────────────────────────────────
 *
 * The exporter draws into a HIDDEN OffscreenCanvas-style 2D context. It
 * does NOT capture from the preview DOM. Preview-only CSS (control bar
 * gradients, the focus-box drag overlay, the camera-path SVG, debug
 * overlays, etc.) is structurally incapable of leaking into the file.
 * Whatever the file contains MUST come from one of the four ordered
 * layers below.
 *
 *   1. BLACK BACKDROP — `ctx.fillStyle = "#000"; ctx.fillRect(...)`,
 *      drawn EVERY frame before the video. Visible only when the video
 *      doesn't fully cover the canvas — `coverFitDims` is designed to
 *      always cover, so in practice this is dead pixels.
 *
 *   2. SOURCE VIDEO — `ctx.drawImage(video, ...)` inside the camera
 *      transform. The user's recording, framed by the resolver's
 *      `{scale, cx, cy}`.
 *
 *   3. CLICK HIGHLIGHT (conditional) — gated on
 *      `effects.clickHighlights === true` AND the active moment is a
 *      `click-highlight`. Drawn INSIDE the camera transform so it
 *      scales with zoom.
 *
 *   4. VIGNETTE (conditional) — gated on `effects.vignette === true`.
 *      Drawn OUTSIDE the camera transform by the caller, anchored to
 *      the output frame. Strictly opt-in — the schema field is
 *      `vignette?: boolean` and the default is undefined → falsy →
 *      not drawn.
 *
 *   5. WATERMARK (conditional) — gated on `input.applyWatermark`,
 *      which is set by the server's export-permit endpoint based on
 *      the user's plan (free tier gets watermarked, paid tiers don't).
 *      Drawn OUTSIDE the camera transform by the caller. A small pill
 *      in the bottom-right corner — not a full-frame gradient.
 *
 * Adding a 6th draw layer (any new gradient, mask, badge, watermark
 * variant, debug overlay …) means updating this manifest AND the
 * dev-mode `[export] render manifest` log emitted at render start.
 *
 * Note `effects` is the FULL `EffectsSettings` (not just `autoZoom`)
 * because layers 3 and 4 need fields from the same record.
 */
/**
 * Set the source element's playbackRate (+ audio mode) for the speed section
 * under the current playhead. Real-time MediaRecorder capture then records
 * that span faster, shortening the output. Audio: "mute" silences the element
 * (its captured track goes quiet), "keep" lets pitch shift up, "pitch-correct"
 * time-stretches without pitch change. Reset to 1× / unmuted outside sections.
 */
function applySpeedForFrame(
  video: HTMLVideoElement,
  moments: DetectedMoment[]
): void {
  const sp = activeSpeedAt(moments, video.currentTime);
  const rate = sp ? Math.max(0.0625, Math.min(16, sp.multiplier)) : 1;
  if (Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
  const wantMute = !!(sp && sp.audioMode === "mute");
  if (video.muted !== wantMute) video.muted = wantMute;
  try {
    (video as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = sp
      ? sp.audioMode !== "keep"
      : true;
  } catch {
    /* not supported — ignore */
  }
}

function applyCameraFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  moments: DetectedMoment[],
  t: number,
  effects: EffectsSettings,
  canvasW: number,
  canvasH: number,
  cover: { drawW: number; drawH: number },
  debugBorders = false
): void {
  // Single source of truth — same call the preview makes. Returns the
  // moment's camera state OR identity when no moment overlaps.
  const { camera, moment } = resolveCameraFrame(moments, t, {
    autoZoom: effects.autoZoom,
  });
  const { tx, ty } = canvasTranslateFor(camera, cover.drawW, cover.drawH);

  ctx.save();
  ctx.translate(canvasW / 2, canvasH / 2);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(tx, ty);
  ctx.drawImage(video, -cover.drawW / 2, -cover.drawH / 2, cover.drawW, cover.drawH);

  // DEBUG: RED border = the video's drawImage destination bounds. Line
  // width is divided by scale so it renders ~4px regardless of zoom.
  if (debugBorders) {
    ctx.lineWidth = 4 / camera.scale;
    ctx.strokeStyle = "rgba(255,0,0,0.95)";
    ctx.strokeRect(-cover.drawW / 2, -cover.drawH / 2, cover.drawW, cover.drawH);
  }

  // Click-highlight overlay — drawn INSIDE the camera transform so the
  // ring/pulse/burst scales with the zoom, matching the preview where
  // the CSS scale on the wrapper magnifies the highlight's child span.
  // Skipped when the user has clickHighlights off OR the active moment
  // isn't a click-highlight type.
  if (
    effects.clickHighlights &&
    moment &&
    moment.effectType === "click-highlight"
  ) {
    const dur = Math.max(0.1, moment.endTime - moment.startTime);
    drawClickHighlight(
      ctx,
      {
        cx: moment.focusRegion.x + moment.focusRegion.width / 2,
        cy: moment.focusRegion.y + moment.focusRegion.height / 2,
        progress: Math.max(0, Math.min(1, (t - moment.startTime) / dur)),
        style: effects.clickHighlightStyle,
        sizePct: effects.clickHighlightSize,
      },
      cover.drawW,
      cover.drawH,
      canvasW
    );
  }

  ctx.restore();
}

/**
 * Soft radial dark fade at the frame edges — the canvas equivalent of
 * the preview's CSS
 * `bg-[radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.25) 100%)]`.
 * Drawn AFTER the camera transform completes (outside `ctx.save()` /
 * `ctx.restore()`) so it anchors to the output frame and doesn't zoom
 * with the video. Opt-in via `effects.vignette` so the user controls
 * whether the gradient gets baked in.
 */
/**
 * DEBUG: BLUE border = the canvas (export frame) bounds. Drawn OUTSIDE the
 * camera transform so it's always flush to the encoded frame edges. Pair
 * with the RED video-bounds border in `applyCameraFrame`: at rest (no
 * zoom) RED should sit exactly under BLUE. Any visible BLUE-only strip is
 * a region the video doesn't cover — i.e. a renderer-introduced band.
 * Inset by half the line width so the stroke isn't clipped at the edge.
 */
function drawDebugCanvasBorder(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number
): void {
  const lw = 4;
  ctx.save();
  ctx.lineWidth = lw;
  ctx.strokeStyle = "rgba(0,120,255,0.95)";
  ctx.strokeRect(lw / 2, lw / 2, canvasW - lw, canvasH - lw);
  ctx.restore();
}

function drawVignette(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number
): void {
  const gradient = ctx.createRadialGradient(
    canvasW / 2,
    canvasH / 2,
    Math.min(canvasW, canvasH) * 0.6,
    canvasW / 2,
    canvasH / 2,
    Math.max(canvasW, canvasH) / 2
  );
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,0.25)");
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.restore();
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
  cover: { drawW: number; drawH: number };
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
      layer: "2. Source video",
      enabled: "ALWAYS",
      detail: `cover=${state.cover.drawW.toFixed(0)}×${state.cover.drawH.toFixed(0)}, framed by resolver`,
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
  cover: { drawW: number; drawH: number }
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
      drawW: cover.drawW,
      drawH: cover.drawH,
    })
  );
  console.groupCollapsed(
    `[export] camera snapshots (autoZoom=${autoZoom}, cover=${cover.drawW.toFixed(0)}×${cover.drawH.toFixed(0)})`
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
 * Draw the free-tier watermark in the bottom-right corner. Sized relative
 * to the canvas height so it reads at any resolution. Uses a pill shape
 * with a subtle backdrop tint to stay legible on both light and dark video
 * content.
 *
 * NOTE: this is rendered by the client. A tampered client could omit it.
 * Tamper-proof watermarking requires server-side rendering — documented as
 * a follow-up in the plan.
 */
function drawWatermark(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number
) {
  const fontSize = Math.max(18, Math.round(canvasH * 0.024));
  const padX = Math.round(fontSize * 0.9);
  const padY = Math.round(fontSize * 0.45);
  const text = "Made with Framevo";

  ctx.save();
  ctx.font = `600 ${fontSize}px -apple-system, "Segoe UI", system-ui, sans-serif`;
  const textW = ctx.measureText(text).width;
  const boxW = textW + padX * 2;
  const boxH = fontSize + padY * 2;
  const x = canvasW - boxW - Math.round(canvasH * 0.035);
  const y = canvasH - boxH - Math.round(canvasH * 0.035);
  const r = boxH / 2;

  // Backdrop pill — translucent black for contrast.
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + boxW - r, y);
  ctx.arcTo(x + boxW, y, x + boxW, y + r, r);
  ctx.lineTo(x + boxW, y + boxH - r);
  ctx.arcTo(x + boxW, y + boxH, x + boxW - r, y + boxH, r);
  ctx.lineTo(x + r, y + boxH);
  ctx.arcTo(x, y + boxH, x, y + boxH - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill();

  // Subtle violet dot to match brand.
  ctx.fillStyle = "rgba(196,181,253,1)";
  const dotR = Math.round(fontSize * 0.32);
  ctx.beginPath();
  ctx.arc(x + padX + dotR / 2, y + boxH / 2, dotR / 2, 0, Math.PI * 2);
  ctx.fill();

  // Text.
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padX + dotR + Math.round(fontSize * 0.45), y + boxH / 2);

  ctx.restore();
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
}: {
  uid: string;
  projectId: string;
  exportId: string;
  uploadPath: string;
  blob: Blob;
}): Promise<{ exportId: string; downloadURL: string }> {
  const { db, storage } = getFirebase();

  const sRef = storageRef(storage, uploadPath);
  await uploadBytes(sRef, blob, { contentType: blob.type || "video/webm" });
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

  return { exportId, downloadURL };
}

export function pickedMimeAvailable(): boolean {
  return pickMime() !== null;
}

export function pickedMimeExt(): string {
  return pickMime()?.ext ?? "webm";
}
