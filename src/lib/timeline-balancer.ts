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
  BoringSection,
  ConfidenceSource,
  DetectedMoment,
  EffectType,
  MomentProvenance,
  Pacing,
  RejectedCandidateRef,
  UIContext,
  VideoType,
  VisualAnalysis,
} from "./firebase/schema";
import { AI_MOMENT_QUOTA, PROVENANCE_RANK } from "./firebase/schema";
import { sampleCvForMoment, fuseAttention, nearestClickEvent } from "./cv/fusion";
import { visualMomentsFromCv } from "./cv/visual-moments";
import type { Interaction } from "./recording/types";
import { refineMomentFocalRegion } from "./timeline/focal-region";

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
  /**
   * Raw moment proposals from Gemini. In the hybrid pipeline these are treated
   * as `provenance: "ai"` unless already tagged otherwise. Kept named `raw`
   * for backward compatibility with the analyze route.
   */
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
   * Moment candidates derived from real interaction events (clicks, typing,
   * scroll-pauses, etc.). These get `provenance: "event"` and rank above all
   * other sources. AI can only override an event candidate when the event's
   * own confidence is below 0.25.
   */
  eventMoments?: DetectedMoment[];
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
  /**
   * Sections Gemini classified as quiet/boring. AI candidates that fall
   * mostly inside one of these AND have no CV motion get rejected by the
   * reject pass. Event candidates always survive — they're ground truth.
   */
  boringSections?: BoringSection[];
  /**
   * Raw interaction events from the recording. Used by the reject pass to
   * detect long idle stretches and by the relaxed `ai-override` rule to
   * confirm there isn't a real click near the overlap.
   */
  interactions?: Interaction[];
  /**
   * Treat `rejected: true` candidates in `raw` as advisory rather than
   * hard-dropped — used by the rebalance endpoint under "dense" pacing.
   */
  unrejectRebalance?: boolean;
}

export interface BalancerResult {
  moments: DetectedMoment[];
  /**
   * Candidates the reject pass dropped from the active timeline. Mirrored
   * (capped at 50) onto `analysis.rejectedPool` and individually tagged with
   * `rejected: true` for storage in `rawMoments`. Each carries
   * `rejectedReason`. Surfaced so the inspector / debug overlay can show
   * what the AI considered and chose not to commit.
   */
  rejectedPool: DetectedMoment[];
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
    /** Moments whose focusRegion was refined onto a directional signal. */
    focusRefinedCount: number;
    /** CV attention-curve peaks added to the candidate pool. */
    cvCandidatesAdded: number;
    /** Provenance histogram of kept moments. */
    provenanceCounts: Record<MomentProvenance, number>;
    /** AI moments dropped to honor the 15% quota. */
    quotaDropped: number;
    /** Events that lost to a higher-confidence neighbor (collapsed overlaps). */
    eventOverlapsResolved: number;
    /** AI candidates rejected because they sat inside a boring section + low CV motion. */
    aiRejectedBoring: number;
    /** AI candidates rejected because they sat inside a ≥4s idle stretch. */
    aiRejectedIdle: number;
    /** AI candidates rejected because they had no meaningful target. */
    aiRejectedNoTarget: number;
    /** Moments whose startTime was shifted to just AFTER a scene-change. */
    sceneChangeNudged: number;
    /** Quartiles left empty after honouring rejection (no rescue performed). */
    quartileLeftEmpty: number;
    /**
     * Per-provenance accounting for event-derived (real click / typing /
     * scroll-pause) candidates. Surfaced so the editor's Analysis Debug
     * panel can show exactly where a user's clicks were lost between
     * `momentsFromEvents` output and the final timeline.
     *
     *   eventCandidatesIn       = how many event moments entered balanceTimeline()
     *   eventDroppedByOverlap   = collapsed in resolveOverlaps (same-target)
     *   eventDroppedTooClose    = greedy-selection EVENT_MIN_SPACING (0.8s) rule
     *   eventDroppedTooManyZooms= greedy-selection zoomCooldown rule (now bypassed
     *                             for events — should always be 0; surfaces a
     *                             regression if it isn't)
     *   eventDroppedTooDense    = quartile-cap or target-count cap
     *   eventKept               = events present in the final timeline
     */
    eventStats: {
      eventCandidatesIn: number;
      eventDroppedByOverlap: number;
      eventDroppedTooClose: number;
      eventDroppedTooManyZooms: number;
      eventDroppedTooDense: number;
      eventKept: number;
    };
  };
}

const MIN_MOMENTS = 3;
const MAX_MOMENTS = 24;
export const REJECTED_POOL_CAP = 50;
const REJECTED_PER_MOMENT_CAP = 5;
const BORING_OVERLAP_THRESHOLD = 0.5;
const IDLE_MIN_SECONDS = 4;
const NO_TARGET_MOTION_FLOOR = 0.05;
const SCENE_CHANGE_NUDGE_WINDOW = 0.3;
const SCENE_CHANGE_NUDGE_OFFSET = 0.12;

/** Fraction of a moment's time window that overlaps a boring section. */
function boringOverlapFraction(
  m: { startTime: number; endTime: number },
  boringSections: BoringSection[]
): number {
  if (!boringSections || boringSections.length === 0) return 0;
  const len = Math.max(0.0001, m.endTime - m.startTime);
  let inside = 0;
  for (const b of boringSections) {
    const start = Math.max(m.startTime, b.startTime);
    const end = Math.min(m.endTime, b.endTime);
    if (end > start) inside += end - start;
  }
  return inside / len;
}

/**
 * True when the moment is wholly inside a ≥IDLE_MIN_SECONDS idle stretch.
 * Mirrors `events.ts` suppression but applies to AI gap-fills which are
 * generated by Gemini without idle awareness.
 */
function isInIdle(
  m: { startTime: number; endTime: number },
  interactions: Interaction[] | undefined
): boolean {
  if (!interactions || interactions.length === 0) return false;
  for (const e of interactions) {
    if (e.type !== "idle") continue;
    if (e.tEnd - e.t < IDLE_MIN_SECONDS) continue;
    if (m.startTime >= e.t && m.endTime <= e.tEnd) return true;
  }
  return false;
}

/** Mean dequantized motion (0..1) across the moment's window. */
function motionAt(va: VisualAnalysis | undefined, t: number): number {
  if (!va || va.sampleCount === 0 || va.sampleRate <= 0) return 0;
  const idx = Math.max(0, Math.min(va.sampleCount - 1, Math.floor(t * va.sampleRate)));
  return (va.motion[idx] ?? 0) / 255;
}

/** True when a real `click` / `dblclick` / `rightclick` is within ±windowSec of t. */
function hasRealClickNear(
  interactions: Interaction[] | undefined,
  t: number,
  windowSec: number
): boolean {
  if (!interactions || interactions.length === 0) return false;
  for (const e of interactions) {
    if (e.type !== "click" && e.type !== "dblclick" && e.type !== "rightclick") continue;
    if (Math.abs(e.t - t) <= windowSec) return true;
  }
  return false;
}

/**
 * If a moment's start lands inside `SCENE_CHANGE_NUDGE_WINDOW` of a detected
 * scene change, shift it to `sceneChange.t + SCENE_CHANGE_NUDGE_OFFSET` so
 * the camera doesn't jump mid-transition. Returns the (possibly modified)
 * moment + a boolean indicating whether nudging occurred.
 */
function nudgeAfterSceneChange(
  m: DetectedMoment,
  va: VisualAnalysis | undefined,
  duration: number
): { moment: DetectedMoment; nudged: boolean } {
  if (!va || !va.sceneChanges || va.sceneChanges.length === 0) {
    return { moment: m, nudged: false };
  }
  const len = m.endTime - m.startTime;
  for (const sc of va.sceneChanges) {
    const delta = m.startTime - sc.t;
    // Only nudge if the moment starts close to or just *before* the scene
    // change — we never push a moment back in time.
    if (delta < -SCENE_CHANGE_NUDGE_WINDOW || delta > SCENE_CHANGE_NUDGE_WINDOW) {
      continue;
    }
    const newStart = Math.min(duration - len, sc.t + SCENE_CHANGE_NUDGE_OFFSET);
    if (newStart > m.startTime + 0.01) {
      const moved: DetectedMoment = {
        ...m,
        startTime: newStart,
        endTime: Math.min(duration, newStart + len),
        whySelected: appendWhy(
          m.whySelected,
          `nudged ${(newStart - m.startTime).toFixed(2)}s after scene change @${sc.t.toFixed(2)}s`
        ),
      };
      return { moment: moved, nudged: true };
    }
  }
  return { moment: m, nudged: false };
}

function appendWhy(prev: string | undefined, suffix: string): string {
  return prev && prev.length > 0 ? `${prev} · ${suffix}` : suffix;
}

interface RejectContext {
  boringSections: BoringSection[];
  interactions: Interaction[] | undefined;
  visualAnalysis: VisualAnalysis | undefined;
  videoType: VideoType | undefined;
  unrejectRebalance: boolean;
}

/**
 * Drop AI / `ai-override` candidates that fall into one of three quiet
 * categories. Event and user moments always survive — they're ground truth.
 * Each dropped candidate gets `rejected: true` + `rejectedReason` so the
 * route can persist it for the rebalance endpoint.
 *
 * Rejection rules:
 *   • In a boring section by >BORING_OVERLAP_THRESHOLD AND `motionAt(t) < NO_TARGET_MOTION_FLOOR`
 *     AND no scene change within ±2s.
 *   • Wholly inside a ≥IDLE_MIN_SECONDS idle interaction stretch.
 *   • `targetRegionSource === "default"` AND `motionAt(t) < NO_TARGET_MOTION_FLOOR` AND provenance ∈ {ai, cv}.
 *
 * Talking-tutorial / presentation video types skip the motion floor (those
 * videos legitimately have low frame motion).
 */
function rejectAiCandidates(
  candidates: DetectedMoment[],
  ctx: RejectContext
): {
  survivors: DetectedMoment[];
  rejected: DetectedMoment[];
  stats: { aiRejectedBoring: number; aiRejectedIdle: number; aiRejectedNoTarget: number };
} {
  const survivors: DetectedMoment[] = [];
  const rejected: DetectedMoment[] = [];
  let aiRejectedBoring = 0;
  let aiRejectedIdle = 0;
  let aiRejectedNoTarget = 0;

  const motionExempt =
    ctx.videoType === "talking-tutorial" || ctx.videoType === "presentation";
  const va = ctx.visualAnalysis;
  const sceneChanges = va?.sceneChanges ?? [];
  const hasSceneNear = (t: number) =>
    sceneChanges.some((sc) => Math.abs(sc.t - t) < 2);

  const recordReject = (m: DetectedMoment, reason: string) => {
    rejected.push({ ...m, rejected: true, rejectedReason: reason });
  };

  for (const m of candidates) {
    const prov = m.provenance ?? "ai";
    // Events + user moments are never rejected by this pass.
    if (prov === "event" || prov === "user") {
      survivors.push(m);
      continue;
    }
    const midT = (m.startTime + m.endTime) / 2;
    const motion = motionAt(va, midT);

    // 1) Boring section + low motion + no nearby scene change.
    const boringOverlap = boringOverlapFraction(m, ctx.boringSections);
    if (
      boringOverlap > BORING_OVERLAP_THRESHOLD &&
      (motionExempt || motion < NO_TARGET_MOTION_FLOOR) &&
      !hasSceneNear(midT)
    ) {
      aiRejectedBoring++;
      recordReject(
        m,
        `boring-section (${Math.round(boringOverlap * 100)}% overlap, motion ${motion.toFixed(2)})`
      );
      continue;
    }

    // 2) Long idle stretch.
    if (isInIdle(m, ctx.interactions)) {
      aiRejectedIdle++;
      recordReject(m, "in-idle (≥4s idle stretch)");
      continue;
    }

    // 3) No meaningful target — generic default focus region + no motion.
    if (
      !motionExempt &&
      (m.targetRegionSource === "default" || !m.targetRegionSource) &&
      motion < NO_TARGET_MOTION_FLOOR &&
      (prov === "ai" || prov === "cv")
    ) {
      aiRejectedNoTarget++;
      recordReject(
        m,
        `no-target (default region, motion ${motion.toFixed(2)})`
      );
      continue;
    }

    survivors.push(m);
  }

  return {
    survivors,
    rejected,
    stats: { aiRejectedBoring, aiRejectedIdle, aiRejectedNoTarget },
  };
}

/**
 * Walk the kept set after greedy pick and attach each rejected candidate to
 * its nearest temporal neighbour as a `rejectedCandidates` entry. Cap per
 * survivor at REJECTED_PER_MOMENT_CAP so docs don't bloat.
 */
function attachRejections(
  kept: DetectedMoment[],
  rejected: DetectedMoment[]
): void {
  if (rejected.length === 0 || kept.length === 0) return;
  for (const r of rejected) {
    let nearest: DetectedMoment | null = null;
    let bestDist = Infinity;
    for (const k of kept) {
      const d = Math.abs(((k.startTime + k.endTime) / 2) - ((r.startTime + r.endTime) / 2));
      if (d < bestDist) {
        bestDist = d;
        nearest = k;
      }
    }
    if (!nearest) continue;
    const entry: RejectedCandidateRef = {
      ts: r.startTime,
      reason: r.rejectedReason ?? "rejected",
      provenance: r.provenance ?? "ai",
      effectType: r.effectType,
    };
    if (!nearest.rejectedCandidates) nearest.rejectedCandidates = [];
    if (nearest.rejectedCandidates.length < REJECTED_PER_MOMENT_CAP) {
      nearest.rejectedCandidates.push(entry);
    }
  }
}

/** ── 1. CONTEXTUAL EFFECT REWRITING ──────────────────────────────────────
 *
 * Even if Gemini chose an effectType, override it when uiContext disagrees.
 * e.g. a "zoom" on a scroll moment should be cursor-focus or speed-up.
 */
function rewriteEffectByContext(m: DetectedMoment): {
  effectType: EffectType;
  rewritten: boolean;
  reason: string | null;
} {
  const ctx = m.uiContext;
  if (!ctx) return { effectType: m.effectType, rewritten: false, reason: null };

  const original = m.effectType;
  let next: EffectType = original;
  let reason: string | null = null;

  switch (ctx) {
    case "code":
      // Code activity rarely deserves a hard zoom — prefer cursor-focus.
      if (original === "zoom" && (m.attentionScore ?? 0.5) < 0.75) {
        next = "cursor-focus";
        reason = "code context → cursor-focus (zoom too aggressive on editor)";
      }
      break;
    case "scroll":
      // Scrolling never deserves zoom — speed-up if low attention, else cursor-focus.
      if (original === "zoom" || original === "click-highlight") {
        next = (m.attentionScore ?? 0.5) < 0.4 ? "speed-up" : "cursor-focus";
        reason = `scroll context → ${next} (${original} doesn't fit a scrolling viewport)`;
      }
      break;
    case "modal":
    case "dialog":
    case "result":
      // Reveals should always be zooms (or click-highlight if already that).
      if (original === "cursor-focus" || original === "speed-up") {
        next = "zoom";
        reason = `${ctx} reveal → zoom (cinematic emphasis on a state change)`;
      }
      break;
    case "form":
      // Form fields prefer gentle cursor-focus over hard zoom (unless reveal).
      if (original === "zoom" && (m.attentionScore ?? 0.5) < 0.6) {
        next = "cursor-focus";
        reason = "form context → cursor-focus (gentle focus on input)";
      }
      break;
    case "navigation":
      // Navigation = scene change = zoom.
      if (m.sceneChange && original !== "click-highlight") {
        next = "zoom";
        reason = "navigation + scene change → zoom (page transition reveal)";
      }
      break;
    default:
      break;
  }

  return { effectType: next, rewritten: next !== original, reason };
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
  let sameContextStreak = 0;
  for (let i = lastFew.length - 1; i >= 0; i--) {
    if (lastFew[i].effectType === candidateEffect) sameTypeStreak++;
    else break;
  }
  // uiContext-aware streak — three cursor-focus moments all on the same
  // context (e.g. `code`) is repetitive; spread across contexts it's fine.
  if (candidate.uiContext) {
    for (let i = lastFew.length - 1; i >= 0; i--) {
      if (
        lastFew[i].effectType === candidateEffect &&
        lastFew[i].uiContext === candidate.uiContext
      ) {
        sameContextStreak++;
      } else break;
    }
  }
  // Two in a row of the same effect: small penalty. Three in a row: bigger.
  if (sameTypeStreak === 1) penalty += 0.08;
  if (sameTypeStreak === 2) penalty += 0.18;
  if (sameTypeStreak >= 3) penalty += 0.35;
  // Extra penalty when the streak is also same-uiContext — three cursor-focus
  // all on `code` is worse than three across `code`, `form`, `code`.
  if (sameContextStreak >= 2) penalty += 0.1;
  if (sameContextStreak >= 3) penalty += 0.15;

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
  /** How many moments had their focusRegion refined onto a real signal. */
  focusRefinedCount: number;
}

function fuseMomentsWithCv(
  raw: DetectedMoment[],
  va: VisualAnalysis,
  duration: number,
  interactions?: Interaction[]
): FusionResult {
  const sorted = [...raw].sort((a, b) => a.startTime - b.startTime);
  let clickRefinedCount = 0;
  let focusRefinedCount = 0;

  const moments = sorted.map((m, i) => {
    const cv = sampleCvForMoment(va, m.startTime, m.endTime);
    const geminiScore = m.attentionScore ?? m.importance ?? 0.5;

    let next: DetectedMoment = {
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

    // Focus-region refinement — multi-signal cascade replaces the old
    // CV-centroid-only block. The helper consults real clicks first, then
    // cursor dwell, then CV centroid, then form heuristics, and ONLY
    // overwrites the region when the new centre is materially different.
    // User-positioned regions (`targetRegionSource === "user"` or
    // `source === "user"`) are passed through untouched.
    const refined = refineMomentFocalRegion(next, interactions, va);
    if (refined !== next) {
      next = refined;
      focusRefinedCount++;
    }

    return next;
  });

  return { moments, fusedCount: moments.length, clickRefinedCount, focusRefinedCount };
}

/** Legacy floor — events with confidence below this can always be overridden. */
const EVENT_OVERRIDE_THRESHOLD = 0.25;
/**
 * Confidence delta required for an AI candidate to beat a healthy event
 * candidate. Combined with "no real click within ±1s" + "uiContext disagrees".
 * Designed so override is rare but possible (e.g. AI sees a modal reveal at
 * the same instant as a stray click on something unrelated).
 */
const EVENT_OVERRIDE_AI_DELTA = 0.15;
const EVENT_OVERRIDE_CLICK_GUARD_S = 1.0;

/** Effective provenance of a moment, defaulting to "ai" for un-tagged legacy moments. */
function provenanceOf(m: DetectedMoment): MomentProvenance {
  if (m.provenance) return m.provenance;
  if (m.source === "user") return "user";
  return "ai";
}

/** Confidence floor that aligns with provenance ranking. */
function defaultConfidenceFor(p: MomentProvenance): number {
  switch (p) {
    case "user":
      return 1.0;
    case "event":
      return 0.9;
    case "cv":
      return 0.6;
    case "ai-override":
      return 0.5;
    case "ai":
      return 0.45;
  }
}

function defaultConfidenceSource(p: MomentProvenance, m: DetectedMoment): ConfidenceSource {
  if (p === "event") {
    if (m.confidenceSource) return m.confidenceSource;
    return "real-click";
  }
  if (p === "cv") {
    if (m.sceneChange) return "cv-scene-change";
    return "cv-motion-peak";
  }
  if (p === "user") return "user-manual";
  return "ai-gap-fill";
}

/**
 * Ensure every moment has confidenceScore / Source / Reason. Idempotent —
 * existing values are preserved.
 */
function ensureConfidence(m: DetectedMoment): DetectedMoment {
  const p = provenanceOf(m);
  if (
    typeof m.confidenceScore === "number" &&
    m.confidenceSource &&
    m.confidenceReason
  ) {
    return m;
  }
  const score =
    typeof m.confidenceScore === "number"
      ? m.confidenceScore
      : Math.max(defaultConfidenceFor(p), m.attentionScore ?? 0);
  const source = m.confidenceSource ?? defaultConfidenceSource(p, m);
  const reason =
    m.confidenceReason ??
    `${score.toFixed(2)} — ${
      p === "event"
        ? "real interaction event"
        : p === "cv"
        ? m.sceneChange
          ? "CV scene change"
          : "CV motion / signal peak"
        : p === "user"
        ? "user-created"
        : "AI proposal"
    }`;
  return { ...m, provenance: p, confidenceScore: score, confidenceSource: source, confidenceReason: reason };
}

/**
 * Collapse overlapping candidates by priority (EVENT > CV > AI > USER for
 * conflicts; USER preserved separately so this never collides). Two candidates
 * "overlap" when their time windows intersect AND their focusRegion centers
 * are within EPS_FOCUS of each other.
 *
 * AI may only beat an event when the event's confidenceScore is below
 * EVENT_OVERRIDE_THRESHOLD — the winner inherits `provenance: "ai-override"`
 * so the override stays visible in the UI.
 */
function resolveOverlaps(
  candidates: DetectedMoment[],
  interactions: Interaction[] | undefined
): { kept: DetectedMoment[]; eventOverlapsResolved: number; eventsDropped: number } {
  /**
   * Focus-distance threshold for "this candidate is on the same UI
   * target as one we already kept." AI-vs-AI uses the historical
   * loose 0.18 (lets the balancer collapse overlapping AI proposals
   * on the same region into one). Event-vs-event uses a much
   * tighter 0.08 — separate user clicks usually land on separate
   * elements, and the loose threshold was collapsing legitimate
   * multi-click sequences (sidebar nav, button row) into one zoom.
   */
  const EPS_FOCUS_AI = 0.18;
  const EPS_FOCUS_EVENT = 0.08;
  /**
   * Temporal collapse window for event-vs-event. Two clicks within
   * this many seconds of each other count as "the same click" and
   * collapse to one moment; further apart, they each become their
   * own moment. Matches the user's spec: clicks < 0.8s apart merge,
   * otherwise stay separate.
   */
  const EVENT_COLLAPSE_S = 0.8;
  const sorted = [...candidates].sort((a, b) => {
    const ra = PROVENANCE_RANK[provenanceOf(a)];
    const rb = PROVENANCE_RANK[provenanceOf(b)];
    if (ra !== rb) return rb - ra;
    return (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0);
  });
  const kept: DetectedMoment[] = [];
  let eventOverlapsResolved = 0;
  // Distinct from `eventOverlapsResolved`: counts EVENT candidates that
  // failed to enter `kept` here (the AI-vs-event override drops the kept
  // event AFTER counting it as resolved, so we'd over-count if we used
  // the same counter for diagnostics).
  let eventsDropped = 0;
  for (const cand of sorted) {
    const cCx = cand.focusRegion.x + cand.focusRegion.width / 2;
    const cCy = cand.focusRegion.y + cand.focusRegion.height / 2;
    const candProv = provenanceOf(cand);
    let overlapsExisting: DetectedMoment | null = null;
    for (const k of kept) {
      const kProv = provenanceOf(k);
      const bothEvent = candProv === "event" && kProv === "event";
      // For event-vs-event, the overlap test is much tighter — only
      // collapse clicks within EVENT_COLLAPSE_S of each other AND on
      // essentially the same target. Letting separate user clicks on
      // separate targets survive is the whole point of this loop fix.
      const overlapsTime = bothEvent
        ? Math.abs(k.startTime - cand.startTime) < EVENT_COLLAPSE_S
        : !(k.endTime <= cand.startTime || k.startTime >= cand.endTime);
      const epsFocus = bothEvent ? EPS_FOCUS_EVENT : EPS_FOCUS_AI;
      const kCx = k.focusRegion.x + k.focusRegion.width / 2;
      const kCy = k.focusRegion.y + k.focusRegion.height / 2;
      const closeFocus = Math.hypot(kCx - cCx, kCy - cCy) < epsFocus;
      if (overlapsTime && closeFocus) {
        overlapsExisting = k;
        break;
      }
    }
    if (!overlapsExisting) {
      kept.push(cand);
      continue;
    }
    // Resolve: cand's rank ≤ existing's by sort order. Special case AI override.
    // `candProv` is already in scope from the overlap-detection block above.
    const existingProv = provenanceOf(overlapsExisting);
    if (existingProv === "event" && candProv === "ai") {
      const eventConf = overlapsExisting.confidenceScore ?? 1;
      const aiConf = cand.confidenceScore ?? 0;
      const midT = (cand.startTime + cand.endTime) / 2;
      const noClickNear = !hasRealClickNear(
        interactions,
        midT,
        EVENT_OVERRIDE_CLICK_GUARD_S
      );
      const contextDisagrees =
        !!cand.uiContext &&
        !!overlapsExisting.uiContext &&
        cand.uiContext !== overlapsExisting.uiContext;

      const legacyOverride = eventConf < EVENT_OVERRIDE_THRESHOLD;
      const strongDelta =
        aiConf > eventConf + EVENT_OVERRIDE_AI_DELTA &&
        noClickNear &&
        contextDisagrees;

      if (legacyOverride || strongDelta) {
        const idx = kept.indexOf(overlapsExisting);
        const reason = legacyOverride
          ? `override: weak event conf ${eventConf.toFixed(2)} < ${EVENT_OVERRIDE_THRESHOLD}`
          : `override: AI conf ${aiConf.toFixed(2)} > event conf ${eventConf.toFixed(2)}, no click within ±${EVENT_OVERRIDE_CLICK_GUARD_S}s, context mismatch (${overlapsExisting.uiContext} → ${cand.uiContext})`;
        kept[idx] = {
          ...cand,
          provenance: "ai-override",
          whySelected: appendWhy(cand.whySelected, reason),
        };
        eventOverlapsResolved++;
        eventsDropped++; // the kept event was replaced by ai-override
        continue;
      }
      eventOverlapsResolved++;
    } else if (existingProv === "event") {
      eventOverlapsResolved++;
    }
    // Candidate dropped (either lost to higher-rank existing, or AI vs AI overlap).
    if (candProv === "event") eventsDropped++;
  }
  return { kept, eventOverlapsResolved, eventsDropped };
}

/**
 * Enforce the AI moment quota — ≤ AI_MOMENT_QUOTA share of the final timeline.
 * Drops lowest-confidence AI moments until the ratio is satisfied. Returns the
 * pruned list and the count dropped.
 */
export function enforceAiQuota(
  moments: DetectedMoment[]
): { kept: DetectedMoment[]; quotaDropped: number } {
  if (moments.length === 0) return { kept: moments, quotaDropped: 0 };
  // ai-override counts as AI for quota purposes.
  let aiCount = 0;
  for (const m of moments) {
    const p = provenanceOf(m);
    if (p === "ai" || p === "ai-override") aiCount++;
  }
  // The quota is a share of the FINAL timeline and we only ever drop AI
  // moments, so the allowance is self-referential: keeping `a` AI moments
  // alongside `n` non-AI ones gives a/(n+a), which must be ≤ Q. Solving for a:
  //
  //     a/(n+a) ≤ Q   ⇔   a ≤ n·Q/(1−Q)
  //
  // Measuring the allowance against the PRE-drop total (`moments.length·Q`)
  // instead overshoots every time, because the denominator shrinks as AI
  // moments are dropped — so "enforcement" left the timeline still over cap and
  // `assertAiQuota` below threw the whole request away (a real 160-candidate /
  // 90-AI run kept 24/94 = 25.5% against a 15% cap and 500'd the finalize).
  const nonAiCount = moments.length - aiCount;
  // Degenerate: no non-AI moments to dilute against. The quota is then
  // unsatisfiable except by emptying the timeline entirely, which serves nobody
  // — keep what we have (see the matching carve-out in `assertAiQuota`).
  if (nonAiCount === 0) return { kept: moments, quotaDropped: 0 };
  const allowed = Math.floor((nonAiCount * AI_MOMENT_QUOTA) / (1 - AI_MOMENT_QUOTA));
  if (aiCount <= allowed) return { kept: moments, quotaDropped: 0 };
  // Pick AI moments to drop, lowest confidence first.
  const aiSorted = moments
    .map((m, i) => ({ m, i, p: provenanceOf(m) }))
    .filter((x) => x.p === "ai" || x.p === "ai-override")
    .sort((a, b) => (a.m.confidenceScore ?? 0) - (b.m.confidenceScore ?? 0));
  const dropIdxs = new Set<number>();
  let toDrop = aiCount - allowed;
  for (const x of aiSorted) {
    if (toDrop <= 0) break;
    dropIdxs.add(x.i);
    toDrop--;
  }
  const kept = moments.filter((_, i) => !dropIdxs.has(i));
  return { kept, quotaDropped: dropIdxs.size };
}

/**
 * Runtime assertion that the quota holds after selection. Throws in dev,
 * warns in prod (and emits to telemetry if available). Catches accidental
 * future regressions.
 */
export function assertAiQuota(moments: DetectedMoment[]): void {
  if (moments.length === 0) return;
  let aiCount = 0;
  for (const m of moments) {
    const p = provenanceOf(m);
    if (p === "ai" || p === "ai-override") aiCount++;
  }
  // An all-AI timeline can only satisfy the quota by being empty (see
  // `enforceAiQuota`) — that's a property of the candidate pool, not the
  // selection regression this assertion exists to catch, so don't fail the
  // request over it. Still worth a line in the log.
  if (aiCount === moments.length) {
    console.warn(
      `[balancer] timeline is 100% AI moments (${aiCount}) — no non-AI signal to dilute against; quota not applicable`
    );
    return;
  }
  const ratio = aiCount / moments.length;
  if (ratio > AI_MOMENT_QUOTA + 1e-6) {
    const msg = `[balancer] AI moment quota breached — ${(ratio * 100).toFixed(1)}% AI (cap ${(
      AI_MOMENT_QUOTA * 100
    ).toFixed(0)}%)`;
    if (process.env.NODE_ENV !== "production") {
      throw new Error(msg);
    }
    console.warn(msg);
  }
}

/** Main entry. See file header for the layering. */
export function balanceTimeline(input: BalancerInput): BalancerResult {
  const { duration, pacing, videoType, visualAnalysis } = input;
  const profile = PACING_PROFILES[pacing] ?? PACING_PROFILES.moderate;
  const bias = VIDEO_TYPE_BIAS[videoType ?? "mixed"];

  const ratePerMin = profile.ratePerMin * bias.rateMult;
  const minSpacing = profile.minSpacing * bias.spacingMult;
  const minPerMin = profile.minPerMin * Math.max(0.6, bias.rateMult);
  const maxPerMin = profile.maxPerMin * Math.min(1.4, bias.rateMult);
  const zoomCooldown = profile.zoomCooldown * bias.spacingMult;

  const boringSections = input.boringSections ?? [];
  const interactions = input.interactions;
  const unrejectRebalance = !!input.unrejectRebalance;

  // ── 0a. Build the unified candidate pool with provenance tagging. ────────
  // Event moments are authoritative (rank EVENT > CV > AI). AI proposals
  // ("raw") are tagged with provenance "ai" unless they already carry one
  // (re-balance passes preserve previous tagging).
  //
  // When `raw` carries `rejected: true` candidates (preserved by the analyze
  // route in `rawMoments` for rebalance compatibility), we drop them here by
  // default; the rebalance endpoint sets `unrejectRebalance: true` under
  // dense pacing to bring them back into consideration.
  let fusedCount = 0;
  let clickRefinedCount = 0;
  let focusRefinedCount = 0;
  let cvCandidatesAdded = 0;

  const rawIn = unrejectRebalance
    ? input.raw.map((m) => ({ ...m, rejected: false, rejectedReason: undefined }))
    : input.raw.filter((m) => m.rejected !== true);

  const taggedRaw: DetectedMoment[] = rawIn.map((m) =>
    m.provenance
      ? m
      : { ...m, provenance: "ai" as MomentProvenance, source: m.source ?? "ai" }
  );
  const eventMoments = (input.eventMoments ?? []).map((m) => ({
    ...m,
    provenance: "event" as MomentProvenance,
    source: m.source ?? "ai",
  }));

  let effectiveRaw: DetectedMoment[] = [...eventMoments, ...taggedRaw];

  if (visualAnalysis && visualAnalysis.sampleCount > 0) {
    // CV fusion still adjusts the AI/Gemini moments — keep events untouched.
    const aiOnly = effectiveRaw.filter((m) => provenanceOf(m) !== "event");
    const evOnly = effectiveRaw.filter((m) => provenanceOf(m) === "event");
    const fusion = fuseMomentsWithCv(aiOnly, visualAnalysis, duration, input.interactions);
    fusedCount = fusion.fusedCount;
    clickRefinedCount = fusion.clickRefinedCount;
    focusRefinedCount = fusion.focusRefinedCount;
    effectiveRaw = [...evOnly, ...fusion.moments];

    if (input.useCvCandidates) {
      // Visual editing engine: cursor-grounded clicks (tight regions) + peak
      // backstop. Preserve each candidate's own targetRegionSource — the
      // inferred-click moments carry "cv-inferred-click" so the reject pass
      // keeps them; only peak fallbacks default to "motion-centroid".
      const candidates = visualMomentsFromCv(visualAnalysis, duration, minSpacing).map((c) => ({
        ...c,
        provenance: "cv" as MomentProvenance,
        source: c.source ?? "ai",
        targetRegionSource: c.targetRegionSource ?? ("motion-centroid" as const),
      }));
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

  // ── 0b. Reject pass: drop AI / ai-override candidates that fall into
  // quiet stretches (boring section + low motion, ≥4s idle, or no
  // meaningful target). Event + user moments always survive. Rejected
  // candidates are preserved with `rejected: true` so the analyze route can
  // persist them in `rawMoments` for the rebalance endpoint.
  const rejectPass = rejectAiCandidates(effectiveRaw, {
    boringSections,
    interactions,
    visualAnalysis,
    videoType,
    unrejectRebalance,
  });
  effectiveRaw = rejectPass.survivors;
  const rejectedAll: DetectedMoment[] = rejectPass.rejected;

  // ── 0c. Backfill confidence on every candidate, then resolve overlaps by
  // priority. Events with confidence < threshold can be overridden by AI;
  // the winner is marked "ai-override" so it stays visibly labelled. The
  // relaxed rule also lets a strongly-disagreeing AI candidate override a
  // healthy event when no real click sits within ±1s — see resolveOverlaps.
  effectiveRaw = effectiveRaw.map(ensureConfidence);
  // Count events entering the overlap/greedy stages. Events that the reject
  // pass might have skipped don't count here — only the pool the balancer
  // actively considers.
  const eventCandidatesIn = effectiveRaw.filter(
    (m) => provenanceOf(m) === "event"
  ).length;
  const overlapResolved = resolveOverlaps(effectiveRaw, interactions);
  effectiveRaw = overlapResolved.kept;

  // ── 0d. Scene-change nudge — shift moment starts that land right on a
  // detected scene change so the camera doesn't jump mid-transition.
  let sceneChangeNudged = 0;
  if (visualAnalysis && visualAnalysis.sceneChanges?.length > 0) {
    effectiveRaw = effectiveRaw.map((m) => {
      const r = nudgeAfterSceneChange(m, visualAnalysis, duration);
      if (r.nudged) sceneChangeNudged++;
      return r.moment;
    });
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
      const { effectType, rewritten, reason } = rewriteEffectByContext(m);
      if (rewritten) rewrittenEffects++;
      const intensity = computeIntensity({ ...m, effectType });
      const whyEffectType = rewritten
        ? appendWhy(m.whyEffectType, reason ?? "context rewrite")
        : m.whyEffectType;
      return { ...m, effectType, intensity, whyEffectType };
    });

  // Target count: bounded by pacing rate, duration, AND duration-aware
  // caps so a short clip can't claim 20 moments and a 5-minute clip can
  // claim more than the global `MAX_MOMENTS` floor of 24. The bucket
  // caps were explicitly specified for the click-zoom redesign:
  //   short  (≤30s)   → 3..6
  //   medium (30..120s) → 6..12
  //   long   (>120s)  → 12..20
  // The pacing-rate calculation still wins inside the bucket window;
  // these brackets only tighten the floor + ceiling.
  const minutes = Math.max(duration / 60, 0.5);
  const durationBucket: { min: number; max: number } =
    duration <= 30
      ? { min: 3, max: 6 }
      : duration <= 120
        ? { min: 6, max: 12 }
        : { min: 12, max: 20 };
  const targetCount = clamp(
    Math.round(minutes * ratePerMin),
    Math.max(MIN_MOMENTS, durationBucket.min, Math.ceil(minutes * minPerMin)),
    Math.min(MAX_MOMENTS, durationBucket.max, Math.ceil(minutes * maxPerMin))
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
  //
  // Spacing has TWO regimes:
  //
  //   - AI / CV candidates use the pacing-profile `minSpacing` (7s at
  //     moderate) + `zoomCooldown` (10s for zoom-vs-zoom). These rules
  //     keep AI-derived moments from feeling spam-y.
  //
  //   - EVENT candidates (real clicks / typing / scroll pauses) use
  //     `EVENT_MIN_SPACING` (0.8s) and are exempt from `zoomCooldown`.
  //     The user explicitly clicked through their app and wants the
  //     camera to follow each meaningful action. Collapsing multi-
  //     click sequences (sidebar nav, button row) into one zoom was
  //     the "only 1 moment for 6 clicks" bug. 0.8s matches the
  //     event-vs-event collapse threshold in `resolveOverlaps`, so
  //     clicks too close to be distinct were already merged upstream
  //     before they reach this loop.
  const EVENT_MIN_SPACING = 0.8;
  const remaining = [...annotated];
  while (kept.length < targetCount && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    let bestPenalty = 0;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const cProv = provenanceOf(c);
      const isEvent = cProv === "event";
      const cMinSpacing = isEvent ? EVENT_MIN_SPACING : minSpacing;
      const q = whichQuartile(c.startTime, quartileLen, QUARTILES);
      if (q < 0) continue;
      if (quartileCounts[q] >= Math.ceil(maxPerMin * (quartileLen / 60)) + 1) continue;
      if (kept.some((k) => Math.abs(k.startTime - c.startTime) < cMinSpacing)) continue;
      // Zoom cooldown — only applies to AI/CV-derived zooms. Real user
      // clicks aren't rate-limited; if the user clicked five times in
      // ten seconds, the camera follows all five.
      if (c.effectType === "zoom" && !isEvent) {
        const recentZoom = kept.some(
          (k) =>
            k.effectType === "zoom" &&
            provenanceOf(k) !== "event" &&
            Math.abs(k.startTime - c.startTime) < zoomCooldown
        );
        if (recentZoom) continue;
      }

      const intensity = c.intensity ?? 0.5;
      const penalty = rhythmPenalty(c, kept, c.effectType, intensity);
      const provBoost = cProv === "event" ? 0.3 : cProv === "cv" ? 0.1 : 0;
      const conf = c.confidenceScore ?? 0.5;
      const score = (c.attentionScore ?? 0.5) + provBoost * (0.5 + conf / 2) - penalty;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
        bestPenalty = penalty;
      }
    }

    if (bestIdx < 0) break;

    const picked = remaining.splice(bestIdx, 1)[0];
    const q = whichQuartile(picked.startTime, quartileLen, QUARTILES);
    if (bestPenalty > 0.05) rhythmPenalized++;

    const provBoost =
      provenanceOf(picked) === "event"
        ? 0.3
        : provenanceOf(picked) === "cv"
          ? 0.1
          : 0;
    const conf = picked.confidenceScore ?? 0.5;
    const att = picked.attentionScore ?? 0.5;
    const finalScore = att + provBoost * (0.5 + conf / 2) - bestPenalty;
    const explanation = `attention ${att.toFixed(2)} + provBoost ${provBoost.toFixed(
      2
    )} (${provenanceOf(picked)}, conf ${conf.toFixed(2)}) - rhythm ${bestPenalty.toFixed(
      2
    )} = ${finalScore.toFixed(2)}`;
    picked.whySelected = appendWhy(picked.whySelected, explanation);

    kept.push(picked);
    quartileCounts[q]++;
  }

  // Diagnostics for what didn't make it. Per-provenance spacing so
  // event candidates aren't mis-blamed for "too close" when the AI
  // rule (7s) wouldn't have applied to them. Track event drops
  // separately so the Analysis Debug panel can show exactly how many
  // user clicks were lost to each rule.
  let eventDroppedTooClose = 0;
  let eventDroppedTooManyZooms = 0;
  let eventDroppedTooDense = 0;
  for (const c of remaining) {
    const isEvent = provenanceOf(c) === "event";
    const cMinSpacing = isEvent ? EVENT_MIN_SPACING : minSpacing;
    if (kept.some((k) => Math.abs(k.startTime - c.startTime) < cMinSpacing)) {
      droppedTooClose++;
      if (isEvent) eventDroppedTooClose++;
    } else if (
      c.effectType === "zoom" &&
      !isEvent &&
      kept.some(
        (k) =>
          k.effectType === "zoom" &&
          provenanceOf(k) !== "event" &&
          Math.abs(k.startTime - c.startTime) < zoomCooldown
      )
    ) {
      droppedTooManyZooms++;
    } else if (
      isEvent &&
      c.effectType === "zoom" &&
      kept.some(
        (k) =>
          k.effectType === "zoom" &&
          provenanceOf(k) !== "event" &&
          Math.abs(k.startTime - c.startTime) < zoomCooldown
      )
    ) {
      // Should never happen — event zooms bypass cooldown in the greedy
      // loop. Surface it if it does (regression alarm).
      droppedTooManyZooms++;
      eventDroppedTooManyZooms++;
    } else {
      droppedTooDense++;
      if (isEvent) eventDroppedTooDense++;
    }
  }

  // ── 3. QUARTILE COVERAGE — HONOUR REJECTION ────────────────────────────
  // The reject pass already removed candidates that don't deserve emphasis.
  // We do NOT rescue from `rejectedAll`. If a quartile is empty after the
  // greedy pick AND no surviving candidate sits inside it, leave it empty —
  // surface that to the user via `quartileLeftEmpty`.
  let quartileLeftEmpty = 0;
  for (let q = 0; q < QUARTILES; q++) {
    if (quartileCounts[q] > 0) continue;
    const qStart = q * quartileLen;
    const qEnd = (q + 1) * quartileLen;
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
      inside.whySelected = appendWhy(
        inside.whySelected,
        `quartile rescue: only survivor in Q${q + 1}`
      );
      kept.push(inside);
      quartileCounts[q]++;
    } else {
      quartileLeftEmpty++;
    }
  }

  // Sort by start time
  kept.sort((a, b) => a.startTime - b.startTime);

  // Enforce the AI quota (≤ 15% of final timeline).
  const quotaResult = enforceAiQuota(kept.map(ensureConfidence));
  const final: DetectedMoment[] = quotaResult.kept;
  const quotaDropped = quotaResult.quotaDropped;

  assertAiQuota(final);

  // Re-id non-preserved
  let counter = 1;
  for (const m of final) {
    if (!preservedIds.has(m.id)) {
      m.id = `m${counter}`;
      counter++;
    }
  }

  // Attach rejected candidates to the nearest surviving moment (cap 5 each).
  attachRejections(final, rejectedAll);

  const quartileCoverage: BalancerResult["stats"]["quartileCoverage"] = [
    quartileCounts[0] > 0,
    quartileCounts[1] > 0,
    quartileCounts[2] > 0,
    quartileCounts[3] > 0,
  ];

  const avgAttention =
    final.length > 0
      ? final.reduce((sum, m) => sum + (m.attentionScore ?? 0.5), 0) / final.length
      : 0;

  const provenanceCounts: Record<MomentProvenance, number> = {
    user: 0,
    event: 0,
    cv: 0,
    ai: 0,
    "ai-override": 0,
  };
  for (const m of final) provenanceCounts[provenanceOf(m)]++;

  // Cap the flat rejected pool — only what's worth surfacing in the debug
  // overlay. The full set still lives in `rawMoments` via `rejected: true`.
  const rejectedPool = rejectedAll.slice(0, REJECTED_POOL_CAP);

  return {
    moments: final,
    rejectedPool,
    stats: {
      inputCount: input.raw.length,
      keptCount: final.length,
      duration,
      quartileCoverage,
      densityPerMin: minutes > 0 ? final.length / minutes : 0,
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
      focusRefinedCount,
      cvCandidatesAdded,
      provenanceCounts,
      quotaDropped,
      eventOverlapsResolved: overlapResolved.eventOverlapsResolved,
      aiRejectedBoring: rejectPass.stats.aiRejectedBoring,
      aiRejectedIdle: rejectPass.stats.aiRejectedIdle,
      aiRejectedNoTarget: rejectPass.stats.aiRejectedNoTarget,
      sceneChangeNudged,
      quartileLeftEmpty,
      eventStats: {
        eventCandidatesIn,
        eventDroppedByOverlap: overlapResolved.eventsDropped,
        eventDroppedTooClose,
        eventDroppedTooManyZooms,
        eventDroppedTooDense,
        eventKept: provenanceCounts.event,
      },
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
    cut: 0,
    crop: 0,
    captions: 0,
    "hook-text": 0,
    "text-overlay": 0,
    "smart-crop": 0,
    callout: 0,
    "blur-redaction": 0,
    transition: 0,
    "branding-cta": 0,
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
