/**
 * Continuous attention curve → discrete candidate moments.
 *
 * `findPeaks` locates local maxima in the smoothed attention curve. Peaks that
 * don't sit near an existing Gemini moment become CV-sourced candidate moments
 * that compete in the balancer's selection pool — most useful for rescuing a
 * quartile with real on-screen activity that Gemini missed.
 *
 * This whole path is gated behind a flag in the balancer (`useCvCandidates`)
 * so v1 can ship fusion-only and enable peak-rescue once tuned.
 */

import type { DetectedMoment, VisualAnalysis } from "../firebase/schema";
import { dequantize, dequantizeArray } from "./resample";
import {
  classifyCvEffect,
  FOCUS_INTENSITY_SCALE,
  type CvEffectType,
  type CvMomentSignal,
} from "./classify-effect";

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** UI-facing effect name (matches the timeline/inspector labels). */
function effectName(effectType: CvEffectType): string {
  return effectType === "cursor-focus" ? "Focus" : "Zoom";
}

/** A peak must exceed mean + K·std of the curve to count. */
const PEAK_K = 1;

/**
 * Indices of local maxima in `curve` that exceed the adaptive threshold and
 * respect `minSeparationSamples` between picks (highest-first).
 */
export function findPeaks(curve: number[], minSeparationSamples: number): number[] {
  const n = curve.length;
  if (n === 0) return [];

  const mean = curve.reduce((a, b) => a + b, 0) / n;
  const variance = curve.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const threshold = mean + PEAK_K * Math.sqrt(variance);

  // Collect every local maximum above threshold.
  const candidates: { idx: number; v: number }[] = [];
  for (let i = 0; i < n; i++) {
    const v = curve[i];
    if (v < threshold) continue;
    const leftOk = i === 0 || curve[i - 1] <= v;
    const rightOk = i === n - 1 || curve[i + 1] <= v;
    if (leftOk && rightOk) candidates.push({ idx: i, v });
  }

  // Greedily keep the strongest, enforcing minimum separation.
  candidates.sort((a, b) => b.v - a.v);
  const kept: number[] = [];
  const sep = Math.max(1, Math.round(minSeparationSamples));
  for (const c of candidates) {
    if (kept.every((k) => Math.abs(k - c.idx) >= sep)) kept.push(c.idx);
  }
  return kept.sort((a, b) => a - b);
}

/**
 * Build CV-sourced candidate moments from the attention-curve peaks.
 * `minSpacing` is the balancer's pacing min-spacing in seconds.
 */
export function cvCandidateMoments(
  va: VisualAnalysis,
  duration: number,
  minSpacing: number
): DetectedMoment[] {
  const curve = dequantizeArray(va.attentionCurve);
  if (curve.length === 0) return [];

  const minSepSamples = minSpacing * va.sampleRate;
  const peaks = findPeaks(curve, minSepSamples);
  const bucketLen = 1 / va.sampleRate;

  return peaks.map((idx, i) => {
    const t = Math.min(duration - 0.5, (idx + 0.5) * bucketLen);
    const startTime = Math.max(0, t - 0.3);
    const endTime = Math.min(duration, startTime + 1.6);

    const cx = dequantize(va.centroidX[idx] ?? 128);
    const cy = dequantize(va.centroidY[idx] ?? 128);
    const score = curve[idx];

    // A focus box centered on the motion hotspot, clamped inside the frame.
    const w = 0.42;
    const h = 0.42;
    const x = Math.max(0, Math.min(1 - w, cx - w / 2));
    const y = Math.max(0, Math.min(1 - h, cy - h / 2));

    // No grounded click here — classify zoom vs focus from motion/attention so
    // the backstop adds variety instead of always punching in.
    const motionStrength = dequantize(va.motion[idx] ?? 0);
    const signal: CvMomentSignal = {
      hasInferredClick: false,
      uiChangeStrength: 0,
      cursorConfidence: dequantize(va.cursorConf?.[idx] ?? 0),
      regionArea: w * h,
      motionStrength,
      attentionScore: score,
      sceneChangeNearby: (va.sceneChanges ?? []).some(
        (e) => Math.abs(e.t - t) <= 0.5
      ),
    };
    const { effectType, why } = classifyCvEffect(signal);
    const recommendedIntensity =
      effectType === "cursor-focus"
        ? clamp01(score * FOCUS_INTENSITY_SCALE)
        : score;

    return {
      id: `cv${i + 1}`,
      startTime,
      endTime,
      label: `${effectName(effectType)} · activity peak`,
      reason: "Motion/visual activity peak detected on-device (CV).",
      focusRegion: { x, y, width: w, height: h },
      effectType,
      whyEffectType: why,
      attentionScore: score,
      attentionFactors: {
        changeMagnitude: dequantize(va.delta[idx] ?? 0),
        motionIntensity: motionStrength,
        semanticWeight: 0, // no Gemini input — purely CV-sourced
        viewerConfusionRisk: 0.5,
      },
      sceneChange: false,
      recommendedIntensity,
    } satisfies DetectedMoment;
  });
}
