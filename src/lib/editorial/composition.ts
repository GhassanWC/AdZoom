/**
 * Gate D — timeline composition review.
 *
 * Individually valid edits can still compose an overcrowded, amateur timeline:
 * cross-type pileups, clusters, stacked emphasis, metronomic rhythm. Gates A–C
 * judge one edit at a time; this stage judges the ASSEMBLED timeline.
 *
 * ONE implementation, two call sites (per the approved architecture — no
 * duplicate systems):
 *   • the analyze route, after overlay generation, with the run's policy
 *     (`reviewComposition`) — a NO-OP when `composition.mode === "off"`,
 *     which is what every Classic template resolves to (clarification #3);
 *   • the Director review (`review.ts`), whose zoom-density rule now delegates
 *     to `zoomDensityPass` with its exact historical constants and scope.
 *
 * Philosophy inherited from the Director review: DISABLE rather than delete —
 * the user can flip any decision back on from the timeline — and report every
 * action with a reason.
 *
 * Pure. No I/O.
 */
import type { DetectedMoment, EffectType } from "@/lib/firebase/schema";
import { buildTimelineMap } from "@/lib/timeline/crop-speed";
import { categoryForEffectType, type ResolvedEditorialPolicy } from "./policy";

export interface CompositionAction {
  id: string;
  action: "disable";
  rule:
    | "zoom-density"
    | "cross-density"
    | "cluster"
    | "overlap-emphasis"
    | "per-type-budget";
  reason: string;
}

export interface CompositionReport {
  mode: "off" | "enforce";
  actions: CompositionAction[];
  /** Rule → how many edits it disabled. */
  counts: Partial<Record<CompositionAction["rule"], number>>;
}

const startOf = (m: DetectedMoment) => Number(m.startTime) || 0;
const confOf = (m: DetectedMoment) => Number(m.confidenceScore ?? 0);

/** The types that read as EMPHASIS — stacking them on one instant is noise. */
const EMPHASIS_TYPES: ReadonlySet<EffectType> = new Set<EffectType>([
  "zoom",
  "click-highlight",
  "cursor-focus",
  "callout",
  "text-overlay",
]);

/** Structural edits are rhythm itself — never composition-disabled. */
const STRUCTURAL_TYPES: ReadonlySet<EffectType> = new Set<EffectType>([
  "cut",
  "captions",
  "smart-crop",
  "crop",
]);

/** A moment Gate D may act on: AI-made, enabled, not structural. */
function reviewable(m: DetectedMoment): boolean {
  if (m.enabled === false) return false;
  if (m.source === "user" || m.provenance === "user") return false;
  if (STRUCTURAL_TYPES.has(m.effectType)) return false;
  return true;
}

// ── Zoom density (shared with the Director review) ──────────────────────────

export interface ZoomDensityConfig {
  /** Zooms closer together than this (end → next start) read as a twitch. */
  minGapSeconds: number;
  /** Budget: max(1, floor(outputMinutes × this)). */
  maxPerOutputMinute: number;
  /** The duration the budget is computed against (output time). */
  outputDurationSeconds: number;
}

/**
 * The Director review's historical zoom-density judgment, extracted verbatim:
 * within each too-close pair the WEAKER (by confidence) is flagged; over-budget
 * flags the weakest remainder. Returns ids to disable — the caller applies
 * them (review.ts keeps its own finding format; the route uses actions).
 *
 * `zooms` must be the caller's already-scoped, enabled, sorted-or-not list —
 * scope (Director-only vs all-AI) is the CALLER's decision, which is what lets
 * one implementation serve both call sites without changing either's meaning.
 */
export function zoomDensityPass(
  zooms: DetectedMoment[],
  cfg: ZoomDensityConfig
): string[] {
  const sorted = [...zooms].sort((a, b) => a.startTime - b.startTime);
  const flagged: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startTime - sorted[i - 1].endTime < cfg.minGapSeconds) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const weaker = confOf(a) <= confOf(b) ? a : b;
      if (!flagged.includes(weaker.id)) flagged.push(weaker.id);
    }
  }
  const outMinutes = Math.max(cfg.outputDurationSeconds, 1) / 60;
  const budget = Math.max(1, Math.floor(outMinutes * cfg.maxPerOutputMinute));
  const overBudget = sorted.length - budget;
  if (overBudget > 0) {
    const weakest = sorted
      .slice()
      .sort((a, b) => confOf(a) - confOf(b))
      .slice(0, overBudget)
      .map((m) => m.id);
    for (const id of weakest) if (!flagged.includes(id)) flagged.push(id);
  }
  return flagged;
}

// ── The route-side Gate D ───────────────────────────────────────────────────

export interface ReviewCompositionInput {
  /** Source duration; used when no output duration is known yet. */
  durationSeconds: number;
  /** Output duration after cuts/speed, when the caller has it. */
  outputDurationSeconds?: number;
}

export function reviewComposition(
  moments: DetectedMoment[],
  policy: ResolvedEditorialPolicy,
  input: ReviewCompositionInput
): CompositionReport {
  const comp = policy.composition;
  if (comp.mode !== "enforce") {
    return { mode: "off", actions: [], counts: {} };
  }

  const actions: CompositionAction[] = [];
  const disabled = new Set<string>();
  const counts: CompositionReport["counts"] = {};
  const act = (m: DetectedMoment, rule: CompositionAction["rule"], reason: string) => {
    if (disabled.has(m.id)) return;
    disabled.add(m.id);
    counts[rule] = (counts[rule] ?? 0) + 1;
    actions.push({ id: m.id, action: "disable", rule, reason });
  };
  const live = () => moments.filter((m) => reviewable(m) && !disabled.has(m.id));

  // Budgets are per OUTPUT minute (what the viewer actually watches). Derive it
  // from the same timeline map the export uses when the caller doesn't have it.
  const outputDuration =
    input.outputDurationSeconds ??
    buildTimelineMap(moments, input.durationSeconds).outputDuration;

  // 1. Zoom family density — the generalized Director-review backstop.
  if (comp.zoom) {
    const zooms = live().filter((m) => m.effectType === "zoom");
    const ids = zoomDensityPass(zooms, {
      minGapSeconds: comp.zoom.minGapSeconds,
      maxPerOutputMinute: comp.zoom.maxPerOutputMinute,
      outputDurationSeconds: outputDuration,
    });
    for (const id of ids) {
      const m = moments.find((x) => x.id === id);
      if (m) {
        act(
          m,
          "zoom-density",
          `Zooms were packed tighter than this template allows (min ${comp.zoom.minGapSeconds}s apart, ≤${comp.zoom.maxPerOutputMinute}/min) — kept the strongest.`
        );
      }
    }
  }

  // 2. Per-type totals (budgets the selection stage doesn't see — overlays).
  for (const [category, policyEntry] of Object.entries(policy.decision.perType)) {
    const maxTotal = policyEntry?.maxTotal;
    if (typeof maxTotal !== "number") continue;
    const ofType = live().filter(
      (m) => categoryForEffectType(m.effectType) === category
    );
    if (ofType.length <= maxTotal) continue;
    const keepBest = ofType
      .slice()
      .sort((a, b) => confOf(b) - confOf(a))
      .slice(maxTotal);
    for (const m of keepBest) {
      act(
        m,
        "per-type-budget",
        `This template carries at most ${maxTotal} ${category.replace(/_/g, " ")} edit${maxTotal === 1 ? "" : "s"} — kept the strongest.`
      );
    }
  }

  // 3. Stacked emphasis — at most one emphasis edit active at an instant.
  if (comp.overlapEmphasis) {
    const emphasis = live()
      .filter((m) => EMPHASIS_TYPES.has(m.effectType))
      .sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < emphasis.length; i++) {
      for (let j = i + 1; j < emphasis.length; j++) {
        const a = emphasis[i];
        const b = emphasis[j];
        if (b.startTime >= a.endTime) break;
        if (disabled.has(a.id) || disabled.has(b.id)) continue;
        const loser = confOf(a) <= confOf(b) ? a : b;
        act(
          loser,
          "overlap-emphasis",
          "Two emphasis edits were stacked on the same instant — one clear point of focus beats two competing ones."
        );
      }
    }
  }

  // 4. Clusters — more than N edits inside a rolling window reads as noise.
  if (comp.cluster) {
    const { windowS, maxInWindow } = comp.cluster;
    const pool = live().sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < pool.length; i++) {
      const anchor = pool[i];
      if (disabled.has(anchor.id)) continue;
      const inWindow = pool.filter(
        (m) =>
          !disabled.has(m.id) &&
          startOf(m) >= startOf(anchor) &&
          startOf(m) < startOf(anchor) + windowS
      );
      if (inWindow.length <= maxInWindow) continue;
      const excess = inWindow
        .slice()
        .sort((a, b) => confOf(b) - confOf(a))
        .slice(maxInWindow);
      for (const m of excess) {
        act(
          m,
          "cluster",
          `${inWindow.length} edits landed inside ${windowS}s — thinned the cluster to the strongest ${maxInWindow}.`
        );
      }
    }
  }

  // 5. Cross-type rolling density (the global busyness budget).
  if (policy.density.crossDensity) {
    const { windowS, maxInWindow } = policy.density.crossDensity;
    const pool = live().sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < pool.length; i++) {
      const anchor = pool[i];
      if (disabled.has(anchor.id)) continue;
      const inWindow = pool.filter(
        (m) =>
          !disabled.has(m.id) &&
          startOf(m) >= startOf(anchor) &&
          startOf(m) < startOf(anchor) + windowS
      );
      if (inWindow.length <= maxInWindow) continue;
      const excess = inWindow
        .slice()
        .sort((a, b) => confOf(b) - confOf(a))
        .slice(maxInWindow);
      for (const m of excess) {
        act(
          m,
          "cross-density",
          `More than ${maxInWindow} edits inside ${windowS}s — a viewer reads that as restlessness, not intent.`
        );
      }
    }
  }

  return { mode: "enforce", actions, counts };
}

/** Apply a report: returns the same array when nothing was disabled. */
export function applyCompositionActions(
  moments: DetectedMoment[],
  report: CompositionReport
): DetectedMoment[] {
  if (report.actions.length === 0) return moments;
  const off = new Map(report.actions.map((a) => [a.id, a]));
  return moments.map((m) => {
    const a = off.get(m.id);
    return a ? { ...m, enabled: false, editorialReason: a.reason } : m;
  });
}
