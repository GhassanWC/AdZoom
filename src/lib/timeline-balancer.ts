/**
 * Attention-aware timeline balancer.
 *
 * Turns Gemini's raw output into a well-paced editing rhythm using
 * deterministic post-processing.
 *
 * Layers (in order):
 *   1. Contextual effect rewriting — uiContext + sceneChange override poor
 *      effectType picks (e.g. zoom on scroll → speed-up, zoom on code → cursor-focus).
 *   2. Attention-aware selection — moments are scored by attentionScore minus
 *      a rhythm penalty (recently-kept effectType, intensity bucket, spatial
 *      proximity). Highest scores win, with min spacing + zoom cooldown.
 *   3. Quartile coverage rescue — empty quartiles get the best candidate inside.
 *   4. Adaptive intensity — every kept moment carries `intensity` derived from
 *      Gemini's recommendedIntensity, narrative role, and uiContext.
 *
 * The video type (when known) tunes the pacing profile — e.g. coding-tutorial
 * shifts toward more cursor-focus and lower zoom density.
 */

import type {
  DetectedMoment,
  EffectType,
  Pacing,
  UIContext,
  VideoType,
  VisualAnalysis,
} from "./firebase/schema";
import { sampleCvForMoment, fuseAttention, nearestClickEvent } from "./cv/fusion";
import { cvCandidateMoments } from "./cv/peaks";

export interface PacingProfile {
  /** Target moments per minute. */
  ratePerMin: number;
  /** Minimum seconds between adjacent kept moments. */
  minSpacing: number;
  /** Hard cap on moments per minute (anti-spam). */
  maxPerMin: number;
  /** Lower bound — try to ensure at least this many moments per minute. */
  minPerMin: number;
  /** Cool-down (seconds) before another "zoom" effect can follow another "zoom". */
  zoomCooldown: number;
}

export const PACING_PROFILES: Record<Pacing, PacingProfile> = {
  slow: {
    ratePerMin: 3,
    minSpacing: 14,
    maxPerMin: 4,
    minPerMin: 1,
    zoomCooldown: 18,
  },
  moderate: {
    ratePerMin: 5,
    minSpacing: 7,
    maxPerMin: 7,
    minPerMin: 2,
    zoomCooldown: 10,
  },
  fast: {
    ratePerMin: 9,
    minSpacing: 4,
    maxPerMin: 12,
    minPerMin: 4,
    zoomCooldown: 6,
  },
};

/**
 * Video-type bias modifiers — applied on top of the pacing profile so a coding
 * tutorial with "fast" pacing is still calmer than a TikTok with "fast" pacing.
 */
const VIDEO_TYPE_BIAS: Record<VideoType, { rateMult: number; spacingMult: number }> = {
  "coding-tutorial": { rateMult: 0.85, spacingMult: 1.15 },
  "saas-demo": { rateMult: 1.0, spacingMult: 1.0 },
  "talking-tutorial": { rateMult: 0.75, spacingMult: 1.25 },
  presentation: { rateMult: 0.8, spacingMult: 1.2 },
  "vertical-short": { rateMult: 1.25, spacingMult: 0.8 },
  "onboarding-flow": { rateMult: 0.95, spacingMult: 1.05 },
  mixed: { rateMult: 1.0, spacingMult: 1.0 },
};

export interface BalancerInput {
  raw: DetectedMoment[];
  duration: number;
  pacing: Pacing;
  /** Hint from the analysis (or last-known) — biases pacing/effect choices. */
  videoType?: VideoType;
  /**
   * Moments the user already edited. Always preserved. They count toward
   * density but bypass the spacing/cooldown filter.
   */
  preserved?: DetectedMoment[];
  /**
   * Client-side CV pass output. When present, every raw moment's attention
   * score and `attentionFactors` are fused with measured frame signals before
   * selection (see `fuseMomentsWithCv`).
   */
  visualAnalysis?: VisualAnalysis;
  /**
   * When true, CV attention-curve peaks that don't sit near a Gemini moment
   * are added to the candidate pool. Gated so v1 can ship fusion-only.
   */
  useCvCandidates?: boolean;
}

export interface BalancerResult {
  moments: DetectedMoment[];
  /** Diagnostics for the timeline UI to render coverage warnings. */
  stats: {
    inputCount: number;
    keptCount: number;
    duration: number;
    quartileCoverage: [boolean, boolean, boolean, boolean];
    densityPerMin: number;
    pacing: Pacing;
    videoType?: VideoType;
    droppedTooClose: number;
    droppedTooDense: number;
    droppedTooManyZooms: number;
    rewrittenEffects: number;
    rhythmPenalized: number;
    /** Average attentionScore of the kept moments. */
    avgAttention: number;
    /** Raw moments whose attention score was fused with CV signals. */
    fusedCount: number;
    /** Moments whose start time was nudged onto a detected click event. */
    clickRefinedCount: number;
    /** CV attention-curve peaks added to the candidate pool. */
    cvCandidatesAdded: number;
  };
}

const MIN_MOMENTS = 3;
const MAX_MOMENTS = 24;

/** ── 1. CONTEXTUAL EFFECT REWRITING ──────────────────────────────────────
 *
 * Even if Gemini chose an effectType, override it when uiContext disagrees.
 * e.g. a "zoom" on a scroll moment should be cursor-focus or speed-up.
 */
function rewriteEffectByContext(m: DetectedMoment): {
  effectType: EffectType;
  rewritten: boolean;
} {
  const ctx = m.uiContext;
  if (!ctx) return { effectType: m.effectType, rewritten: false };

  const original = m.effectType;
  let next: EffectType = original;

  switch (ctx) {
    case "code":
      // Code activity rarely deserves a hard zoom — prefer cursor-focus.
      if (original === "zoom" && (m.attentionScore ?? 0.5) < 0.75) {
        next = "cursor-focus";
      }
      break;
    case "scroll":
      // Scrolling never deserves zoom — speed-up if low attention, else cursor-focus.
      if (original === "zoom" || original === "click-highlight") {
        next = (m.attentionScore ?? 0.5) < 0.4 ? "speed-up" : "cursor-focus";
      }
      break;
    case "modal":
    case "dialog":
    case "result":
      // Reveals should always be zooms (or click-highlight if already that).
      if (original === "cursor-focus" || original === "speed-up") {
        next = "zoom";
      }
      break;
    case "form":
      // Form fields prefer gentle cursor-focus over hard zoom (unless reveal).
      if (original === "zoom" && (m.attentionScore ?? 0.5) < 0.6) {
        next = "cursor-focus";
      }
      break;
    case "navigation":
      // Navigation = scene change = zoom.
      if (m.sceneChange && original !== "click-highlight") next = "zoom";
      break;
    default:
      break;
  }

  return { effectType: next, rewritten: next !== original };
}

/** ── 2. ADAPTIVE INTENSITY ──────────────────────────────────────────────
 *
 * Blend Gemini's per-moment intensity with narrative-role + uiContext biases.
 * The result is what the editor reads to do its zoom transform.
 */
function computeIntensity(m: DetectedMoment): number {
  // Start from Gemini's recommendation, fall back to attentionScore.
  let base =
    typeof m.recommendedIntensity === "number"
      ? m.recommendedIntensity
      : (m.attentionScore ?? m.importance ?? 0.5);

  // Narrative-role adjustment.
  switch (m.narrativeRole) {
    case "intro":
    case "explanation":
      base *= 0.8;
      break;
    case "action":
      base *= 1.0;
      break;
    case "result":
      base = Math.max(base, 0.8);
      break;
    case "filler":
      base *= 0.5;
      break;
    case "setup":
    case "transition":
    default:
      break;
  }

  // UI-context cap — small clickable UI shouldn't get cinematic intensity.
  switch (m.uiContext) {
    case "button":
      base = Math.min(base, 0.7);
      break;
    case "form":
      base = Math.min(base, 0.65);
      break;
    case "code":
      base = Math.min(base, 0.55);
      break;
    case "scroll":
      base = Math.min(base, 0.4);
      break;
    case "modal":
    case "dialog":
    case "result":
      base = Math.max(base, 0.7);
      break;
    default:
      break;
  }

  // Scene changes get a small boost — they're the moments worth emphasizing.
  if (m.sceneChange) base = Math.min(1, base + 0.08);

  return clamp(base, 0.15, 1);
}

/** ── 3. RHYTHM MEMORY PENALTY ────────────────────────────────────────────
 *
 * When considering a candidate, downrank it if recently-kept moments share its
 * effectType, intensity bucket, or focus position. This prevents 5 zooms in a
 * row, identical intensities, or repeated focal regions.
 */
function rhythmPenalty(
  candidate: DetectedMoment,
  kept: DetectedMoment[],
  candidateEffect: EffectType,
  candidateIntensity: number
): number {
  const lastFew = kept.slice(-3); // remember the last 3 kept moments
  if (lastFew.length === 0) return 0;

  let penalty = 0;
  let sameTypeStreak = 0;
  for (let i = lastFew.length - 1; i >= 0; i--) {
    if (lastFew[i].effectType === candidateEffect) sameTypeStreak++;
    else break;
  }
  // Two in a row of the same effect: small penalty. Three in a row: bigger.
  if (sameTypeStreak === 1) penalty += 0.08;
  if (sameTypeStreak === 2) penalty += 0.18;
  if (sameTypeStreak >= 3) penalty += 0.35;

  const prev = kept[kept.length - 1];
  if (prev) {
    // Intensity bucket clash (within 0.1 = "identical").
    const prevIntensity = prev.intensity ?? 0.5;
    if (Math.abs(prevIntensity - candidateIntensity) < 0.1) penalty += 0.05;

    // Spatial closeness — focus regions overlapping centers feel repetitive.
    const dx =
      candidate.focusRegion.x + candidate.focusRegion.width / 2 -
      (prev.focusRegion.x + prev.focusRegion.width / 2);
    const dy =
      candidate.focusRegion.y + candidate.focusRegion.height / 2 -
      (prev.focusRegion.y + prev.focusRegion.height / 2);
    const dist = Math.hypot(dx, dy);
    if (dist < 0.1) penalty += 0.06;
  }

  return penalty;
}

/** ── 0. CV FUSION PRE-LAYER ──────────────────────────────────────────────
 *
 * Before any selection happens, fuse each raw moment's attention score and
 * `attentionFactors` with the measured CV signals. Gemini stays the anchor;
 * CV corroborates, corrects, refines click timing, and re-centres focus
 * regions onto stable motion hotspots.
 */
interface FusionResult {
  moments: DetectedMoment[];
  fusedCount: number;
  clickRefinedCount: number;
}

function fuseMomentsWithCv(
  raw: DetectedMoment[],
  va: VisualAnalysis,
  duration: number
): FusionResult {
  const sorted = [...raw].sort((a, b) => a.startTime - b.startTime);
  let clickRefinedCount = 0;

  const moments = sorted.map((m, i) => {
    const cv = sampleCvForMoment(va, m.startTime, m.endTime);
    const geminiScore = m.attentionScore ?? m.importance ?? 0.5;

    const next: DetectedMoment = {
      ...m,
      attentionScore: fuseAttention(geminiScore, cv),
      attentionFactors: {
        changeMagnitude: cv.cvDelta,
        motionIntensity: cv.cvMotion,
        semanticWeight: geminiScore,
        viewerConfusionRisk: m.attentionFactors?.viewerConfusionRisk ?? 0.5,
      },
      sceneChange: Boolean(m.sceneChange) || cv.cvScene > 0.6,
    };

    // Click-timing refinement — nudge interaction moments onto a detected
    // click event, clamped to ±0.4 s and never crossing a neighbour.
    if (next.effectType === "click-highlight" || next.effectType === "cursor-focus") {
      const ev = nearestClickEvent(va, next.startTime, 1.2);
      if (ev) {
        const lowerBound = i > 0 ? sorted[i - 1].endTime : 0;
        const upperBound = i < sorted.length - 1 ? sorted[i + 1].startTime : duration;
        const nudge = clamp(ev.t - next.startTime, -0.4, 0.4);
        const dur = next.endTime - next.startTime;
        const ns = clamp(next.startTime + nudge, lowerBound, upperBound - dur);
        if (Number.isFinite(ns) && Math.abs(ns - next.startTime) > 0.001) {
          next.startTime = ns;
          next.endTime = ns + dur;
          clickRefinedCount++;
        }
      }
    }

    // Focus-region refinement — a stable hotspot far from Gemini's box pulls
    // the focus centre 40 % of the way toward the measured centroid.
    if (cv.centroid && cv.centroid.variance < 0.02) {
      const gx = next.focusRegion.x + next.focusRegion.width / 2;
      const gy = next.focusRegion.y + next.focusRegion.height / 2;
      const dist = Math.hypot(cv.centroid.x - gx, cv.centroid.y - gy);
      if (dist > 0.25) {
        const w = next.focusRegion.width;
        const h = next.focusRegion.height;
        const nx = gx + (cv.centroid.x - gx) * 0.4;
        const ny = gy + (cv.centroid.y - gy) * 0.4;
        next.focusRegion = {
          x: clamp(nx - w / 2, 0, Math.max(0, 1 - w)),
          y: clamp(ny - h / 2, 0, Math.max(0, 1 - h)),
          width: w,
          height: h,
        };
      }
    }

    return next;
  });

  return { moments, fusedCount: moments.length, clickRefinedCount };
}

/** Main entry. See file header for the layering. */
export function balanceTimeline(input: BalancerInput): BalancerResult {
  const { raw, duration, pacing, videoType, visualAnalysis } = input;
  const profile = PACING_PROFILES[pacing] ?? PACING_PROFILES.moderate;
  const bias = VIDEO_TYPE_BIAS[videoType ?? "mixed"];

  const ratePerMin = profile.ratePerMin * bias.rateMult;
  const minSpacing = profile.minSpacing * bias.spacingMult;
  const minPerMin = profile.minPerMin * Math.max(0.6, bias.rateMult);
  const maxPerMin = profile.maxPerMin * Math.min(1.4, bias.rateMult);
  const zoomCooldown = profile.zoomCooldown * bias.spacingMult;

  // ── 0. CV fusion + optional peak-rescue candidates ──────────────────────
  let fusedCount = 0;
  let clickRefinedCount = 0;
  let cvCandidatesAdded = 0;
  let effectiveRaw = raw;
  if (visualAnalysis && visualAnalysis.sampleCount > 0) {
    const fusion = fuseMomentsWithCv(raw, visualAnalysis, duration);
    fusedCount = fusion.fusedCount;
    clickRefinedCount = fusion.clickRefinedCount;
    effectiveRaw = fusion.moments;

    if (input.useCvCandidates) {
      const candidates = cvCandidateMoments(visualAnalysis, duration, minSpacing);
      const fresh = candidates.filter(
        (c) =>
          !effectiveRaw.some(
            (m) => Math.abs(m.startTime - c.startTime) < minSpacing / 2
          )
      );
      cvCandidatesAdded = fresh.length;
      effectiveRaw = [...effectiveRaw, ...fresh];
    }
  }

  const preserved = input.preserved ?? [];
  const preservedIds = new Set(preserved.map((m) => m.id));

  // Stats counters
  let droppedTooClose = 0;
  let droppedTooManyZooms = 0;
  let droppedTooDense = 0;
  let rewrittenEffects = 0;
  let rhythmPenalized = 0;

  // Pre-process candidates: rewrite effect by context, compute intensity, normalize times.
  const annotated = effectiveRaw
    .filter((m) => !preservedIds.has(m.id) && Number.isFinite(m.startTime))
    .map((m) => normalize(m, duration))
    .map((m) => {
      const { effectType, rewritten } = rewriteEffectByContext(m);
      if (rewritten) rewrittenEffects++;
      const intensity = computeIntensity({ ...m, effectType });
      return { ...m, effectType, intensity };
    });

  // Target count: bounded by pacing rate and duration.
  const minutes = Math.max(duration / 60, 0.5);
  const targetCount = clamp(
    Math.round(minutes * ratePerMin),
    Math.max(MIN_MOMENTS, Math.ceil(minutes * minPerMin)),
    Math.min(MAX_MOMENTS, Math.ceil(minutes * maxPerMin))
  );

  // 4 quartile buckets
  const QUARTILES = 4;
  const quartileLen = duration / QUARTILES;
  const quartileCounts = new Array(QUARTILES).fill(0);

  const kept: DetectedMoment[] = [...preserved];
  for (const m of preserved) {
    const q = whichQuartile(m.startTime, quartileLen, QUARTILES);
    if (q >= 0) quartileCounts[q]++;
  }

  // ── 2. ATTENTION-AWARE GREEDY SELECTION ────────────────────────────────
  // Score = attentionScore - rhythmPenalty(against kept set so far).
  // We greedily pick the top-scoring candidate each round, re-scoring after
  // each pick so rhythm memory updates dynamically. O(n^2) but n is tiny.
  const remaining = [...annotated];
  while (kept.length < targetCount && remaining.length > 0) {
    // Score each candidate against the current kept set
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const q = whichQuartile(c.startTime, quartileLen, QUARTILES);
      if (q < 0) continue;
      if (quartileCounts[q] >= Math.ceil(maxPerMin * (quartileLen / 60)) + 1) continue;
      if (kept.some((k) => Math.abs(k.startTime - c.startTime) < minSpacing)) continue;
      if (c.effectType === "zoom") {
        const recentZoom = kept.some(
          (k) =>
            k.effectType === "zoom" &&
            Math.abs(k.startTime - c.startTime) < zoomCooldown
        );
        if (recentZoom) continue;
      }

      const intensity = c.intensity ?? 0.5;
      const penalty = rhythmPenalty(c, kept, c.effectType, intensity);
      const score = (c.attentionScore ?? 0.5) - penalty;
      if (penalty > 0) {
        // Pre-counted; only commit when we actually pick this candidate.
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) break;

    const picked = remaining.splice(bestIdx, 1)[0];
    const q = whichQuartile(picked.startTime, quartileLen, QUARTILES);
    // For stats accounting: check whether rhythm cost factored in
    const finalPenalty = rhythmPenalty(
      picked,
      kept,
      picked.effectType,
      picked.intensity ?? 0.5
    );
    if (finalPenalty > 0.05) rhythmPenalized++;

    kept.push(picked);
    quartileCounts[q]++;
  }

  // Count what got filtered out for diagnostics
  for (const c of remaining) {
    // Approximate why we dropped it
    if (kept.some((k) => Math.abs(k.startTime - c.startTime) < minSpacing)) {
      droppedTooClose++;
    } else if (
      c.effectType === "zoom" &&
      kept.some(
        (k) =>
          k.effectType === "zoom" &&
          Math.abs(k.startTime - c.startTime) < zoomCooldown
      )
    ) {
      droppedTooManyZooms++;
    } else {
      droppedTooDense++;
    }
  }

  // ── 3. QUARTILE COVERAGE RESCUE ────────────────────────────────────────
  for (let q = 0; q < QUARTILES; q++) {
    if (quartileCounts[q] > 0) continue;
    const qStart = q * quartileLen;
    const qEnd = (q + 1) * quartileLen;
    // Take the highest-attention candidate inside the empty quartile, relaxing spacing to half.
    const inside = annotated
      .filter(
        (c) =>
          c.startTime >= qStart &&
          c.startTime < qEnd &&
          !kept.some((k) => k.id === c.id) &&
          !kept.some((k) => Math.abs(k.startTime - c.startTime) < minSpacing / 2)
      )
      .sort((a, b) => (b.attentionScore ?? 0.5) - (a.attentionScore ?? 0.5))[0];
    if (inside) {
      kept.push(inside);
      quartileCounts[q]++;
    }
  }

  // Sort by start time
  kept.sort((a, b) => a.startTime - b.startTime);

  // Re-id non-preserved
  let counter = 1;
  for (const m of kept) {
    if (!preservedIds.has(m.id)) {
      m.id = `m${counter}`;
      counter++;
    }
  }

  const quartileCoverage: BalancerResult["stats"]["quartileCoverage"] = [
    quartileCounts[0] > 0,
    quartileCounts[1] > 0,
    quartileCounts[2] > 0,
    quartileCounts[3] > 0,
  ];

  const avgAttention =
    kept.length > 0
      ? kept.reduce((sum, m) => sum + (m.attentionScore ?? 0.5), 0) / kept.length
      : 0;

  return {
    moments: kept,
    stats: {
      inputCount: raw.length,
      keptCount: kept.length,
      duration,
      quartileCoverage,
      densityPerMin: minutes > 0 ? kept.length / minutes : 0,
      pacing,
      videoType,
      droppedTooClose,
      droppedTooDense,
      droppedTooManyZooms,
      rewrittenEffects,
      rhythmPenalized,
      avgAttention,
      fusedCount,
      clickRefinedCount,
      cvCandidatesAdded,
    },
  };
}

function normalize(m: DetectedMoment, duration: number): DetectedMoment {
  const start = clamp(m.startTime, 0, Math.max(0, duration - 0.5));
  let end = clamp(m.endTime, start + 0.3, duration);
  if (!Number.isFinite(end) || end - start < 0.3) {
    end = Math.min(duration, start + 1.2);
  }
  return { ...m, startTime: start, endTime: end };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function whichQuartile(t: number, quartileLen: number, qs: number): number {
  if (quartileLen <= 0) return 0;
  const q = Math.floor(t / quartileLen);
  if (q < 0) return 0;
  if (q >= qs) return qs - 1;
  return q;
}

/** Effect-type histogram of a set of moments. */
export function effectTypeBreakdown(
  moments: DetectedMoment[]
): Record<EffectType, number> {
  const out: Record<EffectType, number> = {
    zoom: 0,
    "click-highlight": 0,
    "cursor-focus": 0,
    "speed-up": 0,
  };
  for (const m of moments) out[m.effectType]++;
  return out;
}

/** UI-context histogram. */
export function uiContextBreakdown(
  moments: DetectedMoment[]
): Record<UIContext, number> {
  const out: Record<UIContext, number> = {
    button: 0,
    modal: 0,
    dialog: 0,
    form: 0,
    code: 0,
    navigation: 0,
    scroll: 0,
    result: 0,
    media: 0,
    text: 0,
    menu: 0,
    other: 0,
  };
  for (const m of moments) {
    const ctx = m.uiContext ?? "other";
    out[ctx]++;
  }
  return out;
}

/** Distribution-quality metric (0..1) — how evenly the moments are spaced. */
export function distributionScore(
  moments: DetectedMoment[],
  duration: number
): number {
  if (moments.length < 2 || duration <= 0) return 1;
  const sorted = [...moments].sort((a, b) => a.startTime - b.startTime);
  const expected = duration / (sorted.length + 1);
  let totalDelta = 0;
  for (let i = 0; i < sorted.length; i++) {
    const idealAt = expected * (i + 1);
    totalDelta += Math.abs(sorted[i].startTime - idealAt);
  }
  const maxDelta = duration * sorted.length;
  return clamp(1 - totalDelta / Math.max(1, maxDelta), 0, 1);
}
