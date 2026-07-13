"use client";

import * as React from "react";
import { fmtPrecise } from "./utils";

/**
 * Cinematic playhead — a chunkier triangle head, a glowing time chip just
 * below the ruler, and a sharp 1-px line that drops the full track height.
 *
 * MOTION / PERF — the playhead is the one thing on this page that moves
 * continuously, so it gets special treatment:
 *
 *  • It is NOT driven by React state. The editor's `currentTime` comes from the
 *    video's `timeupdate` event, which browsers fire only ~4×/second — rendering
 *    the playhead from it made it visibly step across the track. Here we read
 *    `video.currentTime` in a rAF loop and write `transform` STRAIGHT to the
 *    node, so it moves at display refresh rate, perfectly in sync with the audio,
 *    and the timeline (with all its moment pills) never re-renders while playing.
 *
 *  • It moves with `transform: translate3d`, not `left`. `left` re-runs layout +
 *    paint on every frame; a composited transform does neither, which is what
 *    keeps a timeline full of moments smooth.
 *
 *  • There is deliberately NO transition on the position. A transition would make
 *    the head glide toward where the video already is — i.e. lag behind the
 *    picture and desync from the audio. Continuous motion must be driven, not
 *    eased. (Reduced-motion users are unaffected for the same reason: this isn't
 *    decorative movement, it IS the data.)
 *
 * The rAF loop only runs while playing; when paused we paint once from the
 * `currentTime` prop, so scrubbing and seeking stay exact and the loop costs
 * nothing at rest.
 */
export function Playhead({
  videoRef,
  currentTime,
  playing,
  total,
  rulerHeight,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  playing: boolean;
  total: number;
  rulerHeight: number;
}) {
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const chipRef = React.useRef<HTMLSpanElement | null>(null);
  /** Track width in px, measured (not read per-frame — that would force layout). */
  const widthRef = React.useRef(0);

  // Measure the track once and on resize/zoom. Positioning in PIXELS (rather
  // than a % translate) keeps the node zero-width, so it can never widen the
  // scroll extent of the track it sits in.
  React.useEffect(() => {
    const el = wrapRef.current?.parentElement;
    if (!el) return;
    const measure = () => {
      widthRef.current = el.clientWidth;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const paint = React.useCallback(
    (t: number) => {
      if (total <= 0) return;
      const clamped = Math.max(0, Math.min(total, t));
      const x = (clamped / total) * widthRef.current;
      const node = wrapRef.current;
      if (node) node.style.transform = `translate3d(${x}px, 0, 0)`;
      const chip = chipRef.current;
      if (chip) chip.textContent = fmtPrecise(clamped);
    },
    [total]
  );

  // Paused / seek / scrub path — exact, no interpolation.
  React.useEffect(() => {
    if (!playing) paint(currentTime);
  }, [playing, currentTime, paint]);

  // Playing path — display-rate, straight from the element that owns the truth.
  React.useEffect(() => {
    if (!playing || total <= 0) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) paint(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total, videoRef, paint]);

  if (total <= 0) return null;

  return (
    <div
      ref={wrapRef}
      className="pointer-events-none absolute inset-y-0 left-0 z-30 will-change-transform"
      aria-hidden
    >
      {/* Diamond head — sits on the ruler */}
      <span
        className="absolute -translate-x-1/2 rotate-45 rounded-[2px] bg-white shadow-[0_0_14px_rgba(255,255,255,0.95)]"
        style={{ top: 6, width: 12, height: 12 }}
      />
      {/* Time chip — just under the ruler. Its text is written directly by the
          rAF loop above, so it stays in step with the head without re-rendering. */}
      <span
        ref={chipRef}
        className="absolute -translate-x-1/2 whitespace-nowrap rounded-md border border-white/20 bg-ink/95 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-white shadow-cinematic backdrop-blur-md"
        style={{ top: rulerHeight + 4 }}
      >
        {fmtPrecise(currentTime)}
      </span>
      {/* Full-height line with violet bloom */}
      <span className="absolute inset-y-0 left-0 w-px -translate-x-1/2 bg-white/90 shadow-[0_0_10px_rgba(196,181,253,0.65)]" />
    </div>
  );
}
