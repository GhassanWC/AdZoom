"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  Sparkles,
  Eye,
  EyeOff,
  Move3D,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useEditorReal } from "./context";
import { dequantize } from "@/lib/cv/resample";
import { cameraForMoment, localProgress, IDENTITY_CAMERA } from "@/lib/timeline/camera";
import type {
  DetectedMoment,
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
  activeMoment: DetectedMoment | null;
  previewMode: boolean;
  autoZoom: number;
  zoomSpeed: number;
  pacing: string;
}

/**
 * Continuous cinematic camera. A rAF loop recomputes the *target* every frame
 * from the live `video.currentTime` (so keyframed moments animate through
 * their keyframes), then eases the *current* transform toward it with
 * time-based exponential smoothing — inertia, natural deceleration, never a
 * robotic straight CSS line. A very low amplitude drift keeps the frame alive
 * while zoomed in. The shared `cameraForMoment` model is the same one the
 * export renderer uses, so preview === export.
 */
function useCinematicCamera(
  wrapRef: React.RefObject<HTMLDivElement | null>,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  state: CameraDriverState
) {
  const currentRef = React.useRef({ scale: 1, tx: 0, ty: 0 });
  const stateRef = React.useRef(state);
  stateRef.current = state;

  React.useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = stateRef.current;

      // Recompute the target from the live playhead each frame.
      let tgt = IDENTITY_CAMERA;
      if (s.previewMode && s.activeMoment) {
        const m = s.activeMoment;
        const t = videoRef.current?.currentTime ?? m.startTime;
        const perMoment =
          m.intensity ??
          m.recommendedIntensity ??
          m.attentionScore ??
          m.importance ??
          0.5;
        const blended = perMoment * 0.6 + (s.autoZoom / 100) * 0.4;
        tgt = cameraForMoment(m, blended, localProgress(m, t));
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

      // Subtle inertial drift — only when meaningfully zoomed in.
      let dx = 0;
      let dy = 0;
      if (cur.scale > 1.03) {
        const amp = Math.min(0.5, (cur.scale - 1) * 0.6);
        dx = Math.sin(now * 0.00045) * amp * 0.7;
        dy = Math.cos(now * 0.00032) * amp * 0.55;
      }

      const el = wrapRef.current;
      if (el) {
        el.style.transform = `translate(${(cur.tx + dx).toFixed(3)}%, ${(
          cur.ty + dy
        ).toFixed(3)}%) scale(${cur.scale.toFixed(4)})`;
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
    duration,
    setDuration,
    activeMoment,
    previewMode,
    setPreviewMode,
    cvDebug,
    updateMoment,
  } = useEditorReal();

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const aspectRef = React.useRef<HTMLDivElement | null>(null);
  const transformWrapRef = React.useRef<HTMLDivElement | null>(null);
  const [muted, setMuted] = React.useState(false);
  const [volume, setVolume] = React.useState(1);

  // Wire video element events
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onLoaded = () => {
      if (Number.isFinite(v.duration)) setDuration(v.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onLoaded);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [videoRef, setCurrentTime, setDuration, setPlaying]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) safePlay(v);
    else v.pause();
  };

  const onScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const t = Number(e.target.value);
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

  // Cinematic camera — the rAF loop recomputes the target each frame from the
  // live playhead (so keyframed moments animate live).
  useCinematicCamera(transformWrapRef, videoRef, {
    activeMoment,
    previewMode,
    autoZoom: project.effectsSettings.autoZoom,
    zoomSpeed: project.effectsSettings.zoomSpeed,
    pacing: project.effectsSettings.pacing,
  });

  // Vertical reframe — when the preset asks for 9:16, mask the player.
  const verticalPreview = previewMode && project.effectsSettings.verticalExport;
  const va = project.visualAnalysis;

  return (
    <div ref={containerRef} className="relative">
      <div
        ref={aspectRef}
        className={cn(
          "relative w-full overflow-hidden rounded-xl border border-white/[0.06] bg-black shadow-cinematic",
          verticalPreview
            ? "mx-auto aspect-[9/16] max-h-[72vh]"
            : "mx-auto aspect-video max-h-[56vh] max-w-[100vh]"
        )}
      >
        {/* The real <video>. The cinematic camera writes `transform` directly
            onto this wrapper every frame (no React re-render, no CSS tween). */}
        <div
          ref={transformWrapRef}
          className="absolute inset-0 origin-center will-change-transform"
        >
          <video
            ref={videoRef}
            src={project.originalVideoUrl || undefined}
            className="h-full w-full object-contain"
            playsInline
            crossOrigin="anonymous"
            preload="metadata"
          >
            <track kind="captions" />
          </video>
          {!project.originalVideoUrl && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-fog">
              No video loaded.
            </div>
          )}

          {/* CV debug: motion-hotspot centroid path, tracks with the video. */}
          {cvDebug && va && va.sampleCount > 0 && (
            <CentroidPath
              visualAnalysis={va}
              currentTime={currentTime}
              duration={duration > 0 ? duration : project.duration ?? 0}
            />
          )}
        </div>

        {/* Overlays — click highlights + captions */}
        {activeMoment && (
          <OverlayLayer
            moment={activeMoment}
            currentTime={currentTime}
            captionStyle={project.effectsSettings.captionStyle}
            clickHighlightStyle={project.effectsSettings.clickHighlightStyle}
            clickHighlightSize={project.effectsSettings.clickHighlightSize}
            clickHighlightsEnabled={project.effectsSettings.clickHighlights}
            caption={
              project.effectsSettings.captionStyle === "none"
                ? null
                : findCaptionAt(project.analysis?.suggestedCaptions ?? [], currentTime)
            }
          />
        )}

        {/* Editable focus region — drag/resize the zoom target directly on the
            frame. Shown with preview OFF so the box maps 1:1 to the source. */}
        {activeMoment && !previewMode && (
          <EditableFocusBox
            key={activeMoment.id}
            moment={activeMoment}
            aspectRef={aspectRef}
            onCommit={(focusRegion) =>
              updateMoment(activeMoment.id, { focusRegion })
            }
          />
        )}

        {/* Hint: reposition focus needs preview OFF */}
        {activeMoment && previewMode && (
          <div className="pointer-events-none absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-[10px] text-white/80 backdrop-blur-md">
            Turn Preview OFF to reposition the focus box
          </div>
        )}

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

        {/* Preview toggle */}
        <button
          onClick={() => setPreviewMode(!previewMode)}
          className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/40 px-2.5 py-1 text-[10px] font-medium text-white/90 backdrop-blur-md transition-colors duration-200 hover:bg-black/60"
        >
          {previewMode ? <Eye size={11} /> : <EyeOff size={11} />}
          {previewMode ? "Preview ON" : "Preview OFF"}
        </button>

        {/* Vignette */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_60%,rgba(0,0,0,0.25)_100%)]"
        />

        {/* Controls */}
        <div className="absolute inset-x-0 bottom-0 z-40 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-4 pb-3 pt-10">
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
              aria-label="Fullscreen"
              className="text-fog transition-colors duration-200 hover:text-white"
            >
              <Maximize2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function findCaptionAt(
  captions: { startTime: number; text: string }[],
  t: number
): string | null {
  let best: { startTime: number; text: string } | null = null;
  for (const c of captions) {
    if (t >= c.startTime && t <= c.startTime + 3) {
      if (!best || c.startTime > best.startTime) best = c;
    }
  }
  return best?.text ?? null;
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
 * Draggable + resizable focus region, drawn directly on the frame. Move the
 * body to retarget the zoom centre; drag a handle to resize. Updates a local
 * draft live (instant visual feedback) and commits to the moment on release.
 */
function EditableFocusBox({
  moment,
  aspectRef,
  onCommit,
}: {
  moment: DetectedMoment;
  aspectRef: React.RefObject<HTMLDivElement | null>;
  onCommit: (fr: FocusRegion) => void;
}) {
  const [draft, setDraft] = React.useState<FocusRegion>(moment.focusRegion);
  const dragRef = React.useRef<{
    handle: FocusHandle;
    startX: number;
    startY: number;
    orig: FocusRegion;
  } | null>(null);

  // Keep the draft in sync when the underlying moment changes externally.
  React.useEffect(() => {
    if (!dragRef.current) setDraft(moment.focusRegion);
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
      setDraft({
        x: round3(x),
        y: round3(y),
        width: round3(width),
        height: round3(height),
      });
    };
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        setDraft((d) => {
          onCommit(d);
          return d;
        });
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
      className="absolute z-30 cursor-move rounded-md ring-2 ring-violet-400/90 shadow-[0_0_0_4px_rgba(139,92,246,0.18)] transition-shadow"
      style={{
        left: `${draft.x * 100}%`,
        top: `${draft.y * 100}%`,
        width: `${draft.width * 100}%`,
        height: `${draft.height * 100}%`,
        touchAction: "none",
      }}
    >
      <span className="pointer-events-none absolute inset-0 bg-violet-400/[0.06]" />
      <span className="pointer-events-none absolute -top-6 left-0 inline-flex items-center gap-1 rounded-md bg-violet-500 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white shadow-violet-glow">
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
            "absolute size-2.5 rounded-[2px] border border-violet-200 bg-violet-500",
            h.cls
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
  caption,
  captionStyle,
  clickHighlightStyle,
  clickHighlightSize,
  clickHighlightsEnabled,
}: {
  moment: DetectedMoment;
  currentTime: number;
  caption: string | null;
  captionStyle: "none" | "minimal" | "bold-pop" | "tutorial-tooltip" | "subtitle";
  clickHighlightStyle: "ring" | "pulse" | "burst";
  clickHighlightSize: number;
  clickHighlightsEnabled: boolean;
}) {
  return (
    <>
      {clickHighlightsEnabled && moment.effectType === "click-highlight" && (
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
      )}

      <AnimatePresence>
        {caption && captionStyle !== "none" && (
          <motion.div
            key={`${caption}-${captionStyle}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.3 }}
            className={cn(
              "pointer-events-none absolute z-30 flex px-6",
              captionStyle === "tutorial-tooltip"
                ? "left-1/2 top-1/3 -translate-x-1/2"
                : "inset-x-0 bottom-20 justify-center"
            )}
          >
            <span className={captionClass(captionStyle)}>{caption}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function captionClass(style: string): string {
  switch (style) {
    case "bold-pop":
      return "rounded-md bg-white px-3 py-1.5 text-base font-extrabold uppercase tracking-tight text-black shadow-cinematic";
    case "tutorial-tooltip":
      return "rounded-lg border border-violet-400/40 bg-violet-500/90 px-3 py-1.5 text-[13px] font-semibold text-white shadow-violet-glow";
    case "subtitle":
      return "rounded bg-black/85 px-2 py-1 text-[13px] font-medium text-white";
    case "minimal":
    default:
      return "rounded-lg bg-black/70 px-3 py-1.5 text-[13px] font-semibold text-white shadow-cinematic backdrop-blur-md";
  }
}

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
  const p = Math.max(0, Math.min(1, progress));
  const base = 24 + (sizePct / 100) * 72;

  if (style === "pulse") {
    return (
      <>
        <span
          className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-400/40 blur-[1px]"
          style={{
            left: `${x * 100}%`,
            top: `${y * 100}%`,
            width: `${base + p * 80}px`,
            height: `${base + p * 80}px`,
            opacity: 0.8 - p * 0.6,
          }}
        />
        <span
          className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2 rounded-full border border-violet-200"
          style={{
            left: `${x * 100}%`,
            top: `${y * 100}%`,
            width: `${base * 0.55}px`,
            height: `${base * 0.55}px`,
            opacity: 0.9,
          }}
        />
      </>
    );
  }

  if (style === "burst") {
    return (
      <span
        aria-hidden
        className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2"
        style={{
          left: `${x * 100}%`,
          top: `${y * 100}%`,
          width: `${base + p * 120}px`,
          height: `${base + p * 120}px`,
          opacity: 1 - p * 0.85,
        }}
      >
        <svg viewBox="0 0 100 100" className="h-full w-full">
          {Array.from({ length: 10 }).map((_, i) => {
            const a = (i / 10) * Math.PI * 2;
            const r1 = 30;
            const r2 = 48;
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
      </span>
    );
  }

  // "ring" — default
  return (
    <span
      className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2 rounded-full border border-violet-400/80"
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${base + p * 64}px`,
        height: `${base + p * 64}px`,
        opacity: 1 - p * 0.7,
      }}
    />
  );
}
