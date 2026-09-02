/**
 * THE single owner of Framevo's editorial numbers.
 *
 * Phase 1 of the Editorial Engine (see the approved architecture): every
 * constant that expresses an EDITORIAL judgment — confidence bars, spacing,
 * budgets, pacing tables, minimums — lives here and is consumed by the engines
 * through a policy object. Before this module the same numbers lived in four
 * files with drifting values (zoom spacing was 2.0s in the Gemini prompt, 2.5s
 * in the Director planner and 1.5s in the Director review; zoom budgets had
 * three uncoordinated systems). `tests/editorial-ownership.test.ts` enforces
 * that they never move back.
 *
 * Values here are EXACTLY the pre-Editorial-Engine shipping values — the
 * "Classic" behaviour. Templates express deltas from these; the Classic
 * templates use them verbatim, which is what `tests/classic-parity.test.ts`
 * proves.
 *
 * Pure data + types. No React, no Firebase, no I/O — loadable under
 * `node --test` from both the client and the analyze route.
 */
import type { Pacing, VideoType } from "@/lib/firebase/schema";

// ── Pacing model (moved verbatim from timeline-balancer.ts) ─────────────────

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
 * Previously duplicated in timeline-balancer.ts AND editorial-decision.ts;
 * this is now the only definition.
 */
export const VIDEO_TYPE_BIAS: Record<VideoType, { rateMult: number; spacingMult: number }> = {
  "coding-tutorial": { rateMult: 0.85, spacingMult: 1.15 },
  "saas-demo": { rateMult: 1.0, spacingMult: 1.0 },
  "talking-tutorial": { rateMult: 0.75, spacingMult: 1.25 },
  presentation: { rateMult: 0.8, spacingMult: 1.2 },
  "vertical-short": { rateMult: 1.25, spacingMult: 0.8 },
  "onboarding-flow": { rateMult: 0.95, spacingMult: 1.05 },
  mixed: { rateMult: 1.0, spacingMult: 1.0 },
};

// ── The AI Editor's Classic bars (moved verbatim from editorial-decision.ts) ─

export const CLASSIC_DECISION = {
  /** Below this we aren't sure enough to put the edit in front of a viewer. */
  minConfidence: 0.35,
  /** A reason shorter than this reads as a placeholder, not a justification. */
  minReasonLength: 8,
  /** How close a click / scene change must be to count as grounding an edit. */
  groundingWindowS: 1.0,
  /** Two edits starting within this window are competing for the same beat. */
  crowdWindowS: 2,
  /** More than this many of the same effect in a row reads as a tic. */
  sameTypeStreakMax: 3,
  /** Global hard ceiling on judged edits. */
  maxMoments: 24,
  /** Duration-bracket ceilings: ≤30s → 6, ≤120s → 12, else 20. */
  bucketMax: (durationS: number): number =>
    durationS <= 30 ? 6 : durationS <= 120 ? 12 : 20,
  /** Attention percentiles (relative to the video's own curve). */
  flatPercentile: 0.35,
  peakPercentile: 0.7,
  minAttentionRange: 0.05,
} as const;

// ── The balancer's Classic floors (moved verbatim from timeline-balancer.ts) ─

export const CLASSIC_BALANCER = {
  /**
   * The historical global floor on selected moments. NOTE: this floor is what
   * forced edits onto videos that deserved none — the approved architecture
   * retires it via `density.minTotal = 0` on every non-Classic template. It
   * survives here ONLY so Classic reproduces shipped behaviour exactly.
   */
  minMoments: 3,
  maxMoments: 24,
} as const;

// ── The overlay generators' Classic caps (from overlay-generators.ts) ───────

export const CLASSIC_OVERLAYS = {
  /** Text labels: top N descriptive camera-moment labels. */
  textOverlayMax: 3,
  /** Callouts: top N grounded targets. */
  calloutMax: 4,
  /** Callouts: minimum confidence of the grounded target. */
  calloutMinConfidence: 0.55,
  /** Transitions: at most N, placed after active cuts resume. */
  transitionMax: 5,
} as const;

// ── The Director review's Classic composition backstops (from review.ts) ────

export const CLASSIC_ZOOM_COMPOSITION = {
  /** Zooms closer together than this read as a twitch rather than emphasis. */
  minGapSeconds: 1.5,
  /** More zooms per output minute than this is visual noise regardless of style. */
  maxPerOutputMinute: 10,
} as const;
