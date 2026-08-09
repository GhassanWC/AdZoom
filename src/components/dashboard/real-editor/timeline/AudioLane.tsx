"use client";

import * as React from "react";
import { VolumeX, Scissors } from "lucide-react";
import type { AudioAnalysis, DetectedMoment } from "@/lib/firebase/schema";
import { dequantizeArray } from "@/lib/cv/resample";
import { cn } from "@/lib/cn";
import { fmt } from "./utils";

/**
 * Read-only AUDIO lane.
 *
 * Framevo has no audio *edit* type — and this lane deliberately does not invent
 * one. Its whole job is to make the REAL audio, and the REAL audio consequences
 * of the edits that already exist, visible:
 *
 *   1. Waveform      — the actual RMS loudness measured during analysis.
 *   2. Silence       — the silence segments the audio analysis found.
 *   3. Removed audio — every span an ACTIVE cut deletes, struck through and
 *                      hatched, so "this cut also deletes this audio" is
 *                      something the user can literally see.
 *   4. Muted spans   — speed-up sections whose `audioMode` is "mute".
 *
 * Nothing here mutates a moment. Clicking anywhere seeks. When there is no
 * loudness data we say so — we never draw a decorative waveform for audio we
 * did not measure.
 *
 * Coordinates are percentage-of-`total` (source seconds), exactly like the
 * moment lanes: the parent scales the container by zoom, so this lane must
 * never reason in pixels-per-second.
 */

/** Virtual SVG viewport — the viewBox scales to the (zoomed) lane width. */
const W = 1000;
const H = 100;
const MID = H / 2;
/** Max half-height of the wave in viewBox units (leaves breathing room). */
const AMP = 44;
/** Peak-preserving downsample target — a long recording carries 1000s of samples. */
const MAX_SAMPLES = 640;
/**
 * Normalisation floor. We scale the wave by its own peak so a quiet recording
 * is still readable, but never below this — otherwise near-silent audio would
 * get amplified into a big, dishonest-looking waveform.
 */
const MIN_NORM = 0.25;

/** Same "how wide is this really?" heuristic MomentPill uses to pick a tier. */
const APPROX_VIEWPORT_PX = 500;

type Span = { id: string; start: number; end: number; label: string };

/** Peak-preserving bucket downsample — keeps transients, drops DOM/path cost. */
function downsample(values: number[], target: number): number[] {
  if (values.length <= target) return values;
  const out: number[] = [];
  const bucket = values.length / target;
  for (let i = 0; i < target; i++) {
    const s = Math.floor(i * bucket);
    const e = Math.min(values.length, Math.floor((i + 1) * bucket));
    let peak = 0;
    for (let j = s; j < e; j++) peak = Math.max(peak, values[j]);
    out.push(peak);
  }
  return out;
}

/**
 * Catmull-Rom → cubic Bézier, same smoothing constant as AttentionWaveform so
 * the two curves read as one family.
 */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M0,${pts[0][1].toFixed(2)} L${W},${pts[0][1].toFixed(2)}`;
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const t = 0.18;
    const cp1x = p1[0] + (p2[0] - p0[0]) * t;
    const cp1y = p1[1] + (p2[1] - p0[1]) * t;
    const cp2x = p2[0] - (p3[0] - p1[0]) * t;
    const cp2y = p2[1] - (p3[1] - p1[1]) * t;
    d += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(
      2
    )} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

/** Clamp a span to the timeline and drop anything with no length. */
function clampSpans(
  raw: Array<{ id: string; start: number; end: number; label: string }>,
  total: number
): Span[] {
  if (total <= 0) return [];
  const out: Span[] = [];
  for (const s of raw) {
    const start = Math.max(0, Math.min(total, s.start));
    const end = Math.max(0, Math.min(total, s.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= 0.01) continue;
    out.push({ id: s.id, start, end, label: s.label });
  }
  return out;
}

export function AudioLane({
  audioAnalysis,
  moments,
  total,
  height,
  onSeek,
}: {
  /** Real measured audio (RMS loudness, silence, speech) — may be absent. */
  audioAnalysis: AudioAnalysis | undefined;
  /** The FULL moment timeline — cuts + speed-ups are read from it. */
  moments: DetectedMoment[];
  /** Source duration in seconds. */
  total: number;
  /** Lane height in CSS px. */
  height: number;
  /** Seek the playhead (read-only lane — this is its only side effect). */
  onSeek: (t: number) => void;
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const gradId = React.useId();

  // ── Waveform geometry ────────────────────────────────────────────────
  const wave = React.useMemo(() => {
    const raw = audioAnalysis?.loudness;
    if (!raw || raw.length === 0 || total <= 0) return null;

    // 8-bit quantized (0..255) on the wire → 0..1 here.
    const values = downsample(dequantizeArray(raw), MAX_SAMPLES);
    if (values.length === 0) return null;

    let peak = 0;
    for (const v of values) if (v > peak) peak = v;
    const norm = Math.max(peak, MIN_NORM);

    // The loudness track may be shorter than the video (analysis window,
    // trailing silence trimmed). Map it honestly onto its real time span
    // instead of stretching it across the whole timeline.
    const declaredRate = audioAnalysis?.loudnessSampleRate;
    const rate =
      typeof declaredRate === "number" && Number.isFinite(declaredRate) && declaredRate > 0
        ? declaredRate
        : 1;
    const coveredSec = raw.length / rate;
    const widthPct = Math.max(1, Math.min(100, (coveredSec / total) * 100));

    const stepX = values.length > 1 ? W / (values.length - 1) : W;
    const top: Array<[number, number]> = values.map((v, i) => [
      i * stepX,
      MID - Math.min(1, v / norm) * AMP,
    ]);
    const bottom: Array<[number, number]> = top.map(([x, y]) => [x, H - y]);

    const topLine = smoothPath(top);
    const bottomLine = smoothPath(bottom);
    return {
      widthPct,
      topArea: `${topLine} L${W},${MID} L0,${MID} Z`,
      bottomArea: `${bottomLine} L${W},${MID} L0,${MID} Z`,
      topLine,
      bottomLine,
    };
  }, [audioAnalysis, total]);

  // ── Silence, removed (cut) and muted spans ───────────────────────────
  const silences = React.useMemo<Span[]>(
    () =>
      clampSpans(
        (audioAnalysis?.silenceSegments ?? []).map((s, i) => ({
          id: `sil-${i}-${s.startTime}`,
          start: s.startTime,
          end: s.endTime,
          label: "Silence",
        })),
        total
      ),
    [audioAnalysis, total]
  );

  const removed = React.useMemo<Span[]>(
    () =>
      clampSpans(
        moments
          .filter((m) => m.effectType === "cut" && m.cut?.active !== false)
          .map((m) => ({
            id: m.id,
            start: m.startTime,
            end: m.endTime,
            label: m.label || "Cut",
          })),
        total
      ),
    [moments, total]
  );

  const muted = React.useMemo<Span[]>(
    () =>
      clampSpans(
        moments
          .filter((m) => m.effectType === "speed-up" && m.speed?.audioMode === "mute")
          .map((m) => ({
            id: m.id,
            start: m.startTime,
            end: m.endTime,
            label: `${m.speed?.multiplier ?? 2}× muted`,
          })),
        total
      ),
    [moments, total]
  );

  const removedSeconds = removed.reduce((acc, s) => acc + (s.end - s.start), 0);

  const seekFromEvent = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = rootRef.current;
      if (!el || total <= 0) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (e.clientX - rect.left) / rect.width;
      onSeek(Math.max(0, Math.min(total, ratio * total)));
    },
    [onSeek, total]
  );

  // Honest empty state — we never draw a waveform for audio we didn't measure.
  if (!wave) {
    return (
      <div className="absolute inset-0 flex items-center px-3 text-[11px] text-fog/55">
        {audioAnalysis?.status === "failed"
          ? "Audio analysis failed — no waveform for this recording"
          : audioAnalysis?.hasUsableSpeech === false
            ? "No speech detected — no waveform for this recording"
            : "No audio analysis for this recording"}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      onPointerDown={seekFromEvent}
      title={
        removedSeconds > 0
          ? `Audio — ${fmt(removedSeconds)} removed by cuts. Click to seek.`
          : "Audio — click to seek."
      }
      className="absolute inset-0 z-10 cursor-pointer overflow-hidden"
    >
      {/* 1 ── Waveform: the real measured loudness, mirrored around the centre. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0"
        style={{ width: `${wave.widthPct}%` }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ height, width: "100%", display: "block" }}
          aria-hidden
        >
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgba(125,211,252,0.30)" />
              <stop offset="50%" stopColor="rgba(125,211,252,0.14)" />
              <stop offset="100%" stopColor="rgba(125,211,252,0.30)" />
            </linearGradient>
          </defs>
          {/* Zero line — anchors the symmetry so quiet passages still read. */}
          <line
            x1={0}
            x2={W}
            y1={MID}
            y2={MID}
            stroke="rgba(255,255,255,0.10)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <path d={wave.topArea} fill={`url(#${gradId})`} />
          <path d={wave.bottomArea} fill={`url(#${gradId})`} />
          <path
            d={wave.topLine}
            fill="none"
            stroke="rgba(186,230,253,0.70)"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={wave.bottomLine}
            fill="none"
            stroke="rgba(186,230,253,0.45)"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {/* 2 ── Silence: subtle dark bands over the wave. */}
      {silences.map((s) => (
        <SpanBand key={s.id} span={s} total={total} kind="silence" />
      ))}

      {/* 3 ── Removed audio: every ACTIVE cut, hatched + struck through. This is
              the point of the lane — the audio these cuts delete. */}
      {removed.map((s) => (
        <SpanBand key={s.id} span={s} total={total} kind="removed" />
      ))}

      {/* 4 ── Muted: speed-ups whose audio mode is "mute". */}
      {muted.map((s) => (
        <SpanBand key={s.id} span={s} total={total} kind="muted" />
      ))}
    </div>
  );
}

/**
 * One overlay band. Percentage positioning (never px-per-second) so the parent's
 * zoom transform stays the single source of horizontal scale.
 */
function SpanBand({
  span,
  total,
  kind,
}: {
  span: Span;
  total: number;
  kind: "silence" | "removed" | "muted";
}) {
  const dur = span.end - span.start;
  const left = total > 0 ? (span.start / total) * 100 : 0;
  const widthPct = total > 0 ? (dur / total) * 100 : 0;
  // Same width heuristic as MomentPill: below ~54px there is no room for a label.
  const approxPx = (widthPct / 100) * APPROX_VIEWPORT_PX;
  const showLabel = approxPx >= 54;

  if (kind === "silence") {
    return (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 bg-black/45"
        style={{ left: `${left}%`, width: `${widthPct}%`, minWidth: 1 }}
        title={`Silence · ${dur.toFixed(1)}s`}
      >
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/10" />
      </div>
    );
  }

  if (kind === "removed") {
    return (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-[3px]"
        style={{ left: `${left}%`, width: `${widthPct}%`, minWidth: 2 }}
        title={`Removed by cut · ${dur.toFixed(1)}s of audio deleted`}
      >
        <div
          className="absolute inset-0 overflow-hidden rounded-[4px] border border-rose-400/40 bg-rose-950/55"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, rgba(178,99,112,0.28) 0 2px, transparent 2px 7px)",
          }}
        >
          {/* Strikethrough — the audio on this span does not survive export. */}
          <span className="absolute inset-x-0 top-1/2 h-[1.5px] -translate-y-1/2 bg-rose-300/80" />
          {showLabel && (
            <span className="absolute inset-y-0 left-1 flex items-center gap-1 whitespace-nowrap text-[9.5px] font-semibold uppercase tracking-wide text-rose-100/90">
              <Scissors size={9} strokeWidth={2.5} />
              Removed
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-[3px]"
      style={{ left: `${left}%`, width: `${widthPct}%`, minWidth: 2 }}
      title={`${span.label} · audio muted for ${dur.toFixed(1)}s`}
    >
      <div
        className={cn(
          "absolute inset-0 overflow-hidden rounded-[4px] border border-amber-300/35",
          "bg-ink/70 backdrop-blur-[1px]"
        )}
      >
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-amber-200/40" />
        <span className="absolute inset-y-0 left-1 flex items-center gap-1 whitespace-nowrap text-[9.5px] font-semibold uppercase tracking-wide text-amber-100/90">
          <VolumeX size={9} strokeWidth={2.5} />
          {showLabel && "Muted"}
        </span>
      </div>
    </div>
  );
}
