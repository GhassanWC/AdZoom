/**
 * The AI Editor — editorial decision engine for NORMAL analysis runs.
 *
 * Sits between understanding and the final timeline:
 *
 *     understanding (CV + audio + transcript + narrative + attention)
 *       → candidate edits (per-chunk engines + balancer + gap-fills)
 *       → THIS STAGE — should each edit exist at all?
 *       → timeline
 *
 * Everything upstream asks "what could we emphasise here?" and answers it
 * inside a single 30-second window. Nothing asked whether the resulting
 * timeline is one a professional editor would sign off on. That is why edits
 * felt random: every candidate any engine emitted shipped, because progressive
 * moments enter the balancer as `preserved` and bypass its entire selection
 * pass (see `timeline-balancer.ts` — `kept` starts full, so the greedy loop
 * never runs), and anything dropped anyway is restored by the finalize
 * protection guard.
 *
 * This module is the missing judgment. For every candidate it asks what a
 * human editor asks:
 *
 *   1. Does this edit improve the viewer's experience, or is it filler?
 *   2. Does it make the message clearer or more engaging?
 *   3. Is this the best edit for this moment — or is NO edit better?
 *   4. Does it fit the edits immediately before and after it?
 *   5. Will it distract rather than help?
 *
 * An edit that cannot answer all five is DROPPED. "No edit" is a common and
 * correct outcome — nothing here forces a minimum count, and the engine will
 * happily return far fewer edits than it was given.
 *
 * Judgment is made across the WHOLE video, never per chunk: spacing, rhythm,
 * density and the intro→CTA distribution are all evaluated against the full
 * timeline, which is precisely what the per-chunk engines structurally cannot
 * do.
 *
 * Every survivor carries an internal `justification` (why it earned its place)
 * and an `editorialReason` (the specific sentence behind that verdict). If a
 * justification cannot be derived, the edit is not created.
 *
 * Pure. No I/O — every signal arrives via `EditorialContext`, so this is
 * directly unit-testable and identical on client and server.
 */
import {
  DIRECTOR_JUSTIFICATIONS,
  type DirectorJustification,
} from "../director/types";
import type {
  DetectedMoment,
  EffectType,
  NarrativeRole,
  NarrativeSegment,
  Pacing,
  VideoType,
} from "../firebase/schema";
import { PACING_PROFILES } from "../timeline-balancer";
import { CLASSIC_DECISION, VIDEO_TYPE_BIAS } from "../editorial/constants";
import {
  categoryForEffectType,
  statusAllowsGeneration,
  type DecisionPolicy,
} from "../editorial/policy";
import { classicDecisionPolicy } from "../editorial/resolve";

/**
 * One shared vocabulary with the Director's own judgment stage
 * (`director/editorial-judgment.ts`). An edit's "why" means the same thing
 * whether a user brief produced it or this engine did — two enums for one
 * concept would drift apart within a release.
 */
export type EditorialJustification = DirectorJustification;
export const EDITORIAL_JUSTIFICATIONS = DIRECTOR_JUSTIFICATIONS;

// ── Bars ────────────────────────────────────────────────────────────────────
// The VALUES live in src/lib/editorial/constants.ts (the single owner of every
// editorial number — see tests/editorial-ownership.test.ts). The names below
// are kept so the judgment code reads as before; anything a TEMPLATE may vary
// is read off the run's DecisionPolicy instead (see `decideTimeline`).

/** A reason shorter than this reads as a placeholder, not a justification. */
const MIN_REASON_LENGTH = CLASSIC_DECISION.minReasonLength;
/** How close a click / scene change must be to count as grounding an edit. */
const GROUNDING_WINDOW_S = CLASSIC_DECISION.groundingWindowS;

/**
 * Attention is judged RELATIVE to the video's own curve, never against an
 * absolute number.
 *
 * The CV attention curve's dynamic range depends entirely on content: a real
 * talking-head video measured min 0.024 / median 0.039 / max 0.192, so an
 * absolute "flat below 0.18" threshold classified 99% of it as dead air and
 * dropped every single camera edit. A screen recording of the same length
 * spans nearly the full 0..1. The only portable question is "is this moment
 * quiet *for this video*", so these are percentiles of the curve.
 */
const FLAT_PERCENTILE = CLASSIC_DECISION.flatPercentile;
const PEAK_PERCENTILE = CLASSIC_DECISION.peakPercentile;
/**
 * A curve flatter than this carries no information — every moment looks like
 * every other. Attention then abstains entirely rather than voting: a signal
 * that cannot discriminate must never be the thing that vetoes an edit.
 */
const MIN_ATTENTION_RANGE = CLASSIC_DECISION.minAttentionRange;

/**
 * The edit types this engine judges: the camera + pacing edits the per-chunk
 * engines emit, which are the ones that read as random when over-applied.
 *
 * Deliberately NOT judged: captions (decoupled from analysis by contract),
 * and the structural overlays — hook text, CTA, text overlays, callouts,
 * transitions, smart crop. Those are generated downstream of this stage from
 * explicit user toggles, so the user's request IS their justification; judging
 * them here would second-guess a switch the user just flipped.
 */
const JUDGED_TYPES: ReadonlySet<EffectType> = new Set<EffectType>([
  "zoom",
  "click-highlight",
  "cursor-focus",
  "speed-up",
  "cut",
]);

/**
 * Edits that earn their place by pointing at ACTIVITY — a click, a scene
 * change, motion, a spike in attention.
 */
const ATTENTION_TYPES: ReadonlySet<EffectType> = new Set<EffectType>([
  "zoom",
  "click-highlight",
  "cursor-focus",
]);

/**
 * Edits that earn their place by removing DEADNESS. Their grounding is the
 * inverse of the attention family: a cut over a silent, static stretch is
 * exactly right, and must never be dropped for sitting in a boring section —
 * that section is the whole reason it exists.
 */
const PACING_TYPES: ReadonlySet<EffectType> = new Set<EffectType>([
  "cut",
  "speed-up",
]);

/** The "why" a human editor would give for keeping each kind of edit. */
const JUSTIFICATION_BY_TYPE: Partial<Record<EffectType, EditorialJustification>> = {
  zoom: "emphasis",
  "click-highlight": "action",
  "cursor-focus": "attention",
  "speed-up": "pacing",
  cut: "pacing",
};

/**
 * How much each narrative beat deserves emphasis. Mirrors the weighting the
 * Director's context builder already uses, so both engines agree about which
 * parts of a video matter.
 */
const NARRATIVE_WEIGHT: Record<NarrativeRole, number> = {
  result: 0.95,
  action: 0.9,
  explanation: 0.6,
  intro: 0.55,
  setup: 0.5,
  transition: 0.4,
  filler: 0.2,
};

// (The video-type bias table now lives in src/lib/editorial/constants.ts —
// one definition shared with the balancer instead of a mirrored copy.)

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface TimeSpan {
  startTime: number;
  endTime: number;
}

/**
 * Everything the engine needs to judge, supplied by the caller. All optional
 * except duration + pacing: a video with no transcript, no narrative and no
 * attention curve still gets judged, just on fewer signals.
 */
export interface EditorialContext {
  duration: number;
  pacing: Pacing;
  videoType?: VideoType;
  /** Gemini's narrative beats — drives per-section balance + role weighting. */
  narrativeStructure?: NarrativeSegment[];
  /** Stretches Gemini flagged as boring. */
  boringSections?: TimeSpan[];
  /** Whole-video attention, 8-bit (0..255). NOT the per-chunk normalized one. */
  attentionCurve?: number[];
  /** Samples per second for `attentionCurve`. */
  attentionSampleRate?: number;
  /** Scene-change timestamps (seconds). */
  sceneChanges?: number[];
  /** Real + inferred click timestamps (seconds). */
  clickTimes?: number[];
  /** Silent stretches — grounding for pacing edits, a red flag for zooms. */
  silenceSegments?: TimeSpan[];
  /**
   * The run's editorial policy (Editorial Engine Phase 1). ABSENT ⇒ the
   * Classic bars — exactly the engine's pre-policy behaviour, which is what
   * every existing caller and test gets. A template supplies per-type
   * statuses, confidence bars, budgets and spacing through this.
   */
  policy?: DecisionPolicy;
}

/**
 * Whole-video attention at `t` as 0..1, or undefined when there's no curve.
 * Exported so callers (the analyze route) can hand the same number to the
 * semantic pass that the deterministic pass scored against — two different
 * attention values for one timestamp would make the two stages disagree.
 */
export function attentionValueAt(
  curveQ8: number[] | undefined,
  sampleRate: number | undefined,
  t: number
): number | undefined {
  const v = attentionAt(
    { duration: 0, pacing: "moderate", attentionCurve: curveQ8, attentionSampleRate: sampleRate },
    t
  );
  return v ?? undefined;
}

/** Narrow a model-supplied string to the justification vocabulary. */
export function isEditorialJustification(
  value: unknown
): value is EditorialJustification {
  return (
    typeof value === "string" &&
    (EDITORIAL_JUSTIFICATIONS as readonly string[]).includes(value)
  );
}

export interface EditorialVerdict {
  id: string;
  keep: boolean;
  justification?: EditorialJustification;
  /** The specific sentence behind the verdict — internal, always present. */
  reason: string;
  score: number;
}

export interface EditorialDecisionResult {
  /** Survivors, stamped with `justification` + `editorialReason`. */
  kept: DetectedMoment[];
  /** Rejects, stamped `rejected: true` + `rejectedReason` — recoverable. */
  rejected: DetectedMoment[];
  verdicts: EditorialVerdict[];
  log: {
    candidates: number;
    judged: number;
    protectedPassThrough: number;
    keptCount: number;
    /** The ceiling that applied — NOT a goal the run tried to reach. */
    maxEdits: number;
    droppedUnjustified: number;
    droppedCrowding: number;
    droppedRhythm: number;
    droppedBudget: number;
    /** Per narrative section (or quartile): how many edits landed there. */
    distribution: Array<{ label: string; kept: number; cap: number }>;
  };
}

// ── Signal helpers ──────────────────────────────────────────────────────────

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function within(spans: TimeSpan[] | undefined, t: number): boolean {
  if (!spans?.length) return false;
  return spans.some((s) => t >= s.startTime && t < s.endTime);
}

function nearest(times: number[] | undefined, t: number): number {
  if (!times?.length) return Infinity;
  let best = Infinity;
  for (const x of times) best = Math.min(best, Math.abs(x - t));
  return best;
}

/** Whole-video attention at `t`, 0..1. Returns null when no curve is available. */
function attentionAt(ctx: EditorialContext, t: number): number | null {
  const curve = ctx.attentionCurve;
  if (!curve?.length) return null;
  const rate = ctx.attentionSampleRate && ctx.attentionSampleRate > 0 ? ctx.attentionSampleRate : 1;
  const i = Math.round(t * rate);
  if (i < 0 || i >= curve.length) return null;
  return clamp01((curve[i] ?? 0) / 255);
}

/**
 * The video's own attention profile. Computed once per run so every judgment
 * asks "quiet for THIS video?" instead of comparing against a constant that
 * only holds for one kind of content.
 */
interface AttentionStats {
  /** False when the curve is missing or too flat to tell moments apart. */
  discriminating: boolean;
  /** Below this, a moment is quiet for this video. */
  flat: number;
  /** At or above this, a moment is a peak for this video. */
  peak: number;
  min: number;
  max: number;
}

export function attentionStats(ctx: EditorialContext): AttentionStats {
  const curve = ctx.attentionCurve;
  const none: AttentionStats = {
    discriminating: false,
    flat: 0,
    peak: 1,
    min: 0,
    max: 1,
  };
  if (!curve?.length) return none;
  const vals = curve.map((v) => clamp01(v / 255)).sort((a, b) => a - b);
  const at = (f: number) => vals[Math.floor(f * (vals.length - 1))] ?? 0;
  const min = vals[0] ?? 0;
  const max = vals[vals.length - 1] ?? 0;
  if (max - min < MIN_ATTENTION_RANGE) return { ...none, min, max };
  return {
    discriminating: true,
    flat: at(FLAT_PERCENTILE),
    peak: at(PEAK_PERCENTILE),
    min,
    max,
  };
}

/** Where `t` sits in this video's attention range, 0..1. 0.5 when unknown. */
function relativeAttention(
  ctx: EditorialContext,
  stats: AttentionStats,
  t: number
): number {
  const att = attentionAt(ctx, t);
  if (att === null || !stats.discriminating) return 0.5;
  return clamp01((att - stats.min) / Math.max(1e-6, stats.max - stats.min));
}

function narrativeAt(ctx: EditorialContext, t: number): NarrativeSegment | null {
  return ctx.narrativeStructure?.find((s) => t >= s.startTime && t < s.endTime) ?? null;
}

function roleWeight(ctx: EditorialContext, t: number): number {
  const seg = narrativeAt(ctx, t);
  // No narrative structure → neutral, so a video Gemini couldn't classify isn't
  // penalised into having no edits at all.
  return seg ? NARRATIVE_WEIGHT[seg.role] : 0.6;
}

const typeOf = (m: DetectedMoment): EffectType => (m.effectType ?? "zoom") as EffectType;
const startOf = (m: DetectedMoment) => Number(m.startTime) || 0;
const confOf = (m: DetectedMoment) => clamp01(Number(m.confidenceScore ?? 0.45));

/** A reason that's just the edit type restated ("Zoom.", "Cut") isn't one. */
function isTrivialReason(reason: string | undefined): boolean {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < MIN_REASON_LENGTH) return true;
  return /^(zoom|callout|cuts?|edit|speed([ -]?up)?|transition|text([ -]?overlay)?|captions?|hook|cta|moment)s?\.?$/i.test(
    trimmed
  );
}

// ── Q1/Q2/Q5 — does this single edit earn its place? ────────────────────────

interface Grounding {
  /** 0..1 — how strongly the footage supports this edit existing. */
  strength: number;
  /** What grounded it, for the internal reason. */
  evidence: string | null;
}

/**
 * Grounding is type-aware and deliberately asymmetric.
 *
 * An attention edit (zoom / highlight / cursor-focus) must point at something
 * HAPPENING — a click, a scene change, a spike in attention. A pacing edit
 * (cut / speed-up) earns its place by removing something DEAD — silence, a
 * flat attention stretch, a section Gemini called boring. Judging both against
 * "is there activity here?" would delete exactly the cuts that are working.
 */
function groundingFor(
  m: DetectedMoment,
  ctx: EditorialContext,
  stats: AttentionStats
): Grounding {
  const t = startOf(m);
  const type = typeOf(m);
  const att = attentionAt(ctx, t);
  const isFlat = stats.discriminating && att !== null && att <= stats.flat;
  const isPeak = stats.discriminating && att !== null && att >= stats.peak;

  if (PACING_TYPES.has(type)) {
    if (within(ctx.boringSections, t)) {
      return { strength: 0.95, evidence: "a stretch flagged as boring" };
    }
    if (within(ctx.silenceSegments, t)) {
      return { strength: 0.85, evidence: "a silent stretch" };
    }
    if (isFlat) {
      return { strength: 0.7, evidence: `one of this video's quietest stretches` };
    }
    // A cut over genuinely busy footage is the editor cutting away from the
    // thing the viewer came to see.
    if (isPeak) return { strength: 0, evidence: null };
    return { strength: 0.45, evidence: "a low-activity stretch" };
  }

  // Attention family.
  const clickGap = nearest(ctx.clickTimes, t);
  if (clickGap <= GROUNDING_WINDOW_S) {
    return { strength: 1, evidence: `a click ${clickGap.toFixed(2)}s away` };
  }
  const sceneGap = nearest(ctx.sceneChanges, t);
  if (sceneGap <= GROUNDING_WINDOW_S) {
    return { strength: 0.8, evidence: `a scene change ${sceneGap.toFixed(2)}s away` };
  }
  if (isPeak) {
    return {
      strength: 0.65,
      evidence: `a peak in viewer attention for this video (${att!.toFixed(3)})`,
    };
  }
  // A real click stream produced this even if the timestamps drifted apart.
  if (m.provenance === "event") {
    return { strength: 0.6, evidence: "a recorded interaction" };
  }
  if (m.targetRegionSource && m.targetRegionSource !== "default") {
    return { strength: 0.4, evidence: "a located on-screen target" };
  }
  return { strength: 0, evidence: null };
}

/**
 * Would this edit distract more than it helps? Returns the objection, or null.
 *
 * Note what is NOT here: a bare "attention is low" veto. Quietness alone is a
 * weak signal — it costs the candidate score (see `scoreOf`) rather than
 * disqualifying it, because on low-motion footage every moment is quiet and a
 * hard veto would empty the timeline. An edit is only called distracting when
 * something positively says the viewer has no reason to look: a section Gemini
 * flagged boring, a filler beat, or the quietest band of a video that HAS
 * meaningful variation to compare against.
 */
function distraction(
  m: DetectedMoment,
  ctx: EditorialContext,
  stats: AttentionStats
): string | null {
  const t = startOf(m);
  const type = typeOf(m);
  if (!ATTENTION_TYPES.has(type)) return null;

  if (within(ctx.boringSections, t)) {
    return "it emphasises a stretch the viewer has no reason to look at";
  }
  const seg = narrativeAt(ctx, t);
  if (seg?.role === "filler") {
    return "it lands in a filler beat, where an edit reads as fidgeting";
  }
  // Bottom band of a video with real variation, AND nothing else vouching for
  // the moment — a scene change or a click outranks a quiet curve.
  if (stats.discriminating) {
    const att = attentionAt(ctx, t);
    const vouched =
      nearest(ctx.clickTimes, t) <= GROUNDING_WINDOW_S ||
      nearest(ctx.sceneChanges, t) <= GROUNDING_WINDOW_S;
    if (att !== null && att <= stats.flat && !vouched) {
      return `this is among the quietest moments in the video and nothing else marks it out — moving the camera would only pull focus`;
    }
  }
  return null;
}

/** Score a surviving candidate. Higher = more deserving of a slot. */
function scoreOf(
  m: DetectedMoment,
  ctx: EditorialContext,
  grounding: Grounding,
  stats: AttentionStats
): number {
  const t = startOf(m);
  // Relative, not raw: on a talking-head video every raw value is ~0.03, which
  // would make this term a constant and stop it discriminating at all.
  const attentionTerm = relativeAttention(ctx, stats, t);
  const provBoost =
    m.provenance === "event" ? 0.15 : m.provenance === "cv" ? 0.05 : 0;
  return (
    0.34 * attentionTerm +
    0.24 * confOf(m) +
    0.22 * grounding.strength +
    0.2 * roleWeight(ctx, t) +
    provBoost
  );
}

// ── Budget — the density decision ───────────────────────────────────────────

const policyOf = (ctx: EditorialContext): DecisionPolicy =>
  ctx.policy ?? classicDecisionPolicy();

/**
 * The MOST edits this video may carry. A ceiling, never a target and never a
 * floor.
 *
 * Nothing in this engine tries to reach this number: the pipeline only ever
 * drops, so a video whose footage justifies three edits gets three, and one
 * that justifies none gets none. The ceiling exists solely to stop a busy
 * recording from shipping forty defensible-in-isolation edits that together
 * read as noise.
 *
 * Derived from the pacing model the balancer already defines (`PACING_PROFILES`
 * + duration brackets + video-type bias), taking the SMALLEST of its ceilings —
 * including the model's own suggested density, used here as a cap rather than
 * as something to hit. The balancer's floors (`minPerMin`, the bracket minimums,
 * a global MIN_MOMENTS) are deliberately NOT applied: a floor would either pad
 * the timeline or, worse, quietly raise this ceiling on a calm video.
 */
export function editorialMaxEdits(ctx: EditorialContext): number {
  const policy = policyOf(ctx);
  const profile = PACING_PROFILES[ctx.pacing] ?? PACING_PROFILES.moderate;
  const bias = VIDEO_TYPE_BIAS[ctx.videoType ?? "mixed"] ?? VIDEO_TYPE_BIAS.mixed;
  const minutes = Math.max(ctx.duration / 60, 0.5);
  const bucketMax = policy.bucketMax(ctx.duration);
  return Math.max(
    1,
    Math.min(
      policy.maxMoments,
      // A template's own total ceiling (absent on Classic).
      policy.maxEditsOverride ?? Number.POSITIVE_INFINITY,
      bucketMax,
      // Hard anti-spam rate.
      Math.ceil(minutes * profile.maxPerMin),
      // The pacing model's suggested density — a cap here, not a goal.
      Math.round(minutes * profile.ratePerMin * bias.rateMult)
    )
  );
}

function minSpacingFor(ctx: EditorialContext): number {
  const policy = policyOf(ctx);
  if (typeof policy.minSpacingS === "number") return policy.minSpacingS;
  const profile = PACING_PROFILES[ctx.pacing] ?? PACING_PROFILES.moderate;
  const bias = VIDEO_TYPE_BIAS[ctx.videoType ?? "mixed"] ?? VIDEO_TYPE_BIAS.mixed;
  return profile.minSpacing * bias.spacingMult;
}

/**
 * The video's beats, as budget buckets. Uses Gemini's narrative structure when
 * present so the intro→CTA arc is respected; falls back to quartiles so a video
 * with no classification still gets an even spread instead of every edit
 * clustering in whichever act happened to be busiest.
 */
function budgetSections(
  ctx: EditorialContext,
  maxEdits: number
): Array<{ id: number; label: string; startTime: number; endTime: number; cap: number }> {
  const segs: Array<{ label: string; startTime: number; endTime: number; weight: number }> =
    ctx.narrativeStructure?.length
      ? ctx.narrativeStructure.map((s) => ({
          label: s.role,
          startTime: s.startTime,
          endTime: s.endTime,
          // Duration AND role: a long filler stretch shouldn't claim slots a
          // short result beat deserves.
          weight: Math.max(0.01, (s.endTime - s.startTime) * NARRATIVE_WEIGHT[s.role]),
        }))
      : Array.from({ length: 4 }, (_, i) => ({
          label: `Q${i + 1}`,
          startTime: (i * ctx.duration) / 4,
          endTime: ((i + 1) * ctx.duration) / 4,
          weight: 1,
        }));

  const totalWeight = segs.reduce((n, s) => n + s.weight, 0) || 1;
  return segs.map((s, i) => ({
    // Identity, NOT the label: narrative roles repeat (a video routinely has
    // three "explanation" beats), and keying the budget by label made them
    // share one counter — which broke the per-section cap and defeated the
    // spread this exists to produce.
    id: i,
    label: s.label,
    startTime: s.startTime,
    endTime: s.endTime,
    // A per-section CEILING, so one busy stretch can't spend the whole budget
    // and leave the rest of the video bare. It never requires a section to
    // contain anything — an empty section is a perfectly good outcome. The +1
    // slack keeps rounding from locking a section out entirely.
    cap: Math.max(1, Math.round((s.weight / totalWeight) * maxEdits) + 1),
  }));
}

// ── The engine ──────────────────────────────────────────────────────────────

/**
 * Judge a whole-video candidate set.
 *
 * Order matters: per-edit justification first (cheap, removes the indefensible),
 * then same-beat competition, then whole-video rhythm + budget. Running rhythm
 * before justification would let a well-spaced but baseless edit block a
 * grounded one.
 */
export function decideTimeline(
  candidates: DetectedMoment[],
  ctx: EditorialContext
): EditorialDecisionResult {
  const verdicts: EditorialVerdict[] = [];
  const rejected: DetectedMoment[] = [];
  // The run's policy — Classic bars when absent, so pre-policy callers and
  // fixtures behave identically (tests/classic-parity.test.ts pins this).
  const policy = policyOf(ctx);
  // Computed once: every attention judgment below is relative to this profile.
  const stats = attentionStats(ctx);

  const reject = (m: DetectedMoment, tag: string, reason: string) => {
    verdicts.push({ id: m.id, keep: false, reason, score: 0 });
    rejected.push({ ...m, rejected: true, rejectedReason: tag, editorialReason: reason });
  };

  // ── 0. Partition ─────────────────────────────────────────────────────────
  // A user's own edit, a Director-planned edit (already judged by the
  // Director's own engine) and every non-judged type pass through untouched.
  // This engine never overrules a human or double-judges another judge.
  const judged: DetectedMoment[] = [];
  const passThrough: DetectedMoment[] = [];
  for (const m of candidates) {
    const isUser = m.provenance === "user";
    const isDirector = m.director != null || m.source === "ai-director";
    if (isUser || isDirector || !JUDGED_TYPES.has(typeOf(m))) passThrough.push(m);
    else judged.push(m);
  }

  // ── 1. Per-edit justification (Q1, Q2, Q5) ───────────────────────────────
  interface Scored {
    moment: DetectedMoment;
    score: number;
    justification: EditorialJustification;
    reason: string;
  }
  const survivors: Scored[] = [];
  let droppedUnjustified = 0;

  for (const m of judged) {
    const type = typeOf(m);
    const category = categoryForEffectType(type);
    const typePolicy = policy.perType[category];

    // Gate A/B — the template's stance on this edit type. Classic policies
    // have `strictTypes: false` and an empty perType map, so nothing changes
    // for them; an enforce template rejects types it doesn't use (this is how
    // "no cursor emphasis on a Clean Professional talking head" is enforced).
    if (
      (policy.strictTypes && !typePolicy) ||
      (typePolicy && !statusAllowsGeneration(typePolicy.status))
    ) {
      droppedUnjustified++;
      reject(
        m,
        "policy-forbidden",
        `This editing style doesn't use ${category.replace(/_/g, " ")} edits — dropped by the template's editorial policy.`
      );
      continue;
    }

    if (isTrivialReason(m.reason)) {
      droppedUnjustified++;
      reject(
        m,
        "no-justification",
        `No real justification for this ${type} — an edit that can't be explained isn't one a professional editor would make.`
      );
      continue;
    }

    const conf = confOf(m);
    const confBar = typePolicy?.minConfidence ?? policy.minConfidence;
    if (conf < confBar) {
      droppedUnjustified++;
      reject(
        m,
        "low-confidence",
        typePolicy?.minConfidence !== undefined
          ? `Confidence (${conf.toFixed(2)}) is below this template's ${confBar.toFixed(2)} bar for a ${type}. No edit beats a guess.`
          : `Confidence (${conf.toFixed(2)}) is too low to put this ${type} in front of a viewer. No edit beats a guess.`
      );
      continue;
    }

    const grounding = groundingFor(m, ctx, stats);
    if (grounding.strength <= 0 || !grounding.evidence) {
      droppedUnjustified++;
      reject(
        m,
        "not-grounded",
        `Nothing in the video grounds this ${type} — an edit with no evidence behind it is a guess, not a decision.`
      );
      continue;
    }

    const objection = distraction(m, ctx, stats);
    if (objection) {
      droppedUnjustified++;
      reject(m, "distracting", `Dropped this ${type} because ${objection}.`);
      continue;
    }

    const justification = JUSTIFICATION_BY_TYPE[type];
    if (!justification) {
      // Per the contract: no derivable "why" ⇒ no edit.
      droppedUnjustified++;
      reject(
        m,
        "no-justification",
        `No editorial purpose could be derived for a ${type} here, so it was not created.`
      );
      continue;
    }

    survivors.push({
      moment: m,
      score: scoreOf(m, ctx, grounding, stats),
      justification,
      reason: `Kept for ${justification} — grounded in ${grounding.evidence}.`,
    });
  }

  // ── 2. Same-beat competition (Q3: best edit here, or none?) ──────────────
  // Two edits fighting over one moment is worse than either alone. Keep the
  // strongest; the loser is dropped, not weakened.
  survivors.sort((a, b) => startOf(a.moment) - startOf(b.moment));
  const afterCrowding: Scored[] = [];
  let droppedCrowding = 0;
  for (const cand of survivors) {
    const prev = afterCrowding[afterCrowding.length - 1];
    if (prev && startOf(cand.moment) - startOf(prev.moment) < policy.crowdWindowS) {
      const [win, lose] = cand.score > prev.score ? [cand, prev] : [prev, cand];
      if (win === cand) afterCrowding[afterCrowding.length - 1] = cand;
      droppedCrowding++;
      reject(
        lose.moment,
        "crowded",
        `Crowds a stronger ${typeOf(win.moment)} within ${policy.crowdWindowS}s — one intentional edit beats two competing for the same moment.`
      );
      continue;
    }
    afterCrowding.push(cand);
  }

  // ── 3+4. Whole-video rhythm + budget (Q4) ────────────────────────────────
  // Greedy by score so the best edits claim their slots first, then each
  // candidate must also FIT: honour spacing, don't stack the same effect, and
  // stay inside both the global budget and its own narrative section's share.
  const maxEdits = editorialMaxEdits(ctx);
  const minSpacing = minSpacingFor(ctx);
  const profile = PACING_PROFILES[ctx.pacing] ?? PACING_PROFILES.moderate;
  const zoomCooldown = policy.zoomCooldownS ?? profile.zoomCooldown;
  const sections = budgetSections(ctx, maxEdits);
  const sectionCounts = new Map<number, number>();
  // Per-category accounting for the template's own budgets (Classic: no-ops).
  const minutes = Math.max(ctx.duration / 60, 0.5);
  const categoryCounts = new Map<string, number>();

  // Variety is only a meaningful requirement when the video HAS more than one
  // kind of edit. See the streak rule below.
  const poolHasVariety = new Set(afterCrowding.map((c) => typeOf(c.moment))).size > 1;
  const byScore = [...afterCrowding].sort((a, b) => b.score - a.score);
  const accepted: Scored[] = [];
  let droppedRhythm = 0;
  let droppedBudget = 0;

  const sectionFor = (t: number) =>
    sections.find((s) => t >= s.startTime && t < s.endTime) ?? sections[sections.length - 1];

  for (const cand of byScore) {
    const t = startOf(cand.moment);
    const type = typeOf(cand.moment);

    if (accepted.length >= maxEdits) {
      droppedBudget++;
      reject(
        cand.moment,
        "over-budget",
        `At the ceiling of ${maxEdits} edits for a ${ctx.pacing}-paced ${Math.round(ctx.duration)}s video — this one scored below the edits that earned the slots.`
      );
      continue;
    }

    const neighbours = accepted.filter((a) => Math.abs(startOf(a.moment) - t) < minSpacing);
    if (neighbours.length > 0) {
      droppedRhythm++;
      reject(
        cand.moment,
        "too-close",
        `Lands within ${minSpacing.toFixed(1)}s of an edit that's already carrying this beat — back-to-back edits read as restlessness, not intent.`
      );
      continue;
    }

    // Zoom-on-zoom needs more room than the generic spacing: a cluster of
    // zooms reads as a twitch even when each one is individually defensible.
    if (ATTENTION_TYPES.has(type)) {
      const tooSoon = accepted.some(
        (a) =>
          ATTENTION_TYPES.has(typeOf(a.moment)) &&
          Math.abs(startOf(a.moment) - t) < zoomCooldown
      );
      if (tooSoon) {
        droppedRhythm++;
        reject(
          cand.moment,
          "zoom-cooldown",
          `Another camera move happens within ${zoomCooldown}s — letting the shot settle reads as more deliberate than moving again.`
        );
        continue;
      }
    }

    // The template's own per-type budget + spacing (Classic has none).
    const candCategory = categoryForEffectType(type);
    const candPolicy = policy.perType[candCategory];
    if (candPolicy) {
      const catUsed = categoryCounts.get(candCategory) ?? 0;
      const perMinuteCap =
        typeof candPolicy.maxPerMinute === "number"
          ? Math.max(1, Math.floor(minutes * candPolicy.maxPerMinute))
          : Number.POSITIVE_INFINITY;
      const cap = Math.min(perMinuteCap, candPolicy.maxTotal ?? Number.POSITIVE_INFINITY);
      if (catUsed >= cap) {
        droppedBudget++;
        reject(
          cand.moment,
          "type-budget",
          `This editing style carries at most ${cap} ${candCategory.replace(/_/g, " ")} edit${cap === 1 ? "" : "s"} for a video this length — this one scored below the ones that earned the slots.`
        );
        continue;
      }
      if (typeof candPolicy.minSpacingSec === "number") {
        const tooCloseSameType = accepted.some(
          (a) =>
            categoryForEffectType(typeOf(a.moment)) === candCategory &&
            Math.abs(startOf(a.moment) - t) < candPolicy.minSpacingSec!
        );
        if (tooCloseSameType) {
          droppedRhythm++;
          reject(
            cand.moment,
            "type-spacing",
            `This editing style keeps ${candCategory.replace(/_/g, " ")} edits at least ${candPolicy.minSpacingSec}s apart — restraint is what makes each one land.`
          );
          continue;
        }
      }
    }

    const sec = sectionFor(t);
    const used = sectionCounts.get(sec.id) ?? 0;
    if (used >= sec.cap) {
      droppedBudget++;
      reject(
        cand.moment,
        "section-full",
        `The "${sec.label}" section already carries its share of the edits — spreading them evenly from the intro through to the end keeps the video feeling consistent rather than front-loaded.`
      );
      continue;
    }

    // Same effect several times running reads as a tic rather than a style —
    // but ONLY when the video actually has another kind of edit to reach for.
    // A screen recording is legitimately almost all zooms; demanding variety
    // there would delete the video rather than improve it. Measured against the
    // candidate's immediate temporal PREDECESSORS, not the last few accepted:
    // the loop accepts by score, so "most recently accepted" says nothing about
    // what sits next to this edit on the timeline.
    if (poolHasVariety) {
      const preceding = accepted
        .filter((a) => startOf(a.moment) < t)
        .sort((a, b) => startOf(b.moment) - startOf(a.moment))
        .slice(0, policy.sameTypeStreakMax);
      if (
        preceding.length === policy.sameTypeStreakMax &&
        preceding.every((a) => typeOf(a.moment) === type)
      ) {
        droppedRhythm++;
        reject(
          cand.moment,
          "same-type-streak",
          `Would be the ${policy.sameTypeStreakMax + 1}th ${type} in a row — varying the edit keeps the pass feeling intentional.`
        );
        continue;
      }
    }

    accepted.push(cand);
    sectionCounts.set(sec.id, used + 1);
    categoryCounts.set(candCategory, (categoryCounts.get(candCategory) ?? 0) + 1);
  }

  // ── 5. Stamp survivors ───────────────────────────────────────────────────
  const kept: DetectedMoment[] = accepted.map((a) => {
    verdicts.push({
      id: a.moment.id,
      keep: true,
      justification: a.justification,
      reason: a.reason,
      score: a.score,
    });
    return {
      ...a.moment,
      justification: a.justification,
      editorialReason: a.reason,
      // A survivor can't stay flagged from a previous run's rejection.
      rejected: false,
    };
  });

  const finalKept = [...passThrough, ...kept].sort((a, b) => startOf(a) - startOf(b));

  return {
    kept: finalKept,
    rejected,
    verdicts,
    log: {
      candidates: candidates.length,
      judged: judged.length,
      protectedPassThrough: passThrough.length,
      keptCount: finalKept.length,
      maxEdits,
      droppedUnjustified,
      droppedCrowding,
      droppedRhythm,
      droppedBudget,
      distribution: sections.map((s) => ({
        label: `${s.label}@${Math.round(s.startTime)}s`,
        kept: sectionCounts.get(s.id) ?? 0,
        cap: s.cap,
      })),
    },
  };
}
