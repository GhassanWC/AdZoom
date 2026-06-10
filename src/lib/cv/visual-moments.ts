/**
 * Visual editing moments — the deterministic, FREE, no-events moment generator.
 *
 * Primary source = `inferredClicks` (cursor dwell → localized UI change). Each is
 * tagged `targetRegionSource: "cv-inferred-click"` so the balancer's reject pass
 * keeps it (it's a grounded target, not a generic box). Secondary backstop = the
 * attention-curve peaks (`cvCandidateMoments`) so quartiles with real on-screen
 * activity but no detected click still get coverage.
 *
 * Each moment's `effectType` is chosen by `classifyCvEffect` (zoom / click /
 * focus) from the visual signal instead of always being "zoom" — see
 * `classify-effect.ts`. A light variety cap then keeps zoom from dominating.
 *
 * Every moment carries a deterministic `label`/`reason` so FREE uploads read
 * well even though Gemini labeling is a paid feature.
 */

import type { DetectedMoment, VisualAnalysis } from "../firebase/schema";
import { cvCandidateMoments } from "./peaks";
import { dequantize } from "./resample";
import {
  classifyCvEffect,
  FOCUS_INTENSITY_SCALE,
  MAX_ZOOM_SHARE,
  type CvEffectType,
  type CvMomentSignal,
} from "./classify-effect";

const MOMENT_LEN = 1.6;
const PRE_ROLL = 0.3;
/** A scene cut within this many seconds counts as "nearby" for classification. */
const SCENE_NEAR_S = 0.5;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Deterministic position word ("center", "top-left", …) for readable labels. */
function positionWhere(region: { x: number; y: number; w: number; h: number }): string {
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  const col = cx < 0.34 ? "left" : cx > 0.66 ? "right" : "center";
  const row = cy < 0.34 ? "top" : cy > 0.66 ? "bottom" : "middle";
  return row === "middle" && col === "center" ? "center" : `${row}-${col}`;
}

/** UI-facing effect name (matches the timeline/inspector labels). */
function effectName(effectType: CvEffectType): string {
  return effectType === "click-highlight"
    ? "Click"
    : effectType === "cursor-focus"
      ? "Focus"
      : "Zoom";
}

/**
 * Reclassify the weakest zooms to focus so no more than `MAX_ZOOM_SHARE` of the
 * CV moments stay "zoom". Mutates in place; only changes `effectType`/intensity —
 * never removes moments, so the total edit count is preserved.
 */
function capZoomShare(moments: DetectedMoment[]): void {
  const zooms = moments.filter((m) => m.effectType === "zoom");
  const maxZoom = Math.floor(moments.length * MAX_ZOOM_SHARE);
  if (zooms.length <= maxZoom) return;

  // Demote weakest-first (lowest confidence, then attention) so the strongest /
  // highest-confidence punch-ins remain zooms.
  const weakestFirst = [...zooms].sort(
    (a, b) =>
      (a.confidenceScore ?? a.attentionScore ?? 0) -
      (b.confidenceScore ?? b.attentionScore ?? 0)
  );
  const demoteCount = zooms.length - maxZoom;
  for (let i = 0; i < demoteCount; i++) {
    const m = weakestFirst[i];
    m.effectType = "cursor-focus";
    m.whyEffectType = "variety: demoted from zoom (>70% zoom cap)";
    m.label = `Focus · ${positionWhere({
      x: m.focusRegion.x,
      y: m.focusRegion.y,
      w: m.focusRegion.width,
      h: m.focusRegion.height,
    })}`;
    if (typeof m.recommendedIntensity === "number") {
      m.recommendedIntensity = clamp01(
        m.recommendedIntensity * FOCUS_INTENSITY_SCALE
      );
    }
  }
}

/**
 * Build deterministic CV moments. `minSpacing` is the balancer's pacing
 * spacing (seconds) — used to thin the peak backstop near inferred clicks.
 */
export function visualMomentsFromCv(
  va: VisualAnalysis,
  duration: number,
  minSpacing: number
): DetectedMoment[] {
  const out: DetectedMoment[] = [];
  const clicks = va.inferredClicks ?? [];
  const sampleRate = va.sampleRate || 1;

  /** Sample a per-second 8-bit array at time `t`, dequantized to 0..1. */
  const sampleAt = (arr: number[] | undefined, t: number): number => {
    if (!arr || arr.length === 0) return 0;
    const idx = Math.max(0, Math.min(arr.length - 1, Math.round(t * sampleRate)));
    return dequantize(arr[idx] ?? 0);
  };
  const sceneNear = (t: number): boolean =>
    (va.sceneChanges ?? []).some((e) => Math.abs(e.t - t) <= SCENE_NEAR_S);

  // 1. Primary — UI-change-grounded clicks → classified camera effect.
  clicks.forEach((c, i) => {
    const startTime = Math.max(0, c.t - PRE_ROLL);
    const endTime = Math.min(duration, startTime + MOMENT_LEN);
    const score = clamp01(0.55 + 0.4 * c.strength);

    const signal: CvMomentSignal = {
      hasInferredClick: true,
      uiChangeStrength: c.strength,
      cursorConfidence: sampleAt(va.cursorConf, c.t),
      regionArea: c.region.w * c.region.h,
      motionStrength: sampleAt(va.motion, c.t),
      attentionScore: Math.max(sampleAt(va.attentionCurve, c.t), score),
      sceneChangeNearby: sceneNear(c.t),
    };
    const { effectType, why } = classifyCvEffect(signal);

    // Focus guides gently — punch in less hard than a zoom/click.
    const baseIntensity = clamp01(0.5 + 0.4 * c.strength);
    const recommendedIntensity =
      effectType === "cursor-focus"
        ? clamp01(baseIntensity * FOCUS_INTENSITY_SCALE)
        : baseIntensity;

    out.push({
      id: `cvc${i + 1}`,
      startTime,
      endTime,
      label: `${effectName(effectType)} · ${positionWhere(c.region)}`,
      reason: "Cursor settled, then a UI change appeared here (visual click).",
      focusRegion: {
        x: c.region.x,
        y: c.region.y,
        width: c.region.w,
        height: c.region.h,
      },
      effectType,
      whyEffectType: why,
      provenance: "cv",
      source: "ai",
      attentionScore: score,
      recommendedIntensity,
      confidenceScore: clamp01(0.45 + 0.4 * c.strength),
      confidenceSource: "cv-click-heuristic",
      // Keep the grounded source regardless of effect type so the reject pass
      // keeps focus/click moments too (it keys keep-decisions off this).
      targetRegionSource: "cv-inferred-click",
      sourceSignals: ["cv-cursor-dwell", `cv-ui-change@${c.t.toFixed(1)}`],
      attentionFactors: {
        changeMagnitude: c.strength,
        motionIntensity: c.strength,
        semanticWeight: 0,
        viewerConfusionRisk: 0.4,
      },
      sceneChange: false,
    } satisfies DetectedMoment);
  });

  // 2. Backstop — attention-curve peaks for activity without a detected click.
  //    `cvCandidateMoments` classifies each peak (zoom vs focus) itself.
  const peaks = cvCandidateMoments(va, duration, minSpacing);
  for (const pm of peaks) {
    const tooClose = out.some(
      (m) => Math.abs(m.startTime - pm.startTime) < minSpacing
    );
    if (!tooClose) out.push(pm);
  }

  // 3. Variety — keep zoom from dominating the CV mix (reclassify, never drop).
  capZoomShare(out);

  out.sort((a, b) => a.startTime - b.startTime);
  return out;
}
