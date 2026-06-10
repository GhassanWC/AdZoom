/**
 * Deterministic CV effect-type classifier.
 *
 * The CV moment generators (`visual-moments.ts` inferred clicks + `peaks.ts`
 * attention-peak backstop) used to hard-code every moment to "zoom", which made
 * analyzed timelines monotonous. This classifier picks the best of three camera
 * effects from the visual signal so the timeline gets a mix:
 *
 *   • "click-highlight" (UI label "Click") — a grounded cursor click with a
 *     strong, localized UI change.
 *   • "zoom"                              — a strong action or a tight target
 *     that warrants a camera punch-in.
 *   • "cursor-focus" (UI label "Focus")   — calmer, sustained attention: guide
 *     the eye without an aggressive punch-in.
 *
 * Crop and Speed are NEVER emitted here — they are separate engines / manual
 * effects. Thresholds are named constants so they can be tuned against real
 * footage without touching the decision logic.
 */

import type { EffectType } from "../firebase/schema";

/** The only effect types the CV classifier may emit (never crop / speed-up). */
export type CvEffectType = Extract<
  EffectType,
  "zoom" | "click-highlight" | "cursor-focus"
>;

/**
 * Per-moment signal, assembled from an `InferredClick` (or peak) plus the
 * per-second `VisualAnalysis` arrays — all already dequantized to 0..1 — sampled
 * at the moment's time index.
 */
export interface CvMomentSignal {
  /** True for grounded inferred clicks; false for the attention-peak backstop. */
  hasInferredClick: boolean;
  /** 0..1 — UI-change magnitude × cursor-dwell quality (InferredClick.strength). */
  uiChangeStrength: number;
  /** 0..1 — cursor-estimate confidence at the moment (0 if no cursor track). */
  cursorConfidence: number;
  /** 0..1 — target region area (width × height). */
  regionArea: number;
  /** 0..1 — motion intensity at the moment. */
  motionStrength: number;
  /** 0..1 — fused attention score at the moment. */
  attentionScore: number;
  /** A scene cut sits within ±0.5s of the moment. */
  sceneChangeNearby: boolean;
}

// ── Tunable thresholds (tune against real footage; the logic below is stable) ──
/** Click: minimum UI-change strength for a grounded click to read as a click. */
export const CLICK_UI_STRENGTH = 0.5;
/** Click: maximum region AREA — clicks are localized, not page-scale. */
export const CLICK_MAX_AREA = 0.22;
/** Zoom: motion at/above this is a "strong action" → punch-in. */
export const ZOOM_MIN_MOTION = 0.5;
/** Zoom: UI-change strength at/above this is strong enough to punch in. */
export const ZOOM_MIN_STRENGTH = 0.7;
/** Zoom: attention at/above this is strong enough to punch in. */
export const ZOOM_MIN_ATTENTION = 0.8;
/** Zoom: a GROUNDED target this small (area) is tight enough to punch in. */
export const ZOOM_MAX_AREA = 0.12;
/** Focus moments punch in gently — scale their recommended intensity down. */
export const FOCUS_INTENSITY_SCALE = 0.6;
/** Variety cap: at most this share of CV moments may stay "zoom". */
export const MAX_ZOOM_SHARE = 0.7;

/**
 * Classify one CV moment into a camera effect. Pure + deterministic.
 * Order matters: click → zoom → focus (default), mirroring the product rules.
 */
export function classifyCvEffect(s: CvMomentSignal): {
  effectType: CvEffectType;
  why: string;
} {
  // 1. Click — a grounded cursor click with a strong, localized UI change.
  if (
    s.hasInferredClick &&
    s.uiChangeStrength >= CLICK_UI_STRENGTH &&
    s.regionArea <= CLICK_MAX_AREA
  ) {
    return {
      effectType: "click-highlight",
      why: "grounded click + strong localized UI change",
    };
  }

  // 2. Zoom — a strong action, or a tight grounded target → camera punch-in.
  const strongAction =
    s.motionStrength >= ZOOM_MIN_MOTION ||
    s.uiChangeStrength >= ZOOM_MIN_STRENGTH ||
    s.attentionScore >= ZOOM_MIN_ATTENTION;
  // Region size only counts for grounded clicks — the peak backstop's generic
  // box isn't a real "tight target".
  const tightTarget = s.hasInferredClick && s.regionArea <= ZOOM_MAX_AREA;
  if (strongAction || tightTarget) {
    return {
      effectType: "zoom",
      why: tightTarget
        ? "tight grounded target → punch-in"
        : "strong action (motion/UI/attention) → punch-in",
    };
  }

  // 3. Focus — sustained, calmer activity: guide the eye, don't punch in.
  return {
    effectType: "cursor-focus",
    why: "sustained/low-motion activity → gentle focus",
  };
}
