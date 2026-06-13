import type {
  InferredClick,
  UIRegion,
  VisualAnalysis,
  VisualDwell,
  VisualEvent,
} from "../firebase/schema";
import { CHUNK_SIZE_S } from "../analysis/chunk-config";
import { sampleRateFor } from "./resample";

/**
 * Stitch the per-chunk WINDOW-LOCAL `VisualAnalysis` outputs back into one
 * whole-video `VisualAnalysis`, identical in shape to the direct flow's output
 * (so the editor's CV overlay + the balancer's CV fusion read it unchanged).
 *
 * Ownership rule (dedupe): chunks overlap by `CHUNK_OVERLAP_S`, so each global
 * second / event is written by exactly ONE chunk — the chunk whose *primary*
 * `[startTime, startTime+CHUNK_SIZE_S)` span owns it. The overlap tail is left
 * to the next chunk. This removes boundary double-counts without averaging.
 *
 * Signals: `motion`/`delta`/`density`/`centroid*`/`cursor*` are quantized
 * *absolute* values, so copying them into their global bucket is exact. Only
 * `attentionCurve` is per-chunk peak-normalized — a documented minor caveat;
 * downstream selection reads motion/delta/density, not the curve.
 */
export interface VaChunk {
  startTime: number;
  va: VisualAnalysis;
}

export function mergeVisualAnalysis(
  chunks: VaChunk[],
  duration: number,
  chunkSize: number = CHUNK_SIZE_S
): VisualAnalysis {
  const sorted = [...chunks].sort((a, b) => a.startTime - b.startTime);
  const sampleRate = sorted[0]?.va.sampleRate ?? sampleRateFor(duration);
  const sampleCount = Math.max(1, Math.ceil(duration * sampleRate));

  const motion = new Array<number>(sampleCount).fill(0);
  const delta = new Array<number>(sampleCount).fill(0);
  const density = new Array<number>(sampleCount).fill(0);
  const centroidX = new Array<number>(sampleCount).fill(0);
  const centroidY = new Array<number>(sampleCount).fill(0);
  const attentionCurve = new Array<number>(sampleCount).fill(0);
  const cursorX = new Array<number>(sampleCount).fill(0);
  const cursorY = new Array<number>(sampleCount).fill(0);
  const cursorConf = new Array<number>(sampleCount).fill(0);
  let hasCursors = false;

  const sceneChanges: VisualEvent[] = [];
  const clickEvents: VisualEvent[] = [];
  const inferredClicks: InferredClick[] = [];
  const dwells: VisualDwell[] = [];
  const uiRegions: UIRegion[] = [];
  let computeMs = 0;
  let version: VisualAnalysis["version"] = 1;

  for (const { startTime, va } of sorted) {
    computeMs += va.computeMs ?? 0;
    if (va.version === 3) version = 3;
    const baseBucket = Math.round(startTime * sampleRate);
    const primaryEnd = Math.min(duration, startTime + chunkSize);
    const owns = (localT: number) => localT + startTime < primaryEnd + 1e-6;

    for (let b = 0; b < va.sampleCount; b++) {
      const g = baseBucket + b;
      if (g < 0 || g >= sampleCount) continue;
      if (!owns(b / sampleRate)) continue; // overlap tail → next chunk owns it
      motion[g] = va.motion[b] ?? 0;
      delta[g] = va.delta[b] ?? 0;
      density[g] = va.density[b] ?? 0;
      centroidX[g] = va.centroidX[b] ?? 0;
      centroidY[g] = va.centroidY[b] ?? 0;
      attentionCurve[g] = va.attentionCurve[b] ?? 0;
      if (va.cursorX && va.cursorY && va.cursorConf) {
        hasCursors = true;
        cursorX[g] = va.cursorX[b] ?? 0;
        cursorY[g] = va.cursorY[b] ?? 0;
        cursorConf[g] = va.cursorConf[b] ?? 0;
      }
    }

    for (const e of va.sceneChanges)
      if (owns(e.t)) sceneChanges.push({ ...e, t: e.t + startTime });
    for (const e of va.clickEvents)
      if (owns(e.t)) clickEvents.push({ ...e, t: e.t + startTime });
    for (const c of va.inferredClicks ?? [])
      if (owns(c.t)) inferredClicks.push({ ...c, t: c.t + startTime });
    for (const d of va.dwells ?? [])
      if (owns(d.t)) dwells.push({ ...d, t: d.t + startTime });
    for (const r of va.uiRegions ?? [])
      if (owns(r.t0))
        uiRegions.push({ ...r, t0: r.t0 + startTime, t1: r.t1 + startTime });
  }

  sceneChanges.sort((a, b) => a.t - b.t);
  clickEvents.sort((a, b) => a.t - b.t);
  inferredClicks.sort((a, b) => a.t - b.t);

  const merged: VisualAnalysis = {
    version,
    sampleRate,
    sampleCount,
    motion,
    delta,
    density,
    centroidX,
    centroidY,
    sceneChanges,
    clickEvents,
    attentionCurve,
    computeMs: Math.round(computeMs),
  };
  if (hasCursors) {
    merged.cursorX = cursorX;
    merged.cursorY = cursorY;
    merged.cursorConf = cursorConf;
  }
  if (inferredClicks.length > 0) merged.inferredClicks = inferredClicks;
  if (dwells.length > 0) merged.dwells = dwells;
  if (uiRegions.length > 0) merged.uiRegions = uiRegions;
  return merged;
}
