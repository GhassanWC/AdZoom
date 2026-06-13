/**
 * Speed / Pacing engine — deterministic, FREE, per-chunk.
 *
 * Answers "which parts are low-value and should move faster?" — boring, idle,
 * loading or waiting stretches. Reads the chunk window's per-second CV signals
 * (motion, delta, attention, density) and emits Speed sections over runs that
 * are clearly low-activity AND not near an important edit.
 *
 * Conservative + safe:
 *   - Auto multiplier capped at ≤ 2× (3–4× stays manual, since export is
 *     real-time playbackRate).
 *   - Never speeds within a buffer of a zoom/focus moment, scene change, or
 *     click; never speeds text-reading (high density with real frame delta)
 *     unless the frame is truly frozen (loading/idle).
 *   - Min 2s; output rides the same append / track / playbackRate-export path
 *     as a manual speed section.
 */
import type {
  DetectedMoment,
  ProjectDoc,
  SpeedSettings,
  VisualAnalysis,
} from "../firebase/schema";
import { dequantize, dequantizeArray } from "../cv/resample";
import type { ChunkWindow, EngineDiagnostics } from "./crop-engine";

export interface SpeedDiagnostics extends EngineDiagnostics {
  totalTimeSpedUpS: number;
  avgMultiplier: number;
}

const MIN_SPEED_S = 2;
const BUFFER_S = 1.0;
// Boring thresholds (all on dequantized 0..1 signals).
const MAX_MOTION = 0.06;
const MAX_DELTA = 0.05;
const MAX_ATTENTION = 0.35;
const TEXT_DENSITY = 0.55; // high density = text-heavy (reading) → not boring…
const IDLE_DELTA = 0.012; // …unless the frame is essentially frozen.

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function speedDiag(
  sections: DetectedMoment[],
  reasons: Record<string, number>
): SpeedDiagnostics {
  const n = sections.length;
  const dur = sections.reduce((a, s) => a + (s.endTime - s.startTime), 0);
  const conf = sections.reduce((a, s) => a + (s.confidenceScore ?? 0), 0);
  const mult = sections.reduce((a, s) => a + (s.speed?.multiplier ?? 1), 0);
  const rejected = Object.values(reasons).reduce((a, b) => a + b, 0);
  return {
    generated: n,
    rejected,
    reasons,
    avgDurationS: n ? dur / n : 0,
    avgConfidence: n ? conf / n : 0,
    totalTimeSpedUpS: dur,
    avgMultiplier: n ? mult / n : 0,
  };
}

/**
 * Generate speed sections for one chunk from its window-local `VisualAnalysis`.
 * `zoomMoments` (absolute times) carve protective buffers so important edits
 * are never sped up. `primaryEnd` clamps to the chunk's primary span.
 */
export function speedSectionsForChunk(
  va: VisualAnalysis,
  window: ChunkWindow,
  project: ProjectDoc,
  zoomMoments: DetectedMoment[],
  cutMoments: DetectedMoment[],
  primaryEnd: number
): { sections: DetectedMoment[]; diag: SpeedDiagnostics } {
  void project;
  const reasons: Record<string, number> = {};
  const reject = (r: string) => {
    reasons[r] = (reasons[r] ?? 0) + 1;
  };
  const sections: DetectedMoment[] = [];

  const n = va.motion?.length ?? 0;
  const rate = va.sampleRate || 1;
  const bucket = 1 / rate;
  if (n === 0) return { sections, diag: speedDiag(sections, reasons) };

  const attn = dequantizeArray(va.attentionCurve);

  // Block samples near important edits / scene changes / clicks.
  const blocked = new Array<boolean>(n).fill(false);
  const blockAround = (localT: number, half: number) => {
    const a = Math.max(0, Math.floor((localT - half) * rate));
    const b = Math.min(n, Math.ceil((localT + half) * rate));
    for (let i = a; i < b; i++) blocked[i] = true;
  };
  for (const ev of va.sceneChanges ?? []) blockAround(ev.t, BUFFER_S);
  for (const ev of va.clickEvents ?? []) blockAround(ev.t, BUFFER_S);
  for (const c of va.inferredClicks ?? []) blockAround(c.t, BUFFER_S);
  for (const z of zoomMoments) {
    const zs = z.startTime - window.startTime;
    const ze = z.endTime - window.startTime;
    blockAround((zs + ze) / 2, (ze - zs) / 2 + BUFFER_S);
  }
  // Cuts run first and claim the deadest ranges — block them so a section is
  // never both cut AND sped (the cut owns it).
  for (const c of cutMoments) {
    const cs = c.startTime - window.startTime;
    const ce = c.endTime - window.startTime;
    blockAround((cs + ce) / 2, (ce - cs) / 2);
  }

  const isBoring = (i: number): boolean => {
    if (blocked[i]) return false;
    const mo = dequantize(va.motion[i] ?? 0);
    const de = dequantize(va.delta[i] ?? 0);
    const at = attn[i] ?? 0;
    const den = dequantize(va.density[i] ?? 0);
    if (mo >= MAX_MOTION || at >= MAX_ATTENTION || de >= MAX_DELTA) return false;
    // Reading guard: dense text with real frame delta isn't boring.
    if (den >= TEXT_DENSITY && de >= IDLE_DELTA) return false;
    return true;
  };

  let i = 0;
  let k = 0;
  while (i < n) {
    if (!isBoring(i)) {
      i++;
      continue;
    }
    let j = i;
    let sumDelta = 0;
    while (j < n && isBoring(j)) {
      sumDelta += dequantize(va.delta[j] ?? 0);
      j++;
    }
    const runLen = j - i;
    const absStart = window.startTime + i * bucket;
    const absEnd = Math.min(window.startTime + j * bucket, primaryEnd);
    const dur = absEnd - absStart;
    if (dur >= MIN_SPEED_S) {
      const meanDelta = runLen ? sumDelta / runLen : 0;
      const idle = meanDelta < IDLE_DELTA * 1.5;
      const multiplier = idle || dur >= 5 ? 2 : 1.5; // capped ≤ 2× for auto
      const audioMode: SpeedSettings["audioMode"] = multiplier >= 2 ? "mute" : "keep";
      const confidence = clamp01(0.5 + 0.4 * Math.min(1, dur / 8));
      const speed: SpeedSettings = { multiplier, audioMode, transition: "cut" };
      sections.push({
        id: `j${window.index}spd${k}`,
        startTime: absStart,
        endTime: absEnd,
        label: `Speed ${multiplier}×`,
        reason: idle
          ? "Idle / loading stretch — sped up."
          : "Low-activity stretch — sped up.",
        focusRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
        effectType: "speed-up",
        speed,
        provenance: "cv",
        source: "ai",
        confidenceScore: confidence,
        attentionScore: clamp01(1 - confidence),
      } satisfies DetectedMoment);
      k++;
    } else {
      reject("too-short");
    }
    i = j;
  }

  return { sections, diag: speedDiag(sections, reasons) };
}
