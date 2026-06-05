/**
 * Visual editing moments — the deterministic, FREE, no-events moment generator.
 *
 * Primary source = `inferredClicks` (cursor dwell → localized UI change): each
 * becomes a tightly-framed zoom on the CHANGED region, tagged
 * `targetRegionSource: "cv-inferred-click"` so the balancer's reject pass keeps
 * it (it's a grounded target, not a generic box). Secondary backstop = the
 * existing attention-curve peaks (`cvCandidateMoments`) so quartiles with real
 * on-screen activity but no detected click still get coverage.
 *
 * Every moment carries a deterministic `label`/`reason` so FREE uploads read
 * well even though Gemini labeling is a paid feature.
 */

import type { DetectedMoment, VisualAnalysis } from "../firebase/schema";
import { cvCandidateMoments } from "./peaks";

const MOMENT_LEN = 1.6;
const PRE_ROLL = 0.3;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Deterministic position label so free users get readable moment names. */
function positionLabel(region: { x: number; y: number; w: number; h: number }): string {
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  const col = cx < 0.34 ? "left" : cx > 0.66 ? "right" : "center";
  const row = cy < 0.34 ? "top" : cy > 0.66 ? "bottom" : "middle";
  const where = row === "middle" && col === "center" ? "center" : `${row}-${col}`;
  return `Click · ${where}`;
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

  // 1. Primary — UI-change-grounded clicks → tight zooms.
  clicks.forEach((c, i) => {
    const startTime = Math.max(0, c.t - PRE_ROLL);
    const endTime = Math.min(duration, startTime + MOMENT_LEN);
    const score = clamp01(0.55 + 0.4 * c.strength);
    out.push({
      id: `cvc${i + 1}`,
      startTime,
      endTime,
      label: positionLabel(c.region),
      reason: "Cursor settled, then a UI change appeared here (visual click).",
      focusRegion: {
        x: c.region.x,
        y: c.region.y,
        width: c.region.w,
        height: c.region.h,
      },
      effectType: "zoom",
      provenance: "cv",
      source: "ai",
      attentionScore: score,
      recommendedIntensity: clamp01(0.5 + 0.4 * c.strength),
      confidenceScore: clamp01(0.45 + 0.4 * c.strength),
      confidenceSource: "cv-click-heuristic",
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
  const peaks = cvCandidateMoments(va, duration, minSpacing);
  for (const pm of peaks) {
    const tooClose = out.some(
      (m) => Math.abs(m.startTime - pm.startTime) < minSpacing
    );
    if (!tooClose) out.push(pm);
  }

  out.sort((a, b) => a.startTime - b.startTime);
  return out;
}
