"use client";

import * as React from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  Sparkles,
  Eye,
  EyeOff,
  Move3D,
  RefreshCcw,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useEditorReal } from "./context";
import { useDebugParam } from "./use-debug-param";
import { CvDebugOverlay } from "./CvDebugOverlay";
import { dequantize } from "@/lib/cv/resample";
import {
  resolveCameraFrame,
  IDENTITY_CAMERA,
  cameraDiagnostic,
  type CameraState,
} from "@/lib/timeline/camera";
import { clickHighlightGeometry } from "@/lib/timeline/click-highlight";
import { coverFitDims } from "@/lib/timeline/cover";
import {
  activeSpeedAt,
  activeCutAt,
  snapOutOfActiveCut,
  DEFAULT_CROP,
} from "@/lib/timeline/crop-speed";
import {
  resolveOutputCanvas,
  resolveCanvasDims,
  resolveCanvasPlacement,
  computeSmartFitOffset,
  buildSmartSignals,
} from "@/lib/timeline/canvas-layout";
import { probeVideoBottomBand } from "@/lib/recording/health-check";
import { resolveSourceRect } from "@/lib/timeline/source-crop";
import { CropEditorOverlay } from "./CropEditorOverlay";
import { FocalPathOverlay } from "./FocalPathOverlay";
import { PreviewInCameraOverlays, PreviewOutputOverlays } from "./PreviewOverlays";
import type {
  BackgroundMode,
  DetectedMoment,
  FitMode,
  FocusRegion,
  VisualAnalysis,
} from "@/lib/firebase/schema";

/**
 * Calls video.play() and swallows the AbortError that browsers throw when the
 * play promise is interrupted by a subsequent pause() or element removal.
 */
function safePlay(v: HTMLVideoElement): Promise<void> {
  const result = v.play();
  if (result && typeof result.then === "function") {
    return result.catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      throw err;
    });
  }
  return Promise.resolve();
}

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

interface CameraDriverState {
  moments: DetectedMoment[];
  previewMode: boolean;
  autoZoom: number;
  zoomSpeed: number;
  pacing: string;
  /** When true, an export render is running — the preview camera loop yields. */
  exporting: boolean;
  /** When true, the crop editor owns the preview — the camera stays at identity. */
  cropEditing: boolean;
}

/**
 * Live snapshot of the cinematic camera, written by the rAF loop every
 * frame and read by the (opt-in) camera debug overlay. `tx`/`ty` are in
 * PERCENT — the same units fed to the CSS `translate(...)`. At rest, with
 * no active moment, this MUST read scale=1, tx=0, ty=0; the overlay
 * flags it red otherwise so a stuck transform is obvious at a glance.
 */
interface CameraDebugInfo {
  scale: number;
  tx: number;
  ty: number;
  momentId: string | null;
}

/**
 * Continuous cinematic camera. A rAF loop recomputes the *target* every
 * frame from the live `video.currentTime`, then eases the *current*
 * transform toward it with time-based exponential smoothing — inertia,
 * natural deceleration, never a robotic straight CSS line. A very low
 * amplitude drift keeps the frame alive while zoomed in.
 *
 * The target comes from `resolveCameraFrame` — the SAME function the
 * exporter calls. The moment's edge envelope (auto ease-in/out for
 * non-keyframed moments) is baked into the resolver, so preview and
 * export ramp in and out identically. Any difference the user sees
 * between the two surfaces is a real bug, not a smoothing-vs-no-smoothing
 * artifact.
 */
function useCinematicCamera(
  wrapRef: React.RefObject<HTMLDivElement | null>,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  state: CameraDriverState,
  debugRef?: React.MutableRefObject<CameraDebugInfo>
) {
  const currentRef = React.useRef({ scale: 1, tx: 0, ty: 0 });
  const stateRef = React.useRef(state);
  stateRef.current = state;
  /** Last moment id we logged a snapshot for — one log per activation. */
  const loggedMomentRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = stateRef.current;

      // While a render is running, yield the main thread to the exporter — it
      // drives playback AND owns video.playbackRate (writing it here too is a
      // two-writer race). Keep the rAF alive so the camera resumes the instant
      // the export finishes.
      if (s.exporting) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // While the crop editor is open, the preview shows the FULL frame with a
      // draggable crop box — pin the camera to identity so a moment under the
      // playhead can't animate/zoom the frame the user is trying to crop.
      if (s.cropEditing) {
        const el = wrapRef.current;
        if (el) el.style.transform = "translate(0%, 0%) scale(1)";
        currentRef.current = { scale: 1, tx: 0, ty: 0 };
        raf = requestAnimationFrame(tick);
        return;
      }

      // Active cuts remove time: during playback, jump past a cut the instant
      // the playhead enters it (the `!seeking` guard prevents a re-seek storm).
      // Runs regardless of `previewMode` — a cut is a timeline edit, not a
      // camera-preview affordance — so preview always matches the export.
      const vEl = videoRef.current;
      if (vEl && !vEl.paused && !vEl.seeking) {
        const cut = activeCutAt(s.moments, vEl.currentTime);
        if (cut) {
          if (process.env.NODE_ENV !== "production") {
            console.info("[preview-cut]", {
              jumpedFrom: +vEl.currentTime.toFixed(2),
              jumpedTo: +cut.endTime.toFixed(2),
            });
          }
          vEl.currentTime = cut.endTime;
        }
      }

      // Speed sections drive playbackRate — an approximate accelerated preview
      // (the export bakes the exact shorter duration). Outside a speed section,
      // or with preview off, playback runs at 1×.
      if (vEl) {
        const sp = s.previewMode ? activeSpeedAt(s.moments, vEl.currentTime) : null;
        const rate = sp ? Math.max(0.0625, Math.min(16, sp.multiplier)) : 1;
        if (Math.abs(vEl.playbackRate - rate) > 0.001) {
          vEl.playbackRate = rate;
          // Keep pitch natural during speed-ups (browser time-stretch).
          try {
            (vEl as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true;
          } catch {
            /* not supported — ignore */
          }
        }
      }

      // Recompute the target from the live playhead each frame.
      let tgt: CameraState = IDENTITY_CAMERA;
      let activeMomentId: string | null = null;
      if (s.previewMode && s.moments.length > 0) {
        const t = videoRef.current?.currentTime ?? 0;
        const { camera, moment } = resolveCameraFrame(s.moments, t, {
          autoZoom: s.autoZoom,
        });
        tgt = camera;
        activeMomentId = moment?.id ?? null;

        // Dev-mode camera diagnostic: log the moment's three checkpoints
        // (start, middle, end) the first time it becomes active. Pair
        // with the `[export] camera snapshots` table the renderer logs
        // and the rows MUST match — that's how we verify preview/export
        // share the same camera resolver.
        if (
          process.env.NODE_ENV !== "production" &&
          moment &&
          loggedMomentRef.current !== moment.id
        ) {
          loggedMomentRef.current = moment.id;
          const v = videoRef.current;
          const wrap = wrapRef.current;
          // Use the cover-fit dims the export will use, computed
          // against the preview wrapper's actual rendered size. Logging
          // raw videoWidth/Height would make the preview table
          // mismatched against the export table whenever source aspect
          // differs from output aspect — the resolver is identical, but
          // the tx/ty pixel projections wouldn't be apples-to-apples
          // without the same cover-fit step. The export snapshot
          // already uses canvasW/canvasH; here we use the wrapper's
          // client size as the equivalent target.
          const targetW = wrap?.clientWidth || v?.videoWidth || 1920;
          const targetH = wrap?.clientHeight || v?.videoHeight || 1080;
          const { drawW, drawH } = coverFitDims(
            v?.videoWidth ?? targetW,
            v?.videoHeight ?? targetH,
            targetW,
            targetH
          );
          const samples = [
            moment.startTime + 0.05,
            (moment.startTime + moment.endTime) / 2,
            moment.endTime - 0.05,
          ];
          console.groupCollapsed(
            `[preview] camera snapshots for moment ${moment.id}`
          );
          console.table(
            samples
              .map((tt) =>
                cameraDiagnostic(s.moments, tt, {
                  autoZoom: s.autoZoom,
                  drawW,
                  drawH,
                })
              )
              .map((r) => ({
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
        } else if (!moment) {
          loggedMomentRef.current = null;
        }
      }

      // Responsiveness `k` — higher = snappier. Driven by Zoom Speed + pacing.
      let k = 3 + (s.zoomSpeed / 100) * 3;
      if (s.pacing === "fast") k += 1.6;
      else if (s.pacing === "slow") k -= 0.9;
      k = Math.max(1.6, k);

      const f = 1 - Math.exp(-k * dt);
      const cur = currentRef.current;
      cur.scale += (tgt.scale - cur.scale) * f;
      cur.tx += (tgt.panXPct - cur.tx) * f;
      cur.ty += (tgt.panYPct - cur.ty) * f;

      // Inertial drift removed — the preview's CSS transform now mirrors
      // the resolver target exactly (after the smoothing pass). The
      // exporter is per-frame deterministic, so the sinusoidal sway
      // here would have made preview ≠ export at every zoomed frame.
      const el = wrapRef.current;
      if (el) {
        el.style.transform = `translate(${cur.tx.toFixed(3)}%, ${cur.ty.toFixed(3)}%) scale(${cur.scale.toFixed(4)})`;
      }

      // Publish the live transform for the camera debug overlay. When no
      // moment is active the smoothing target is identity, so this settles
      // to {scale:1, tx:0, ty:0} — the invariant the overlay asserts.
      if (debugRef) {
        debugRef.current = {
          scale: cur.scale,
          tx: cur.tx,
          ty: cur.ty,
          momentId: activeMomentId,
        };
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [wrapRef, videoRef]);
}

export function RealVideoPlayer() {
  const {
    project,
    videoRef,
    currentTime,
    setCurrentTime,
    playing,
    setPlaying,
    exporting,
    duration,
    setDuration,
    activeMoment,
    previewMode,
    setPreviewMode,
    cvDebug,
    updateMoment,
    updateEffects,
    cropEditing,
    closeCropEditor,
    setSourceCrop,
    clearSourceCrop,
  } = useEditorReal();

  // Dev-only CV debug overlay gate (?debug=1 / Ctrl+Shift+D).
  const cvDebugOverlay = useDebugParam();

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const aspectRef = React.useRef<HTMLDivElement | null>(null);
  const transformWrapRef = React.useRef<HTMLDivElement | null>(null);
  // Canvas Fit layers: the offset layer (base-placement pan / manual drag),
  // the stage (placed source box), the source frame (overlay coord space),
  // and the blurred background video.
  const offsetLayerRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const sourceFrameRef = React.useRef<HTMLDivElement | null>(null);
  const bgVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const dragOffsetRef = React.useRef<{ x: number; y: number } | null>(null);
  // Live camera transform, written each frame by the cinematic camera and
  // read by the opt-in debug overlay (?debugCamera=1).
  const cameraDebugRef = React.useRef<CameraDebugInfo>({
    scale: 1,
    tx: 0,
    ty: 0,
    momentId: null,
  });
  const [muted, setMuted] = React.useState(false);
  const [volume, setVolume] = React.useState(1);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  // True when the source <video> failed to load — surfaced as a clear overlay
  // (with Retry) instead of a silent black frame.
  const [loadError, setLoadError] = React.useState(false);
  // Intrinsic (full) size of the loaded recording. The EFFECTIVE source aspect
  // (the Frame Crop sub-rectangle) is derived from this + the project's
  // `sourceCrop` below, so the preview frame is shown WYSIWYG with the export
  // instead of being cropped into a fixed 16:9 box.
  const [naturalSize, setNaturalSize] = React.useState<{
    w: number;
    h: number;
  } | null>(null);

  // Track fullscreen state so we can swap the layout from "aspect-locked
  // card centered in the page" to "fill the viewport, letterboxed by the
  // video itself via object-contain".
  React.useEffect(() => {
    const onChange = () => {
      const fs = document.fullscreenElement === containerRef.current;
      setIsFullscreen(fs);

      // Fullscreen dimension audit — the preview is a plain <video>, so
      // displayed size vs intrinsic size + the resolved object-fit tells us
      // immediately whether fullscreen is cropping (cover) or preserving
      // the whole frame (contain). The camera scale/translate come from the
      // live debug ref; at rest with no moment they must be 1 / 0 / 0.
      if (process.env.NODE_ENV !== "production") {
        const v = videoRef.current;
        const box = aspectRef.current;
        const cam = cameraDebugRef.current;
        const fit = v ? getComputedStyle(v).objectFit : "—";
        console.info(`[fullscreen] ${fs ? "entered" : "exited"}`, {
          videoWidth: v?.videoWidth ?? 0,
          videoHeight: v?.videoHeight ?? 0,
          displayedWidth: v ? Math.round(v.getBoundingClientRect().width) : 0,
          displayedHeight: v ? Math.round(v.getBoundingClientRect().height) : 0,
          containerWidth: box ? Math.round(box.getBoundingClientRect().width) : 0,
          containerHeight: box ? Math.round(box.getBoundingClientRect().height) : 0,
          screenWidth: window.innerWidth,
          screenHeight: window.innerHeight,
          objectFit: fit,
          cameraScale: +cam.scale.toFixed(4),
          cameraTranslateX: +cam.tx.toFixed(3),
          cameraTranslateY: +cam.ty.toFixed(3),
          activeMomentId: cam.momentId,
        });
        if (fs && fit === "cover") {
          console.warn(
            "[fullscreen] object-fit is COVER — this crops the recording. Screen captures should use CONTAIN to preserve the full viewport."
          );
        }
        if (cam.momentId === null && Math.abs(cam.scale - 1) > 0.01) {
          console.warn(
            `[fullscreen] no active moment but cameraScale=${cam.scale.toFixed(3)} (expected 1). A stuck camera transform is adding zoom.`
          );
        }
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [videoRef]);

  // Wire video element events
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onLoaded = () => {
      setLoadError(false);
      if (Number.isFinite(v.duration)) setDuration(v.duration);
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        setNaturalSize({ w: v.videoWidth, h: v.videoHeight });
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    // A real load failure (bad/expired URL, network, or a CORS-tainted
    // cross-origin request) — surface it instead of a silent black frame.
    const onError = () => setLoadError(true);
    // Dev-only: once a real frame is decoded, sample the SOURCE video's
    // bottom rows. This proves whether the green strip the user sees in
    // the preview is baked into the recorded pixels (capture-time, e.g.
    // Chrome's tab-share toolbar) or introduced by our rendering. The
    // preview is a plain <video> with no canvas compositing, so green
    // here = source pixels — but we log the measurement so it's not a
    // guess. Runs once per load.
    const onData = () => {
      if (process.env.NODE_ENV === "production") return;
      const probe = probeVideoBottomBand(v);
      if (!probe) {
        console.info(
          "[preview] source bottom-band probe: unreadable (CORS taint or no frame)"
        );
        return;
      }
      console.info("[preview] source bottom-band probe", {
        ...probe,
        verdict:
          probe.bandHeightPx >= 3
            ? `GREEN BAND IN SOURCE (${probe.bandHeightPx}px) — baked into the recording at capture, not added by the editor. The old 16:9 cover-crop hid it; "Source" framing now shows the full captured frame.`
            : `source bottom is clean (${(probe.bottomRowGreenRatio * 100).toFixed(0)}% green) — no baked-in band.`,
      });
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("loadeddata", onData);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("error", onError);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onLoaded);
      v.removeEventListener("loadeddata", onData);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("error", onError);
    };
  }, [videoRef, setCurrentTime, setDuration, setPlaying]);

  // Reload the source after a load failure (e.g. a transient network blip).
  const retryLoad = React.useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setLoadError(false);
    try {
      v.load();
    } catch {
      /* ignore — the error handler re-fires if it fails again */
    }
  }, [videoRef]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) safePlay(v);
    else v.pause();
  };

  const onScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    // Seeking into an active cut snaps to the cut's end (nearest valid time).
    const t = snapOutOfActiveCut(
      project.analysis?.detectedMoments ?? [],
      Number(e.target.value)
    );
    v.currentTime = t;
    setCurrentTime(t);
  };

  const onVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const x = Number(e.target.value);
    v.volume = x;
    setVolume(x);
    setMuted(x === 0);
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = !muted;
    v.muted = next;
    setMuted(next);
  };

  const requestFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen?.();
    }
  };

  // Cinematic camera — the rAF loop recomputes the target each frame
  // from the live playhead by calling the SAME shared resolver the
  // exporter uses. Passing the full moments array (not just
  // `activeMoment`) means moment selection happens in one place and
  // preview never drifts from export on overlap edge cases.
  const allMoments = project.analysis?.detectedMoments ?? [];
  useCinematicCamera(
    transformWrapRef,
    videoRef,
    {
      moments: allMoments,
      previewMode,
      autoZoom: project.effectsSettings.autoZoom,
      zoomSpeed: project.effectsSettings.zoomSpeed,
      pacing: project.effectsSettings.pacing,
      exporting,
      cropEditing,
    },
    cameraDebugRef
  );

  const va = project.visualAnalysis;

  // ── Global Frame Crop ────────────────────────────────────────────────────
  // The EFFECTIVE source rect (the crop sub-rectangle of the full frame). The
  // same `resolveSourceRect` the exporter + CV use, so the preview frame, the
  // export, and the analysis all agree on what "the source" is. Full frame
  // (no-op) unless the project carries an enabled `sourceCrop`.
  const srcRect = React.useMemo(
    () =>
      naturalSize
        ? resolveSourceRect(naturalSize.w, naturalSize.h, project.sourceCrop)
        : null,
    [naturalSize, project.sourceCrop]
  );
  // Effective source aspect drives the preview frame + all canvas-layout math.
  // While editing the crop we show the FULL frame (so the box can cover the
  // whole source), so use the natural aspect in that mode.
  const fullAspect =
    naturalSize && naturalSize.h > 0 ? naturalSize.w / naturalSize.h : null;
  const sourceAspect = cropEditing
    ? fullAspect
    : srcRect && srcRect.sHeight > 0
      ? srcRect.sWidth / srcRect.sHeight
      : null;
  // When a crop is applied, the <video> is scaled up (1/cropW × 1/cropH) and
  // offset inside an overflow-clipped wrapper so only the crop rect shows. The
  // stage/frame box is the effective crop aspect → the scaled video's element
  // box ends up at the FULL source aspect, so `object-fill` fills it without
  // distortion, matching the exporter's source-rect draw. Suppressed while
  // editing (the editor shows the full frame with the draggable crop box) and
  // in native fullscreen (a non-WYSIWYG "watch" affordance whose box is
  // viewport-aspect, where the sprite-fill would distort — show the raw frame).
  const cropActive =
    !cropEditing &&
    !isFullscreen &&
    !!srcRect &&
    srcRect.cropActive &&
    !!naturalSize;
  const cropRectPct =
    cropActive && naturalSize
      ? {
          w: srcRect!.sWidth / naturalSize.w,
          h: srcRect!.sHeight / naturalSize.h,
          x: srcRect!.sx / naturalSize.w,
          y: srcRect!.sy / naturalSize.h,
        }
      : null;

  // Validated crop projection — how the <video> is zoomed to reveal only the
  // crop rect. We do this with a CSS `transform: scale()` on a wrapper-sized
  // element (NOT by laying the element out at e.g. 2000%×2000%): a layout-sized
  // sprite forces the browser to rasterize the full video at that pixel size,
  // and a small crop (the editor floor is 5% → 20× → tens of thousands of px,
  // worse on HiDPI) blows past the GPU max-texture size, so the layer fails to
  // paint and the preview goes BLACK. A `transform` scale reuses the normal,
  // wrapper-sized texture, so the crop can be arbitrarily tight without blanking.
  //
  // The numbers are validated so a degenerate/non-finite projection (e.g. a
  // near-zero crop dimension, or a value computed before the intrinsic size
  // settles) falls back to the full frame (object-contain) — never black.
  const cropProjection = React.useMemo(() => {
    if (!cropRectPct) return null;
    const { w, h, x, y } = cropRectPct;
    const scaleX = 1 / w;
    const scaleY = 1 / h;
    // translate is a % of the element's OWN (wrapper) size, applied before the
    // scale: full-frame fraction f maps to (f - x)/w of the wrapper. So the
    // crop rect [x, x+w] fills [0, 1] of the visible (overflow-clipped) box.
    const translateXPct = -x * 100;
    const translateYPct = -y * 100;
    const valid =
      w > 0.001 &&
      h > 0.001 &&
      Number.isFinite(scaleX) &&
      Number.isFinite(scaleY) &&
      Number.isFinite(translateXPct) &&
      Number.isFinite(translateYPct) &&
      scaleX <= 80 &&
      scaleY <= 80;
    return { scaleX, scaleY, translateXPct, translateYPct, valid };
  }, [cropRectPct]);
  const cropRenderActive = cropActive && !!cropProjection?.valid;

  // TEMPORARY crop diagnostics — dev-only. Logs the full crop math each time the
  // crop (or intrinsic size) changes so a "black after crop" report is
  // immediately attributable: source-of-truth dims, container size, crop rect,
  // unit, the computed transform, and whether the crop rendered or fell back.
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const v = videoRef.current;
    const box = aspectRef.current?.getBoundingClientRect();
    console.info("[crop-preview]", {
      cropUnit: "normalized 0..1",
      sourceCrop: project.sourceCrop ?? null,
      naturalWidth: v?.videoWidth || naturalSize?.w || 0,
      naturalHeight: v?.videoHeight || naturalSize?.h || 0,
      containerWidth: box ? Math.round(box.width) : 0,
      containerHeight: box ? Math.round(box.height) : 0,
      srcRect,
      cropRectPct,
      transform: cropProjection,
      cropActive,
      cropRenderActive,
      reset: cropActive && !cropRenderActive,
    });
  }, [
    project.sourceCrop,
    srcRect,
    cropRectPct,
    cropProjection,
    cropActive,
    cropRenderActive,
    naturalSize,
    videoRef,
    aspectRef,
  ]);

  // ── Global output canvas (Canvas Fit / Resize) ───────────────────────────
  // The chosen aspect / fit mode / background. Reflected in the preview
  // ALWAYS (not gated on previewMode) so the user sees the true output frame;
  // only the per-moment cinematic camera stays gated on previewMode (inside
  // `useCinematicCamera`). `null` = full-frame source (legacy behaviour).
  const oc = React.useMemo(
    () => resolveOutputCanvas(project.effectsSettings),
    [project.effectsSettings]
  );

  // Source dims as a ratio (absolute scale cancels in the placement math), so
  // the SAME `canvas-layout` helpers the exporter uses drive the preview.
  const srcAspectVal = sourceAspect ?? 16 / 9;
  const previewPlacement = React.useMemo(() => {
    if (!oc) return null;
    const srcW = srcAspectVal * 1000;
    const srcH = 1000;
    const { canvasW, canvasH } = resolveCanvasDims(
      srcW,
      srcH,
      oc.aspectRatio,
      "1080p",
      oc.aspectRatio === "custom" ? { width: oc.width, height: oc.height } : undefined
    );
    const smart =
      oc.fitMode === "smart-fit"
        ? computeSmartFitOffset(
            srcW,
            srcH,
            canvasW,
            canvasH,
            buildSmartSignals(va, allMoments)
          )
        : undefined;
    const place = resolveCanvasPlacement(srcW, srcH, canvasW, canvasH, oc, smart);
    const fellBack = oc.fitMode === "smart-fit" && !!smart?.fallbackToBlur;
    const effFit: FitMode = fellBack ? "fit" : oc.fitMode;
    const bgMode: BackgroundMode = fellBack ? "blur" : oc.backgroundMode;
    return {
      canvasW,
      canvasH,
      place,
      bgMode,
      showBg: place.hasLetterbox && (effFit === "fit" || effFit === "manual"),
      manual: oc.fitMode === "manual",
    };
  }, [oc, srcAspectVal, va, allMoments]);

  // Sizing + object-fit for the visible frame. The Canvas composite is
  // disabled in fullscreen, which falls back to a source-contain view (a
  // "watch the recording" affordance — the windowed preview is the WYSIWYG
  // export preview). Outside the canvas path the video is letterboxed via
  // `object-contain` exactly like before.
  // While editing the crop, bypass the Canvas-Fit composite and show the full
  // source frame (object-contain at natural aspect) with the crop box on top.
  const canvasActive = !!previewPlacement && !isFullscreen && !cropEditing;
  const applySourceAspect = !canvasActive && !isFullscreen;
  const previewAspect = sourceAspect ?? 16 / 9;
  const videoObjectFit = canvasActive ? "object-cover" : "object-contain";

  const frameStyle: React.CSSProperties | undefined =
    canvasActive && previewPlacement
      ? { aspectRatio: `${previewPlacement.canvasW} / ${previewPlacement.canvasH}` }
      : applySourceAspect
        ? { aspectRatio: String(previewAspect) }
        : undefined;
  // Tall/square canvases must be HEIGHT-driven. With `w-full` (width:100%) the
  // tall `aspect-ratio` can't shrink the width, so the frame would render wide
  // (full width, capped height) instead of tall. Drive the height instead and
  // let `aspect-ratio` derive the narrower width. Wide canvases stay
  // width-driven (the source/no-canvas preview is landscape too).
  const tallCanvas =
    canvasActive &&
    !!previewPlacement &&
    previewPlacement.canvasH >= previewPlacement.canvasW;
  const frameSizeClass = tallCanvas
    ? "h-[72vh] w-auto max-w-full"
    : "w-full max-h-[56vh] max-w-[100vh]";

  const place = canvasActive ? previewPlacement?.place : undefined;
  const stageStyle: React.CSSProperties | undefined =
    place && previewPlacement
      ? {
          width: `${(place.drawW / previewPlacement.canvasW) * 100}%`,
          height: `${(place.drawH / previewPlacement.canvasH) * 100}%`,
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
        }
      : undefined;
  const offsetStyle: React.CSSProperties | undefined =
    place && previewPlacement
      ? {
          transform: `translate(${(place.baseOffsetX / previewPlacement.canvasW) * 100}%, ${(place.baseOffsetY / previewPlacement.canvasH) * 100}%)`,
        }
      : undefined;
  const showCanvasBg = canvasActive && !!previewPlacement?.showBg;
  const canvasBgMode = previewPlacement?.bgMode ?? "blur";
  const previewBgColor =
    canvasBgMode === "solid"
      ? oc?.backgroundColor || "#000000"
      : canvasBgMode === "light"
        ? "#f5f5f5"
        : canvasBgMode === "dark"
          ? "#0a0a0a"
          : "#000000";

  // Manual reposition — drag the whole video inside the canvas. Writes the
  // offset layer's transform live (no re-render); commits once on release.
  const beginCanvasDrag = (e: React.PointerEvent) => {
    if (!oc || oc.fitMode !== "manual") return;
    const frame = aspectRef.current;
    if (!frame) return;
    e.preventDefault();
    const rect = frame.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = oc.offsetX || 0;
    const origY = oc.offsetY || 0;
    const onMove = (ev: PointerEvent) => {
      const nx = clamp(origX + (ev.clientX - startX) / rect.width, -1, 1);
      const ny = clamp(origY + (ev.clientY - startY) / rect.height, -1, 1);
      const layer = offsetLayerRef.current;
      if (layer) layer.style.transform = `translate(${nx * 100}%, ${ny * 100}%)`;
      dragOffsetRef.current = { x: nx, y: ny };
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const d = dragOffsetRef.current;
      dragOffsetRef.current = null;
      if (d) {
        updateEffects("outputCanvas", {
          ...oc,
          offsetX: round3(d.x),
          offsetY: round3(d.y),
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const canvasManual = canvasActive && !!previewPlacement?.manual;

  // Keep the blurred-background video roughly in step with the main one.
  // Heavy blur tolerates loose sync, so we only correct on drift / play state.
  const blurBgActive = showCanvasBg && canvasBgMode === "blur";
  React.useEffect(() => {
    // Skip while exporting — this loop seeks bgVideo every frame, and the
    // export doesn't capture the preview's blur background anyway.
    if (!blurBgActive || exporting) return;
    let raf = 0;
    const tick = () => {
      const main = videoRef.current;
      const bg = bgVideoRef.current;
      if (main && bg) {
        if (Math.abs(bg.currentTime - main.currentTime) > 0.08) {
          bg.currentTime = main.currentTime;
        }
        if (main.paused && !bg.paused) bg.pause();
        else if (!main.paused && bg.paused) void bg.play().catch(() => {});
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [blurBgActive, exporting, videoRef]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative",
        // In native fullscreen the container becomes the viewport, so let it
        // fill it and let the inner card stretch to match. The video element
        // already uses `object-contain`, so any letterboxing happens cleanly
        // inside the frame instead of as page chrome around it.
        isFullscreen && "h-screen w-screen bg-black"
      )}
    >
      <div
        ref={aspectRef}
        style={frameStyle}
        className={cn(
          "relative overflow-hidden bg-black shadow-cinematic",
          isFullscreen
            ? "h-full w-full rounded-none border-0"
            : cn("rounded-xl border border-white/[0.06] mx-auto", frameSizeClass)
        )}
      >
        {/* ── Canvas Fit background — fills the empty space behind the (crisp)
            video in Fit / Manual modes (or Smart-Fit's blur fallback). ──
            NB: when a sharing bar is being removed the foreground video is
            cropped (above) and the export's blur backdrop is cropped too, but
            this decorative layer is left full-frame: it's blurred 40px + dimmed
            + overscaled and only peeks in the letterbox margins, so the bar is
            an indistinct wash; cropping it would risk uncovering frame edges
            for no perceptible gain. */}
        {showCanvasBg &&
          (canvasBgMode === "blur" ? (
            <video
              ref={bgVideoRef}
              src={project.originalVideoUrl || undefined}
              aria-hidden
              muted
              playsInline
              preload="metadata"
              className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover blur-2xl brightness-[0.7]"
            />
          ) : (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{ background: previewBgColor }}
            />
          ))}

        {/* ── Offset layer — base-placement pan (Smart-Fit / Manual drag /
            centring). Full-canvas-sized so its % translate is a fraction of
            the canvas, matching the exporter's `base.offsetX/Y` in px. ── */}
        <div ref={offsetLayerRef} className="absolute inset-0" style={offsetStyle}>
          {/* Stage — the placed source box (always source aspect). Overflows
              the frame + is clipped by it in fill / cover modes. */}
          <div
            ref={stageRef}
            className={cn("absolute", !place && "inset-0")}
            style={stageStyle}
          >
            {/* Source frame — the coordinate space overlays map into (their
                source-normalized %s track the placed source, not the canvas). */}
            <div ref={sourceFrameRef} className="absolute inset-0">
              {/* The real <video>. The cinematic camera writes `transform`
                  directly onto this wrapper every frame. When a Frame Crop is
                  applied, this wrapper clips and the video is scaled up
                  (1/cropW × 1/cropH) and offset so only the crop rect shows —
                  matching the exporter's source-rect draw exactly. */}
              <div
                ref={transformWrapRef}
                className={cn(
                  "absolute inset-0 origin-center will-change-transform",
                  cropRenderActive && "overflow-hidden"
                )}
              >
                <video
                  ref={videoRef}
                  src={project.originalVideoUrl || undefined}
                  className={cn(
                    "w-full",
                    // Crop: a wrapper-sized element (inset-0) zoomed to the crop
                    // rect via `transform: scale()` below — `object-fill` so the
                    // independent X/Y scale lands the crop without letterboxing.
                    // Falls back to a normal contained frame when the projection
                    // is unsafe, so the preview is never blank.
                    cropRenderActive
                      ? "absolute inset-0 h-full object-fill"
                      : cn("h-full", videoObjectFit)
                  )}
                  style={
                    cropRenderActive && cropProjection
                      ? {
                          transformOrigin: "0 0",
                          transform: `scale(${cropProjection.scaleX.toFixed(5)}, ${cropProjection.scaleY.toFixed(5)}) translate(${cropProjection.translateXPct.toFixed(4)}%, ${cropProjection.translateYPct.toFixed(4)}%)`,
                        }
                      : undefined
                  }
                  playsInline
                  // NO crossOrigin: the preview only DISPLAYS the video (CSS
                  // transforms, never a canvas readback), so it must not require
                  // a CORS-approved cross-origin response — otherwise a source
                  // whose bucket CORS doesn't list the current origin fails to
                  // load and the preview goes black. Export uses its OWN
                  // offscreen `crossOrigin` video for canvas readback, so this
                  // is display-only and safe.
                  preload="metadata"
                />
                {!project.originalVideoUrl && (
                  <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-fog">
                    No video loaded.
                  </div>
                )}
                {loadError && project.originalVideoUrl && (
                  <div className="absolute inset-0 z-10 grid place-items-center bg-black/55 px-6 text-center backdrop-blur-sm">
                    <div className="max-w-xs">
                      <p className="text-sm font-medium text-white">
                        Couldn&apos;t load the video preview
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-fog">
                        The file may still be processing, or your network or
                        storage permissions blocked it.
                      </p>
                      <button
                        type="button"
                        onClick={retryLoad}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.06] px-3.5 py-1.5 text-[12px] font-medium text-white/90 transition-colors duration-150 hover:border-white/30 hover:bg-white/[0.1]"
                      >
                        <RefreshCcw size={12} />
                        Retry
                      </button>
                    </div>
                  </div>
                )}

                {/* CV debug: motion-hotspot centroid path, tracks with video. */}
                {cvDebug && va && va.sampleCount > 0 && (
                  <CentroidPath
                    visualAnalysis={va}
                    currentTime={currentTime}
                    duration={duration > 0 ? duration : project.duration ?? 0}
                  />
                )}

                {/* Dev-only visual-engine overlay (?debug=1). */}
                {cvDebugOverlay && va && va.sampleCount > 0 && (
                  <CvDebugOverlay
                    visualAnalysis={va}
                    moments={project.analysis?.detectedMoments ?? []}
                    currentTime={currentTime}
                  />
                )}

                {/* Phase-3 IN-CAMERA overlay preview (callout / blur). Inside
                    the camera-transform wrapper so the browser applies the SAME
                    base-placement + zoom/pan transform the video gets — the
                    canvas box then equals the export's `base` placement, so
                    these track the content with no math here (WYSIWYG). */}
                <PreviewInCameraOverlays
                  videoRef={videoRef}
                  moments={project.analysis?.detectedMoments ?? []}
                  enabled={previewMode && !cropEditing}
                />
              </div>

              {/* Source-space overlays — click highlights, focal path, crop
                  guides, editable focus box. Nested in the source frame so
                  their coords track the placed source under any fit mode.
                  Hidden while editing the global crop. */}
              {!cropEditing && activeMoment && (
                <OverlayLayer
                  moment={activeMoment}
                  currentTime={currentTime}
                  clickHighlightStyle={project.effectsSettings.clickHighlightStyle}
                  clickHighlightSize={project.effectsSettings.clickHighlightSize}
                  clickHighlightsEnabled={project.effectsSettings.clickHighlights}
                />
              )}

              {!cropEditing && activeMoment && <FocalPathOverlay moment={activeMoment} />}

              {!cropEditing && activeMoment?.effectType === "crop" && previewMode && (
                <CropGuides />
              )}

              {/* Speed moments don't frame a region — no box for them. */}
              {!cropEditing && activeMoment && activeMoment.effectType !== "speed-up" && (
                <EditableFocusBox
                  key={activeMoment.id}
                  moment={activeMoment}
                  aspectRef={sourceFrameRef}
                  ghost={previewMode}
                  onCommit={(focusRegion) => {
                    // Stamp `targetRegionSource: "user"` so the balancer's
                    // `refineMomentFocalRegion` pass leaves this region alone
                    // on any subsequent re-analyze / reframe — user wins.
                    const patch: Partial<DetectedMoment> = {
                      focusRegion,
                      targetRegionSource: "user",
                    };
                    // A manual box drag makes the crop position "custom".
                    if (activeMoment.effectType === "crop") {
                      patch.crop = {
                        ...(activeMoment.crop ?? DEFAULT_CROP),
                        position: "custom",
                      };
                    }
                    updateMoment(activeMoment.id, patch);
                  }}
                />
              )}
            </div>
          </div>
        </div>

        {/* Phase-3 OUTPUT-anchored overlay preview (captions / hook / text /
            CTA / transition). At the OUTPUT frame level — outside the placed
            source + camera wrappers — so it stays pinned to the frame, matching
            the export's post-camera draw. Same pure functions the export runs. */}
        <PreviewOutputOverlays
          videoRef={videoRef}
          moments={project.analysis?.detectedMoments ?? []}
          enabled={previewMode && !cropEditing}
        />

        {/* Manual reposition surface — drag the whole video inside the canvas.
            Only in Manual fit mode; above the video, below the controls. */}
        {canvasManual && (
          <div
            className="absolute inset-0 z-20 cursor-move"
            onPointerDown={beginCanvasDrag}
            title="Drag to reposition"
          />
        )}

        {/* Opt-in camera debug overlay — ?debugCamera=1 (canvas chrome). */}
        <CameraDebugOverlay
          debugRef={cameraDebugRef}
          videoRef={videoRef}
          aspectRef={aspectRef}
          isFullscreen={isFullscreen}
        />

        {/* AI tracking chip */}
        {project.status === "analyzed" && (
          <div className="pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/10 px-2.5 py-1 text-[10px] font-medium text-violet-200 backdrop-blur-md">
            <span className="relative inline-flex size-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-violet-400/70" />
              <span className="relative inline-block size-1.5 rounded-full bg-violet-400" />
            </span>
            {va ? "Hybrid tracking" : "AI tracking"}
          </div>
        )}

        {/* Preview toggle — z-40 so it stays clickable above the manual
            reposition surface (z-20). */}
        <button
          onClick={() => setPreviewMode(!previewMode)}
          className="absolute left-3 top-3 z-40 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/40 px-2.5 py-1 text-[10px] font-medium text-white/90 backdrop-blur-md transition-colors duration-200 hover:bg-black/60"
        >
          {previewMode ? <Eye size={11} /> : <EyeOff size={11} />}
          {previewMode ? "Preview ON" : "Preview OFF"}
        </button>

        {/* Vignette — opt-in via the "Cinematic vignette" toggle in the
            export panel. Preview honors the same flag so what you see is
            what you get; if it's off here it'll be off in the exported
            file. The CSS gradient mirrors the exporter's
            `drawVignette` radial gradient byte-for-byte. */}
        {project.effectsSettings.vignette && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_60%,rgba(0,0,0,0.25)_100%)]"
          />
        )}

        {/* Crop editor — rendered at the FRAME level (same overlay root as the
            controls) so its z-50 layer sits ABOVE the z-40 controls; nesting it
            inside the transformed source-frame subtree trapped it below. While
            editing the frame box equals the full-frame display area, so
            `aspectRef` is the correct coordinate container. */}
        {cropEditing && naturalSize && (
          <CropEditorOverlay
            aspectRef={aspectRef}
            initial={project.sourceCrop}
            naturalAspect={fullAspect ?? 16 / 9}
            onApply={(crop) => {
              void setSourceCrop(crop);
              closeCropEditor();
            }}
            onReset={() => void clearSourceCrop()}
            onCancel={closeCropEditor}
          />
        )}

        {/* Controls — faded + non-interactive while cropping so they can't
            cover or steal clicks from the crop toolbar (which sits at z-50). */}
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 z-40 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-4 pb-3 pt-10 transition-opacity duration-200",
            cropEditing && "pointer-events-none opacity-30"
          )}
        >
          {/* scrubber row */}
          <div className="mb-2 flex items-center gap-3">
            <span className="font-mono text-[11px] tabular-nums text-fog">
              {fmt(currentTime)}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(duration, currentTime)}
              step={0.01}
              value={currentTime}
              onChange={onScrub}
              aria-label="Scrub video"
              className="range-thumb h-1 flex-1"
              style={{
                background: `linear-gradient(to right, #8B5CF6 0%, #8B5CF6 ${
                  duration > 0 ? (currentTime / duration) * 100 : 0
                }%, rgba(255,255,255,0.15) ${
                  duration > 0 ? (currentTime / duration) * 100 : 0
                }%, rgba(255,255,255,0.15) 100%)`,
                borderRadius: "9999px",
              }}
            />
            <span className="font-mono text-[11px] tabular-nums text-fog/70">
              {fmt(duration)}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
              className="inline-flex size-8 items-center justify-center rounded-full bg-white text-ink transition-transform duration-200 hover:scale-105"
            >
              {playing ? (
                <Pause size={14} className="fill-ink" />
              ) : (
                <Play size={14} className="fill-ink" />
              )}
            </button>

            <button
              onClick={toggleMute}
              aria-label={muted ? "Unmute" : "Mute"}
              className="text-fog transition-colors duration-200 hover:text-white"
            >
              {muted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={onVolume}
              aria-label="Volume"
              className="range-thumb h-0.5 w-16"
            />

            <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-fog">
              <Sparkles size={10} className="text-violet-300" />
              {project.analysis?.detectedMoments?.length ?? 0} moments
            </span>
            <button
              onClick={requestFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              className="text-fog transition-colors duration-200 hover:text-white"
            >
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * TEMPORARY camera debug overlay. Opt-in via `?debugCamera=1` or
 * `localStorage['framevo:debugCamera'] = '1'`. Reads the live camera ref
 * (written each frame by `useCinematicCamera`) plus the video's intrinsic
 * vs displayed size, and renders a compact HUD:
 *
 *   Scale / Translate X / Translate Y / Active moment
 *   + video, displayed, container dimensions and object-fit
 *
 * Scale turns RED when no moment is active but the transform isn't
 * identity — the fingerprint of a camera-driven crop. Remove once the
 * fullscreen-crop investigation is closed.
 */
function CameraDebugOverlay({
  debugRef,
  videoRef,
  aspectRef,
  isFullscreen,
}: {
  debugRef: React.MutableRefObject<CameraDebugInfo>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  aspectRef: React.RefObject<HTMLDivElement | null>;
  isFullscreen: boolean;
}) {
  const [enabled, setEnabled] = React.useState(false);
  const [snap, setSnap] = React.useState({
    scale: 1,
    tx: 0,
    ty: 0,
    momentId: null as string | null,
    videoW: 0,
    videoH: 0,
    dispW: 0,
    dispH: 0,
    contW: 0,
    contH: 0,
    fit: "—",
  });

  React.useEffect(() => {
    try {
      const url = new URL(window.location.href);
      setEnabled(
        url.searchParams.get("debugCamera") === "1" ||
          window.localStorage.getItem("framevo:debugCamera") === "1"
      );
    } catch {
      setEnabled(false);
    }
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      // Throttle to ~12fps — the values are for eyeballing, not animation.
      if (now - last > 80) {
        last = now;
        const v = videoRef.current;
        const box = aspectRef.current;
        const cam = debugRef.current;
        const vr = v?.getBoundingClientRect();
        const br = box?.getBoundingClientRect();
        setSnap({
          scale: cam.scale,
          tx: cam.tx,
          ty: cam.ty,
          momentId: cam.momentId,
          videoW: v?.videoWidth ?? 0,
          videoH: v?.videoHeight ?? 0,
          dispW: vr ? Math.round(vr.width) : 0,
          dispH: vr ? Math.round(vr.height) : 0,
          contW: br ? Math.round(br.width) : 0,
          contH: br ? Math.round(br.height) : 0,
          fit: v ? getComputedStyle(v).objectFit : "—",
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [enabled, debugRef, videoRef, aspectRef]);

  if (!enabled) return null;

  const identityViolated =
    snap.momentId === null &&
    (Math.abs(snap.scale - 1) > 0.01 ||
      Math.abs(snap.tx) > 0.01 ||
      Math.abs(snap.ty) > 0.01);
  const fitIsCover = snap.fit === "cover";

  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-[60] -translate-x-1/2 rounded-lg border border-white/20 bg-black/85 px-3 py-2 font-mono text-[11px] leading-snug text-white shadow-cinematic backdrop-blur-md">
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.2em] text-violet-300">
        Camera debug {isFullscreen ? "· fullscreen" : ""}
      </div>
      <DebugLine
        label="Scale"
        value={snap.scale.toFixed(4)}
        warn={identityViolated}
      />
      <DebugLine
        label="Translate X"
        value={`${snap.tx.toFixed(2)}%`}
        warn={identityViolated}
      />
      <DebugLine
        label="Translate Y"
        value={`${snap.ty.toFixed(2)}%`}
        warn={identityViolated}
      />
      <DebugLine label="Active moment" value={snap.momentId ?? "none"} />
      <div className="my-1 border-t border-white/10" />
      <DebugLine label="object-fit" value={snap.fit} warn={fitIsCover} />
      <DebugLine
        label="video"
        value={snap.videoW ? `${snap.videoW}×${snap.videoH}` : "—"}
      />
      <DebugLine label="displayed" value={`${snap.dispW}×${snap.dispH}`} />
      <DebugLine label="container" value={`${snap.contW}×${snap.contH}`} />
      {identityViolated && (
        <div className="mt-1 text-[10px] text-rose-300">
          ⚠ transform ≠ identity with no moment
        </div>
      )}
      {fitIsCover && (
        <div className="mt-1 text-[10px] text-amber-300">
          ⚠ object-fit: cover is cropping
        </div>
      )}
    </div>
  );
}

function DebugLine({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-white/60">{label}:</span>
      <span className={warn ? "text-rose-300" : "text-white"}>{value}</span>
    </div>
  );
}

type FocusHandle =
  | "move"
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

const MIN_FOCUS = 0.08;

/**
 * Framing guides shown while a Crop/Reframe moment is active: a title-safe
 * inset rectangle + a rule-of-thirds grid over the frame. Pure CSS, no
 * geometry — purely advisory. The draggable box (EditableFocusBox) is the
 * actual output framing. Preview-only; never drawn into the export.
 */
function CropGuides() {
  return (
    <div className="pointer-events-none absolute inset-0 z-[6]">
      <div className="absolute inset-[6%] rounded-[3px] border border-dashed border-white/25" />
      <div className="absolute left-1/3 top-0 h-full w-px bg-white/12" />
      <div className="absolute left-2/3 top-0 h-full w-px bg-white/12" />
      <div className="absolute left-0 top-1/3 h-px w-full bg-white/12" />
      <div className="absolute left-0 top-2/3 h-px w-full bg-white/12" />
      <span className="absolute left-1/2 top-2 -translate-x-1/2 rounded bg-black/50 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white/70">
        Safe area
      </span>
    </div>
  );
}

/**
 * Draggable + resizable focus region, drawn directly on the frame. Move the
 * body to retarget the zoom centre; drag a handle to resize. Updates a local
 * draft live (instant visual feedback) and commits to the moment on release.
 */
function EditableFocusBox({
  moment,
  aspectRef,
  onCommit,
  ghost = false,
}: {
  moment: DetectedMoment;
  aspectRef: React.RefObject<HTMLDivElement | null>;
  onCommit: (fr: FocusRegion) => void;
  /**
   * Render at reduced opacity, with handles only visible on hover. Used
   * during preview-mode playback so the user can still drag the focus box
   * without it competing with the cinematic camera animation.
   */
  ghost?: boolean;
}) {
  const [draft, setDraft] = React.useState<FocusRegion>(moment.focusRegion);
  // Mirror of `draft` so the pointerup handler can read the latest region
  // WITHOUT calling onCommit inside a setState updater (that runs during render
  // → "Cannot update a component while rendering a different component").
  const draftRef = React.useRef<FocusRegion>(draft);
  const dragRef = React.useRef<{
    handle: FocusHandle;
    startX: number;
    startY: number;
    orig: FocusRegion;
  } | null>(null);

  // Keep the draft in sync when the underlying moment changes externally.
  React.useEffect(() => {
    if (!dragRef.current) {
      setDraft(moment.focusRegion);
      draftRef.current = moment.focusRegion;
    }
  }, [moment.focusRegion]);

  const begin = (e: React.PointerEvent, handle: FocusHandle) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      orig: draft,
    };
  };

  React.useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      const box = aspectRef.current;
      if (!d || !box) return;
      const rect = box.getBoundingClientRect();
      const dx = (e.clientX - d.startX) / rect.width;
      const dy = (e.clientY - d.startY) / rect.height;
      let { x, y, width, height } = d.orig;

      if (d.handle === "move") {
        x = clamp(d.orig.x + dx, 0, 1 - width);
        y = clamp(d.orig.y + dy, 0, 1 - height);
      } else {
        if (d.handle.includes("w")) {
          const nx = clamp(d.orig.x + dx, 0, d.orig.x + d.orig.width - MIN_FOCUS);
          width = d.orig.x + d.orig.width - nx;
          x = nx;
        }
        if (d.handle.includes("e")) {
          width = clamp(d.orig.width + dx, MIN_FOCUS, 1 - d.orig.x);
        }
        if (d.handle.includes("n")) {
          const ny = clamp(d.orig.y + dy, 0, d.orig.y + d.orig.height - MIN_FOCUS);
          height = d.orig.y + d.orig.height - ny;
          y = ny;
        }
        if (d.handle.includes("s")) {
          height = clamp(d.orig.height + dy, MIN_FOCUS, 1 - d.orig.y);
        }
      }
      const next = {
        x: round3(x),
        y: round3(y),
        width: round3(width),
        height: round3(height),
      };
      draftRef.current = next;
      setDraft(next);
    };
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        // Commit from the ref in the event handler — NOT inside a setState
        // updater (which would run during render and warn).
        onCommit(draftRef.current);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [aspectRef, onCommit]);

  const handles: { id: FocusHandle; cls: string; cursor: string }[] = [
    { id: "nw", cls: "-left-1 -top-1", cursor: "nwse-resize" },
    { id: "ne", cls: "-right-1 -top-1", cursor: "nesw-resize" },
    { id: "sw", cls: "-bottom-1 -left-1", cursor: "nesw-resize" },
    { id: "se", cls: "-bottom-1 -right-1", cursor: "nwse-resize" },
    { id: "n", cls: "-top-1 left-1/2 -translate-x-1/2", cursor: "ns-resize" },
    { id: "s", cls: "-bottom-1 left-1/2 -translate-x-1/2", cursor: "ns-resize" },
    { id: "w", cls: "-left-1 top-1/2 -translate-y-1/2", cursor: "ew-resize" },
    { id: "e", cls: "-right-1 top-1/2 -translate-y-1/2", cursor: "ew-resize" },
  ];

  return (
    <div
      onPointerDown={(e) => begin(e, "move")}
      className={cn(
        "group absolute z-30 cursor-move rounded-md ring-2 ring-violet-400/90 shadow-[0_0_0_4px_rgba(139,92,246,0.18)] transition-opacity duration-150",
        ghost
          ? "opacity-25 hover:opacity-90 focus-within:opacity-90"
          : "opacity-100"
      )}
      style={{
        left: `${draft.x * 100}%`,
        top: `${draft.y * 100}%`,
        width: `${draft.width * 100}%`,
        height: `${draft.height * 100}%`,
        touchAction: "none",
      }}
    >
      <span className="pointer-events-none absolute inset-0 bg-violet-400/[0.06]" />
      <span
        className={cn(
          "pointer-events-none absolute -top-6 left-0 inline-flex items-center gap-1 rounded-md bg-violet-500 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white shadow-violet-glow transition-opacity duration-150",
          ghost && "opacity-0 group-hover:opacity-100"
        )}
      >
        <Move3D size={9} />
        {moment.label}
      </span>
      <span className="pointer-events-none absolute inset-0 grid place-items-center">
        <span className="size-1.5 rounded-full bg-violet-300 shadow-[0_0_8px_rgba(196,181,253,0.9)]" />
      </span>
      {handles.map((h) => (
        <span
          key={h.id}
          onPointerDown={(e) => begin(e, h.id)}
          className={cn(
            "absolute size-2.5 rounded-[2px] border border-violet-200 bg-violet-500 transition-opacity duration-150",
            h.cls,
            ghost && "opacity-0 group-hover:opacity-100"
          )}
          style={{ cursor: h.cursor, touchAction: "none" }}
        />
      ))}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * CV debug overlay — draws the motion-hotspot centroid path over a trailing
 * window of the timeline, with a pulsing dot at the current centroid.
 */
function CentroidPath({
  visualAnalysis: va,
  currentTime,
  duration,
}: {
  visualAnalysis: VisualAnalysis;
  currentTime: number;
  duration: number;
}) {
  const bucket = Math.max(
    0,
    Math.min(va.sampleCount - 1, Math.floor(currentTime * va.sampleRate))
  );
  const from = Math.max(0, bucket - 8);
  const to = Math.min(va.sampleCount - 1, bucket + 2);

  const pts: { x: number; y: number }[] = [];
  for (let b = from; b <= to; b++) {
    pts.push({
      x: dequantize(va.centroidX[b] ?? 128) * 100,
      y: dequantize(va.centroidY[b] ?? 128) * 100,
    });
  }
  if (pts.length === 0) return null;
  const head = {
    x: dequantize(va.centroidX[bucket] ?? 128) * 100,
    y: dequantize(va.centroidY[bucket] ?? 128) * 100,
  };
  void duration;

  return (
    <svg
      aria-hidden
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 z-20 h-full w-full"
    >
      <polyline
        points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
        fill="none"
        stroke="rgba(34,211,238,0.55)"
        strokeWidth={0.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        strokeDasharray="2 1.5"
      />
      {pts.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={0.6}
          fill="rgba(34,211,238,0.5)"
        />
      ))}
      <circle cx={head.x} cy={head.y} r={1.6} fill="none" stroke="#22D3EE" strokeWidth={0.5} vectorEffect="non-scaling-stroke">
        <animate attributeName="r" values="1.2;2.4;1.2" dur="1.4s" repeatCount="indefinite" />
      </circle>
      <circle cx={head.x} cy={head.y} r={0.9} fill="#22D3EE" />
    </svg>
  );
}

function OverlayLayer({
  moment,
  currentTime,
  clickHighlightStyle,
  clickHighlightSize,
  clickHighlightsEnabled,
}: {
  moment: DetectedMoment;
  currentTime: number;
  clickHighlightStyle: "ring" | "pulse" | "burst";
  clickHighlightSize: number;
  clickHighlightsEnabled: boolean;
}) {
  if (!clickHighlightsEnabled || moment.effectType !== "click-highlight") {
    return null;
  }
  return (
    <ClickHighlight
      x={moment.focusRegion.x + moment.focusRegion.width / 2}
      y={moment.focusRegion.y + moment.focusRegion.height / 2}
      progress={
        (currentTime - moment.startTime) /
        Math.max(0.1, moment.endTime - moment.startTime)
      }
      style={clickHighlightStyle}
      sizePct={clickHighlightSize}
    />
  );
}

/**
 * Click-highlight overlay for the preview. Sizes + opacities all come
 * from the shared `clickHighlightGeometry` helper so the canvas
 * exporter (`drawClickHighlight`) and this DOM renderer can't drift
 * apart. Each style — ring / pulse / burst — maps the same geometry
 * tuple to its own DOM shape.
 *
 * `outer.radius` is a "reference px" value at the editor's typical
 * 1280-wide preview surface, which is what the original CSS used. The
 * exporter scales it for higher-resolution canvases; preview keeps the
 * native px since it's already running at that surface.
 */
function ClickHighlight({
  x,
  y,
  progress,
  style,
  sizePct,
}: {
  x: number;
  y: number;
  progress: number;
  style: "ring" | "pulse" | "burst";
  sizePct: number;
}) {
  const geom = clickHighlightGeometry(progress, sizePct, style);
  const left = `${x * 100}%`;
  const top = `${y * 100}%`;

  if (style === "pulse") {
    const outerSize = geom.outer.radius * 2;
    const innerSize = (geom.innerRing?.radius ?? 0) * 2;
    return (
      <>
        <span
          className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-400/40 blur-[1px]"
          style={{
            left,
            top,
            width: `${outerSize}px`,
            height: `${outerSize}px`,
            opacity: geom.outer.opacity,
          }}
        />
        {geom.innerRing && (
          <span
            className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2 rounded-full border border-violet-200"
            style={{
              left,
              top,
              width: `${innerSize}px`,
              height: `${innerSize}px`,
              opacity: geom.innerRing.opacity,
            }}
          />
        )}
      </>
    );
  }

  if (style === "burst") {
    const size = geom.outer.radius * 2;
    const spokes = geom.spokes;
    return (
      <span
        aria-hidden
        className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2"
        style={{
          left,
          top,
          width: `${size}px`,
          height: `${size}px`,
          opacity: geom.outer.opacity,
        }}
      >
        {spokes && (
          <svg viewBox="0 0 100 100" className="h-full w-full">
            {Array.from({ length: spokes.count }).map((_, i) => {
              const a = (i / spokes.count) * Math.PI * 2;
              const r1 = spokes.innerRatio * 100;
              const r2 = spokes.outerRatio * 100;
              const x1 = 50 + Math.cos(a) * r1;
              const y1 = 50 + Math.sin(a) * r1;
              const x2 = 50 + Math.cos(a) * r2;
              const y2 = 50 + Math.sin(a) * r2;
              return (
                <line
                  key={i}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="rgba(196,181,253,0.95)"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              );
            })}
          </svg>
        )}
      </span>
    );
  }

  // "ring" — default
  const ringSize = geom.outer.radius * 2;
  return (
    <span
      className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2 rounded-full border border-violet-400/80"
      style={{
        left,
        top,
        width: `${ringSize}px`,
        height: `${ringSize}px`,
        opacity: geom.outer.opacity,
      }}
    />
  );
}
