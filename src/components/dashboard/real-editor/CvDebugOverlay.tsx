"use client";

/**
 * CV debug overlay — dev-only visualization of the visual editing engine's
 * raw output, drawn over the video frame (inside the camera transform wrapper
 * so it stays aligned with the content). Shows: cursor-track dots, inferred
 * click markers, focus-region boxes, scene-change badge, and CV moment labels.
 *
 * Gated by the caller (?debug=1). Reporting-only — never mutates anything.
 */

import * as React from "react";
import { dequantize } from "@/lib/cv/resample";
import { usePlaybackTime } from "./playback-clock";
import type { DetectedMoment, VisualAnalysis } from "@/lib/firebase/schema";

const CURSOR_WINDOW_S = 2; // trail length around the playhead
const CLICK_WINDOW_S = 1.5; // show inferred clicks this close to the playhead
const SCENE_WINDOW_S = 0.6; // flash the scene badge this close to a cut

function pct(v: number): string {
  return `${Math.max(0, Math.min(100, v * 100))}%`;
}

export function CvDebugOverlay({
  visualAnalysis: va,
  moments,
}: {
  visualAnalysis: VisualAnalysis;
  moments: DetectedMoment[];
}) {
  // Subscribes to the clock itself — the player that hosts it must not.
  const currentTime = usePlaybackTime();
  const sampleRate = va.sampleRate || 1;

  // Cursor trail around the playhead.
  const cursorDots: Array<{ x: number; y: number; conf: number; head: boolean }> = [];
  if (va.cursorX && va.cursorY) {
    const headB = Math.max(
      0,
      Math.min(va.sampleCount - 1, Math.floor(currentTime * sampleRate))
    );
    const from = Math.max(0, headB - Math.round(CURSOR_WINDOW_S * sampleRate));
    for (let b = from; b <= headB; b++) {
      if (va.cursorX[b] === undefined) continue;
      cursorDots.push({
        x: dequantize(va.cursorX[b]),
        y: dequantize(va.cursorY[b] ?? 128),
        conf: dequantize(va.cursorConf?.[b] ?? 0),
        head: b === headB,
      });
    }
  }

  const clicks = (va.inferredClicks ?? []).filter(
    (c) => Math.abs(c.t - currentTime) <= CLICK_WINDOW_S
  );

  const cvMoments = moments.filter((m) => m.provenance === "cv");
  const sceneNear = (va.sceneChanges ?? []).some(
    (s) => Math.abs(s.t - currentTime) <= SCENE_WINDOW_S
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden font-mono">
      {/* Cursor track dots */}
      {cursorDots.map((d, i) => (
        <div
          key={`cur-${i}`}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: pct(d.x),
            top: pct(d.y),
            width: d.head ? 12 : 5,
            height: d.head ? 12 : 5,
            background: d.head ? "#22D3EE" : "rgba(34,211,238,0.45)",
            opacity: d.head ? 1 : 0.25 + 0.6 * d.conf,
            boxShadow: d.head ? "0 0 0 2px rgba(34,211,238,0.4)" : undefined,
          }}
        />
      ))}

      {/* Inferred click markers (changed-region center) */}
      {clicks.map((c, i) => {
        const cx = c.region.x + c.region.w / 2;
        const cy = c.region.y + c.region.h / 2;
        return (
          <div
            key={`clk-${i}`}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-rose-400"
            style={{
              left: pct(cx),
              top: pct(cy),
              width: 22,
              height: 22,
              boxShadow: "0 0 8px rgba(201,127,137,0.7)",
            }}
          />
        );
      })}

      {/* Focus-region boxes for CV moments (active bright, others faint) */}
      {cvMoments.map((m) => {
        const active = currentTime >= m.startTime && currentTime <= m.endTime;
        return (
          <div
            key={`box-${m.id}`}
            className="absolute border"
            style={{
              left: pct(m.focusRegion.x),
              top: pct(m.focusRegion.y),
              width: pct(m.focusRegion.width),
              height: pct(m.focusRegion.height),
              borderColor: active ? "#A78BFA" : "rgba(167,139,250,0.35)",
              borderWidth: active ? 2 : 1,
              background: active ? "rgba(167,139,250,0.08)" : "transparent",
            }}
          >
            {active && (
              <span className="absolute left-0 top-0 -translate-y-full whitespace-nowrap bg-violet-500/90 px-1 text-[9px] leading-tight text-white">
                {m.label} ·{" "}
                {(m.focusRegion.width * m.focusRegion.height).toFixed(2)}
                {m.targetRegionSource ? ` · ${m.targetRegionSource}` : ""}
              </span>
            )}
          </div>
        );
      })}

      {/* Scene-change badge */}
      {sceneNear && (
        <span className="absolute left-1/2 top-2 -translate-x-1/2 rounded bg-amber-500/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-black">
          ⛬ scene change
        </span>
      )}
    </div>
  );
}
