/**
 * CV debug report — a flat, read-only view of what the visual editing engine
 * produced for one project, assembled from the persisted `visualAnalysis` +
 * `analysis`. Powers the dev-only `[cv]` console log, the overlay, and the
 * "Download CV diagnostics" export. Pure; reporting-only; no algorithm changes.
 */

import { DETECT_W, DETECT_H } from "@/lib/cv/types";
import { dequantize } from "@/lib/cv/resample";
import type { FocusRegion, ProjectDoc } from "@/lib/firebase/schema";

/** The 0.42×0.42 generic box the old CV path emitted — we want to AVOID it. */
const GENERIC_BOX = 0.42;
const GENERIC_BOX_EPS = 0.02;

export interface CvDebugSummary {
  version: number | null;
  durationSec: number;
  detectResolution: string;
  cursorTrackFound: boolean;
  cursorConfidenceAvg: number;
  inferredClicksCount: number;
  dwellCount: number;
  cvMomentsEmitted: number;
  cvMomentsKept: number;
  rejectedCvMoments: number;
  avgFocusRegionSize: number;
  genericBoxCount: number;
  computeMs: number;
}

export interface CvDebugReport {
  summary: CvDebugSummary;
  cursorTrack: Array<{ t: number; x: number; y: number; conf: number }>;
  inferredClicks: Array<{
    t: number;
    strength: number;
    region: { x: number; y: number; w: number; h: number };
  }>;
  dwells: Array<{ t: number; x: number; y: number }>;
  sceneChanges: Array<{ t: number; strength: number }>;
  focusRegions: Array<{
    id: string;
    startTime: number;
    endTime: number;
    region: FocusRegion;
    provenance?: string;
    targetRegionSource?: string;
    label?: string;
  }>;
  rejected: Array<{ id: string; reason?: string; provenance?: string }>;
  visualAnalysisMeta: {
    version: number;
    sampleRate: number;
    sampleCount: number;
    computeMs: number;
    sceneChanges: number;
    uiRegions: number;
  };
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Build the report, or null when the project has no visual analysis yet. */
export function buildCvDebugReport(project: ProjectDoc): CvDebugReport | null {
  const va = project.visualAnalysis;
  if (!va) return null;
  const analysis = project.analysis;
  const sampleRate = va.sampleRate || 1;
  const durationSec = project.duration ?? va.sampleCount / sampleRate;

  // Cursor track ← per-second quantized arrays.
  const cx = va.cursorX ?? [];
  const cy = va.cursorY ?? [];
  const cc = va.cursorConf ?? [];
  const cursorTrack: CvDebugReport["cursorTrack"] = [];
  for (let b = 0; b < (va.sampleCount ?? 0); b++) {
    if (cx[b] === undefined) continue;
    cursorTrack.push({
      t: b / sampleRate,
      x: dequantize(cx[b]),
      y: dequantize(cy[b] ?? 128),
      conf: dequantize(cc[b] ?? 0),
    });
  }
  const cursorConfidenceAvg = avg(cursorTrack.map((p) => p.conf));
  const cursorTrackFound =
    analysis?.editDiagnostics?.cursorTrackFound ??
    cursorTrack.some((p) => p.conf > 0.4);

  const inferredClicks = (va.inferredClicks ?? []).map((c) => ({
    t: c.t,
    strength: c.strength,
    region: c.region,
  }));
  const dwells = (va.dwells ?? []).map((d) => ({ t: d.t, x: d.x, y: d.y }));
  const sceneChanges = (va.sceneChanges ?? []).map((s) => ({
    t: s.t,
    strength: s.strength,
  }));

  const detected = analysis?.detectedMoments ?? [];
  const cvMoments = detected.filter((m) => m.provenance === "cv");
  const focusRegions = detected.map((m) => ({
    id: m.id,
    startTime: m.startTime,
    endTime: m.endTime,
    region: m.focusRegion,
    provenance: m.provenance,
    targetRegionSource: m.targetRegionSource,
    label: m.label,
  }));

  const rejected = (analysis?.rejectedPool ?? [])
    .filter((m) => m.provenance === "cv")
    .map((m) => ({
      id: m.id,
      reason: m.rejectedReason,
      provenance: m.provenance,
    }));

  const avgFocusRegionSize = avg(
    cvMoments.map((m) => m.focusRegion.width * m.focusRegion.height)
  );
  const genericBoxCount = cvMoments.filter(
    (m) =>
      Math.abs(m.focusRegion.width - GENERIC_BOX) < GENERIC_BOX_EPS &&
      Math.abs(m.focusRegion.height - GENERIC_BOX) < GENERIC_BOX_EPS
  ).length;

  return {
    summary: {
      version: va.version ?? null,
      durationSec,
      detectResolution: `${DETECT_W}×${DETECT_H}`,
      cursorTrackFound,
      cursorConfidenceAvg,
      inferredClicksCount: inferredClicks.length,
      dwellCount: dwells.length,
      cvMomentsEmitted:
        analysis?.editDiagnostics?.cvMomentsEmitted ??
        cvMoments.length + rejected.length,
      cvMomentsKept: cvMoments.length,
      rejectedCvMoments: rejected.length,
      avgFocusRegionSize,
      genericBoxCount,
      computeMs: va.computeMs ?? 0,
    },
    cursorTrack,
    inferredClicks,
    dwells,
    sceneChanges,
    focusRegions,
    rejected,
    visualAnalysisMeta: {
      version: va.version,
      sampleRate,
      sampleCount: va.sampleCount,
      computeMs: va.computeMs ?? 0,
      sceneChanges: va.sceneChanges?.length ?? 0,
      uiRegions: va.uiRegions?.length ?? 0,
    },
  };
}
