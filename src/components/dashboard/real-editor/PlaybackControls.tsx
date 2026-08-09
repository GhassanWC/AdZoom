"use client";

import * as React from "react";
import {
  Play,
  Pause,
  SkipBack,
  RotateCcw,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useEditorReal } from "./context";
import { useClockSelector } from "./playback-clock";
import { useRenderCount } from "@/lib/perf/render-probe";
import { useLiveValue } from "./useLiveValue";
import { COMMIT_PROFILES } from "./live-commit";
import { cn } from "@/lib/cn";

/**
 * Shared button chrome for every secondary (non-primary) transport control.
 * `fv-press-sm` gives every one of them a scale-down on press — transport
 * controls are hit constantly, and a button that doesn't answer the press is the
 * fastest way to make a tool feel dead. Hover adds a soft surface so the target
 * reads before it's clicked; both are gated to real pointers by `fv-press`/`fv-lift`.
 */
export const PLAYBACK_SECONDARY_CLS =
  "fv-press-sm inline-flex size-9 shrink-0 items-center justify-center rounded-full text-fog transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:pointer-events-none disabled:opacity-30";

/**
 * The center transport group — jump-to-start, back 5s, the large Play/Pause,
 * forward 5s, and the time readout. ONE implementation shared by the editor's
 * unified control bar (EditorUnifiedControlBar) and the fullscreen overlay
 * pill (PlaybackControls below), so the <video> element's play/pause/seek path
 * is never duplicated. All state comes from context — `togglePlay`/`seek`/
 * `seekBy` drive the element directly; `playing`/`currentTime`/`duration`
 * mirror it. Scrubbing itself lives on the timeline (click/drag the playhead).
 */
export function PlaybackTransport() {
  useRenderCount("playback-transport");
  const { project, playing, duration, togglePlay, seek, seekBy } =
    useEditorReal();

  const total = duration > 0 ? duration : project.duration ?? 0;
  // Booleans, not the raw time: these decide whether two buttons are disabled
  // and flip twice per playthrough. Subscribing the whole transport to the clock
  // re-rendered every button several times a second for no visible change; the
  // moving readout is isolated in <TransportTime> below.
  const atStart = useClockSelector((t) => t <= 0.02);
  const atEnd = useClockSelector((t) => total > 0 && t >= total - 0.05);

  return (
    <>
      {/* Jump to start */}
      <button
        type="button"
        onClick={() => seek(0)}
        disabled={atStart}
        aria-label="Jump to start"
        title="Jump to start"
        className={cn(PLAYBACK_SECONDARY_CLS, "hidden sm:inline-flex")}
      >
        <SkipBack size={16} className="shrink-0 fill-current" />
      </button>

      {/* Back 5 seconds */}
      <button
        type="button"
        onClick={() => seekBy(-5)}
        disabled={atStart}
        aria-label="Back 5 seconds"
        title="Back 5 seconds"
        className={cn(PLAYBACK_SECONDARY_CLS, "relative")}
      >
        <RotateCcw size={18} className="shrink-0" />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[7px] font-bold leading-none">
          5
        </span>
      </button>

      {/* Large Play / Pause — the primary control */}
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? "Pause" : "Play"}
        title={playing ? "Pause (Space)" : "Play (Space)"}
        // The primary control: a firmer press (0.94) than the icon buttons, and
        // a hover lift so the most-used button in the editor feels alive.
        className="relative inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-violet-500 text-white shadow-[0_6px_20px_-6px_rgba(139,92,246,0.7)] transition-[transform,background-color,box-shadow] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-violet-400 hover:shadow-[0_8px_24px_-6px_rgba(139,92,246,0.85)] active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-40"
      >
        {/*
          Play ⇄ Pause crossfade. The outgoing icon shrinks to 0.6 (never to 0 —
          nothing in the real world vanishes to nothing) while the incoming one
          scales up, so the two states read as ONE control changing rather than
          two icons swapping. 160ms: this button is pressed constantly, and
          anything slower starts to feel like the video is lagging the click.
        */}
        <Play
          size={18}
          className={cn(
            "absolute shrink-0 translate-x-[1px] fill-current transition-[transform,opacity] duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)]",
            playing ? "scale-[0.6] opacity-0" : "scale-100 opacity-100"
          )}
        />
        <Pause
          size={18}
          className={cn(
            "absolute shrink-0 fill-current transition-[transform,opacity] duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)]",
            playing ? "scale-100 opacity-100" : "scale-[0.6] opacity-0"
          )}
        />
      </button>

      {/* Forward 5 seconds */}
      <button
        type="button"
        onClick={() => seekBy(5)}
        disabled={atEnd}
        aria-label="Forward 5 seconds"
        title="Forward 5 seconds"
        className={cn(PLAYBACK_SECONDARY_CLS, "relative")}
      >
        <RotateCw size={18} className="shrink-0" />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[7px] font-bold leading-none">
          5
        </span>
      </button>

      <TransportTime total={total} />
    </>
  );
}

/**
 * Volume handle with local drag state. `setPreviewVolume` writes editor context
 * state, so driving it straight from the input re-rendered every context
 * consumer on each pointermove of the drag. The handle now follows the pointer
 * locally and the context is updated on the drag cadence — inaudible as latency,
 * and roughly an order of magnitude fewer renders.
 */
function VolumeSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const live = useLiveValue(value, onChange, COMMIT_PROFILES.drag);
  return (
    <input
      type="range"
      min={0}
      max={1}
      step={0.01}
      value={live.value}
      onChange={(e) => live.set(Number(e.target.value))}
      onPointerDown={live.begin}
      onPointerUp={live.end}
      onPointerCancel={live.end}
      onKeyDown={live.begin}
      onKeyUp={live.end}
      onBlur={live.end}
      aria-label="Volume"
      title="Volume"
      className="range-thumb ml-1 h-0.5 w-[60px]"
    />
  );
}

/**
 * The moving time readout, deliberately its own component: it is the only part
 * of the transport that changes while the video plays, so it is the only part
 * that subscribes to the clock. Everything around it stays still.
 */
function TransportTime({ total }: { total: number }) {
  // The label only changes once a second, so selecting the FORMATTED string
  // (rather than the raw time) makes this ~1 re-render per second instead of one
  // per `timeupdate`.
  const label = useClockSelector((t) => fmtTime(t));
  return (
    // Tabular figures keep the layout from shifting while playing.
    <div className="ml-1 shrink-0 whitespace-nowrap font-mono text-[12px] tabular-nums text-fog sm:ml-2">
      <span className="text-white/90">{label}</span>
      <span className="mx-1 text-fog/50">/</span>
      <span>{fmtTime(total)}</span>
    </div>
  );
}

/**
 * Volume (mute toggle + hover-expand slider) and fullscreen — ONE shared
 * implementation, used by the unified control bar and the fullscreen overlay
 * pill. Preview volume is a local playback preference (never exported audio).
 */
export function PlaybackVolumeFullscreen() {
  const { muted, volume, toggleMute, setPreviewVolume, isFullscreen, toggleFullscreen } =
    useEditorReal();
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <>
      {/* Volume — the speaker toggles mute; the slider expands on hover / focus
          so it doesn't take space. On mobile only the mute icon shows. */}
      <div className="group flex items-center">
        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Unmute" : "Mute"}
          className={PLAYBACK_SECONDARY_CLS}
        >
          <VolumeIcon size={17} className="shrink-0" />
        </button>
        {/*
          The slider reveal is the one place the editor animates a layout property
          (width). It's deliberate and safe: a single 68px element, on hover, with
          nothing but the control bar's own flex row to re-lay-out — no list, no
          scroll container, no per-frame cost anywhere else. Reserving the space
          permanently (the transform-only alternative) would push the transport
          controls off-centre at rest, which is a worse trade for a tool the user
          stares at all day.
        */}
        <div className="hidden overflow-hidden opacity-0 transition-[width,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] sm:block sm:w-0 group-hover:w-[68px] group-hover:opacity-100 group-focus-within:w-[68px] group-focus-within:opacity-100">
          <VolumeSlider
            value={muted ? 0 : volume}
            onChange={setPreviewVolume}
          />
        </div>
      </div>

      {/* Fullscreen — immediately after the audio control. */}
      <button
        type="button"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        className={PLAYBACK_SECONDARY_CLS}
      >
        {isFullscreen ? (
          <Minimize2 size={16} className="shrink-0" />
        ) : (
          <Maximize2 size={16} className="shrink-0" />
        )}
      </button>
    </>
  );
}

/**
 * A compact translucent pill shown OVER the preview while fullscreen (the
 * unified control bar isn't visible then, so the preview needs its own
 * transport). Composed from the same PlaybackTransport/PlaybackVolumeFullscreen
 * pieces the unified bar uses — one playback implementation, two presentations.
 */
export function PlaybackControls() {
  return (
    <div className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/55 px-2 py-1.5 backdrop-blur-md">
      <PlaybackTransport />
      <span className="mx-0.5 h-5 w-px shrink-0 bg-white/10" aria-hidden />
      <PlaybackVolumeFullscreen />
    </div>
  );
}

function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, "0");
}

/** Compact `m:ss.SS` (minutes:seconds.hundredths), e.g. `0:07.20` / `1:15.45`. */
function fmtTime(s: number): string {
  const v = Number.isFinite(s) && s > 0 ? s : 0;
  const m = Math.floor(v / 60);
  const sec = Math.floor(v % 60);
  const cs = Math.floor((v - Math.floor(v)) * 100);
  return `${m}:${pad2(sec)}.${pad2(cs)}`;
}
