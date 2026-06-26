"use client";

/**
 * Live "edited" preview for the admin viewer — renders the project's edits
 * (AI/user moments, Frame Crop, Canvas Fit, vignette, click-highlights) on a
 * canvas WITHOUT requiring an export. It drives a hidden <video> and paints
 * each frame through `composeFrame` + `buildRenderRecipe` — the exact shared
 * render core the browser exporter and cloud worker use — so what plays here
 * matches what an export would bake, by construction.
 *
 * `composeFrame` only ever draws (never reads back pixels), so the source video
 * can taint the canvas freely — no crossOrigin / CORS dependency for playback.
 *
 * The cut/speed handling in the rAF loop mirrors the editor preview
 * (`RealVideoPlayer`): jump active cuts, drive playbackRate from speed sections.
 */

import * as React from "react";
import { Play, Pause, Volume2, VolumeX } from "lucide-react";
import { buildRenderRecipe, type RenderRecipe } from "@/lib/render/recipe";
import { composeFrame } from "@/lib/render/compose-frame";
import {
  activeCutAt,
  activeSpeedAt,
  snapOutOfActiveCut,
} from "@/lib/timeline/crop-speed";
import type {
  DetectedMoment,
  EffectsSettings,
  SourceCrop,
  VisualAnalysis,
} from "@/lib/firebase/schema";

export interface RenderInputs {
  moments: DetectedMoment[];
  effects: EffectsSettings;
  visualAnalysis: VisualAnalysis | null;
  sourceCrop: SourceCrop | null;
}

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function AdminEditedPreview({
  videoUrl,
  render,
}: {
  videoUrl: string;
  render: RenderInputs;
}) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const ctxRef = React.useRef<CanvasRenderingContext2D | null>(null);
  const recipeRef = React.useRef<RenderRecipe | null>(null);

  const [ready, setReady] = React.useState(false);
  const [playing, setPlaying] = React.useState(false);
  const [muted, setMuted] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  // Build the render recipe once the source video reports real dimensions, then
  // size the canvas and paint the first frame.
  const buildRecipe = React.useCallback(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !v.videoWidth || !v.videoHeight) return;
    try {
      const recipe = buildRenderRecipe({
        sourceWidth: v.videoWidth,
        sourceHeight: v.videoHeight,
        fps: 30,
        resolution: "1080p",
        format: render.effects.defaultExportFormat ?? "Source",
        sourceDuration: Number.isFinite(v.duration) ? v.duration : 0,
        moments: render.moments,
        effects: render.effects,
        visualAnalysis: render.visualAnalysis ?? undefined,
        sourceCrop: render.sourceCrop ?? undefined,
        applyWatermark: false,
      });
      recipeRef.current = recipe;
      c.width = recipe.canvasW;
      c.height = recipe.canvasH;
      // Resizing the canvas resets context state — set smoothing after.
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctxRef.current = ctx;
        composeFrame(ctx, v, recipe, v.currentTime);
      }
      setReady(true);
      // Auto-play so the edits are visible in motion immediately. Unmuted may be
      // blocked by autoplay policy — then it stays paused and the user presses play.
      const p = v.play();
      if (p && typeof p.then === "function") p.catch(() => {});
    } catch (err) {
      console.error("[admin-edited-preview] recipe build failed", err);
      setError("Couldn't build the edited preview for this project.");
    }
  }, [render]);

  // Wire video events.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onLoaded = () => {
      if (Number.isFinite(v.duration)) setDuration(v.duration);
      buildRecipe();
    };
    const onTime = () => setCurrentTime(v.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => setError("This video couldn't be loaded.");
    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("error", onError);
    return () => {
      v.removeEventListener("loadedmetadata", onLoaded);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("error", onError);
    };
  }, [buildRecipe]);

  // rAF render loop — jump cuts, apply speed, composite every frame. Mirrors
  // the editor preview so the canvas tracks the same edits the export bakes.
  React.useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      const ctx = ctxRef.current;
      const recipe = recipeRef.current;
      if (v && ctx && recipe) {
        if (!v.paused && !v.seeking) {
          const cut = activeCutAt(recipe.moments, v.currentTime);
          if (cut) v.currentTime = cut.endTime;
        }
        const sp = activeSpeedAt(recipe.moments, v.currentTime);
        const rate = sp ? clamp(sp.multiplier, 0.0625, 16) : 1;
        if (Math.abs(v.playbackRate - rate) > 0.001) {
          v.playbackRate = rate;
          try {
            (v as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true;
          } catch {
            /* not supported — ignore */
          }
        }
        composeFrame(ctx, v, recipe, v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      const p = v.play();
      if (p && typeof p.then === "function") {
        p.catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          /* autoplay policy — leave paused, user can press play */
        });
      }
    } else {
      v.pause();
    }
  };

  const onScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const t = snapOutOfActiveCut(render.moments, Number(e.target.value));
    v.currentTime = t;
    setCurrentTime(t);
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = !muted;
    v.muted = next;
    setMuted(next);
  };

  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-white/[0.06] bg-black">
      {/* Source — frame + audio provider for the canvas. Kept in the render
          tree (NOT display:none, which throttles decoding in some browsers) but
          visually hidden behind the canvas. */}
      <video
        ref={videoRef}
        src={videoUrl}
        playsInline
        preload="auto"
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
      />
      <canvas ref={canvasRef} className="max-h-full max-w-full" />

      {error ? (
        <span className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-rose-300">
          {error}
        </span>
      ) : !ready ? (
        <span className="absolute inset-0 grid place-items-center text-sm text-fog">
          Rendering edits…
        </span>
      ) : null}

      {/* Controls */}
      {ready && !error && (
        <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-4 pb-3 pt-10">
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
              className="h-1 flex-1"
              style={{
                accentColor: "#8B5CF6",
              }}
            />
            <span className="font-mono text-[11px] tabular-nums text-fog/70">
              {fmt(duration)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
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
              type="button"
              onClick={toggleMute}
              aria-label={muted ? "Unmute" : "Mute"}
              className="text-fog transition-colors duration-200 hover:text-white"
            >
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
