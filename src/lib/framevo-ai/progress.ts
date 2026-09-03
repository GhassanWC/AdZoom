/**
 * Framevo AI — Working-state progress math, extracted (not duplicated) from
 * the old processing overlay so the panel and the mini pill derive progress
 * from ONE formula. Step building/labels stay in `analysis-progress.ts`; this
 * only owns fraction + active-step + done-detection.
 */
import { ANALYSIS_STAGES } from "@/lib/analysis-stages";
import type { ProgressStep } from "@/lib/analysis-progress";
import type { AnalysisActivityEvent } from "@/lib/firebase/schema";

export interface ProgressFractionInput {
  status: string | undefined;
  /** 0..1 client CV progress, when the on-device scan is running. */
  cvProgress: number | null;
  elapsedMs: number;
  estimateSeconds: number | undefined;
}

/** The overlay's historical fraction: CV-real → estimate-based → stage-index. */
export function progressFraction(input: ProgressFractionInput): number {
  const stageIdx = Math.max(
    0,
    ANALYSIS_STAGES.findIndex((s) => s.id === input.status)
  );
  const scanning = input.status === "scanning_frames" && input.cvProgress !== null;
  if (scanning) return Math.max(0.02, Math.min(0.99, input.cvProgress ?? 0));
  if (input.estimateSeconds && input.estimateSeconds > 0) {
    return Math.min(0.97, input.elapsedMs / (input.estimateSeconds * 1000));
  }
  return (stageIdx + 1) / ANALYSIS_STAGES.length;
}

export function activeStepIndex(pct: number, steps: ProgressStep[]): number {
  return Math.min(steps.length - 1, Math.max(0, Math.floor(pct * steps.length)));
}

export interface DoneDetectionInput {
  analysisStatus: string | undefined;
  chunkedJobStatus: string | undefined;
  chunkedJobComplete: boolean;
  momentsPresent: boolean;
  activity: AnalysisActivityEvent[] | undefined;
}

/**
 * The overlay's completion detection, verbatim: terminal analysis status, a
 * complete chunked job, or the explicit safety fallback (all chunks done +
 * moments present + an "Analysis complete" activity line). This is what
 * unsticks the surface when `project.status` lags or desyncs.
 */
export function detectRunDone(input: DoneDetectionInput): boolean {
  const lastActivityComplete = (input.activity ?? []).some((a) =>
    a.text?.includes("Analysis complete")
  );
  return (
    input.analysisStatus === "complete" ||
    input.chunkedJobStatus === "complete" ||
    (input.chunkedJobComplete && input.momentsPresent && lastActivityComplete)
  );
}
