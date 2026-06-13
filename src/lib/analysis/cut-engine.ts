/**
 * Cut engine — deterministic, FREE, per-chunk.
 *
 * Answers "which parts add NO value and should be removed?" — dead, idle,
 * loading-screen, long-pause, and dead-between-actions stretches. A sibling of
 * the Speed engine, but it claims the DEADEST runs (stricter thresholds), so the
 * value hierarchy is: very-low-value → Cut, some-value-but-slow → Speed. The
 * orchestrator runs cuts BEFORE speed and feeds the cut ranges to speed so the
 * two never overlap.
 *
 * Conservative by design (per product spec):
 *   - Never cuts within a buffer of a camera edit, scene change, or click.
 *   - Min 1.5s; a frozen/idle frame is required for the shortest runs.
 *   - Emits `effectType: "cut"` with `cut: { active: true }`; the user can
 *     review / restore (dim) / delete / adjust each range. NOTE: this iteration
 *     is timeline-only — cuts are suggestions and do NOT yet remove time from
 *     preview/export.
 */
import type {
  CutSettings,
  DetectedMoment,
  ProjectDoc,
  VisualAnalysis,
} from "../firebase/schema";
import { dequantize, dequantizeArray } from "../cv/resample";
import type { ChunkWindow, EngineDiagnostics } from "./crop-engine";

export interface CutDiagnostics extends EngineDiagnostics {
  totalRemovedS: number;
}

const MIN_CUT_S = 1.5;
const BUFFER_S = 1.5; // generous — never cut near important moments
// "Dead" thresholds — STRICTER than the speed engine's "boring" thresholds, so
// the deadest sections become cuts and merely-slow sections stay for speed.
const MAX_MOTION = 0.02;
const MAX_DELTA = 0.015;
const MAX_ATTENTION = 0.15;
const TEXT_DENSITY = 0.55; // dense text (reading) with real frame delta isn't dead…
const FROZEN_DELTA = 0.004; // …a frame this still is frozen (loading / idle).

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function cutDiag(
  sections: DetectedMoment[],
  reasons: Record<string, number>
): CutDiagnostics {
  const n = sections.length;
  const dur = sections.reduce((a, s) => a + (s.endTime - s.startTime), 0);
  const conf = sections.reduce((a, s) => a + (s.confidenceScore ?? 0), 0);
  const rejected = Object.values(reasons).reduce((a, b) => a + b, 0);
  return {
    generated: n,
    rejected,
    reasons,
    avgDurationS: n ? dur / n : 0,
    avgConfidence: n ? conf / n : 0,
    totalRemovedS: dur,
  };
}

/**
 * Generate cut sections for one chunk from its window-local `VisualAnalysis`.
 * `cameraMoments` (absolute times) carve protective buffers so important edits
 * are never cut. `primaryEnd` clamps to the chunk's primary span.
 */
export function cutSectionsForChunk(
  va: VisualAnalysis,
  window: ChunkWindow,
  project: ProjectDoc,
  cameraMoments: DetectedMoment[],
  primaryEnd: number
): { sections: DetectedMoment[]; diag: CutDiagnostics } {
  void project;
  const reasons: Record<string, number> = {};
  const reject = (r: string) => {
    reasons[r] = (reasons[r] ?? 0) + 1;
  };
  const sections: DetectedMoment[] = [];

  const n = va.motion?.length ?? 0;
  const rate = va.sampleRate || 1;
  const bucket = 1 / rate;
  if (n === 0) return { sections, diag: cutDiag(sections, reasons) };

  const attn = dequantizeArray(va.attentionCurve);

  // Block samples near important edits / scene changes / clicks — cuts never
  // land near a moment the viewer should see.
  const blocked = new Array<boolean>(n).fill(false);
  const blockAround = (localT: number, half: number) => {
    const a = Math.max(0, Math.floor((localT - half) * rate));
    const b = Math.min(n, Math.ceil((localT + half) * rate));
    for (let i = a; i < b; i++) blocked[i] = true;
  };
  for (const ev of va.sceneChanges ?? []) blockAround(ev.t, BUFFER_S);
  for (const ev of va.clickEvents ?? []) blockAround(ev.t, BUFFER_S);
  for (const c of va.inferredClicks ?? []) blockAround(c.t, BUFFER_S);
  for (const m of cameraMoments) {
    const ms = m.startTime - window.startTime;
    const me = m.endTime - window.startTime;
    blockAround((ms + me) / 2, (me - ms) / 2 + BUFFER_S);
  }

  const isDead = (i: number): boolean => {
    if (blocked[i]) return false;
    const mo = dequantize(va.motion[i] ?? 0);
    const de = dequantize(va.delta[i] ?? 0);
    const at = attn[i] ?? 0;
    const den = dequantize(va.density[i] ?? 0);
    if (mo >= MAX_MOTION || at >= MAX_ATTENTION || de >= MAX_DELTA) return false;
    // Reading guard: dense text with any real frame delta is not dead.
    if (den >= TEXT_DENSITY && de >= FROZEN_DELTA) return false;
    return true;
  };

  let i = 0;
  let k = 0;
  while (i < n) {
    if (!isDead(i)) {
      i++;
      continue;
    }
    let j = i;
    let sumDelta = 0;
    while (j < n && isDead(j)) {
      sumDelta += dequantize(va.delta[j] ?? 0);
      j++;
    }
    const runLen = j - i;
    const absStart = window.startTime + i * bucket;
    const absEnd = Math.min(window.startTime + j * bucket, primaryEnd);
    const dur = absEnd - absStart;
    if (dur >= MIN_CUT_S) {
      const meanDelta = runLen ? sumDelta / runLen : 0;
      const frozen = meanDelta < FROZEN_DELTA * 1.5; // loading / idle / frozen
      // Longer + deader runs are higher-confidence cut candidates.
      const confidence = clamp01(0.55 + 0.4 * Math.min(1, dur / 8));
      const cut: CutSettings = { active: true };
      sections.push({
        id: `j${window.index}cut${k}`,
        startTime: absStart,
        endTime: absEnd,
        label: "Cut",
        reason: frozen
          ? "Idle / loading screen — suggested cut."
          : "Dead section — suggested cut.",
        focusRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
        effectType: "cut",
        cut,
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

  // FUTURE: mistake detection (repeated retries, undo bursts) would emit
  // additional cut sections here once a signal is available.
  return { sections, diag: cutDiag(sections, reasons) };
}
