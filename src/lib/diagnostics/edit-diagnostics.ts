import type { Interaction } from "@/lib/recording/types";
import type {
  ClickPipelineDiagnostics,
  DetectedMoment,
  EditBottleneck,
  EditDiagnosticRow,
  EditDiagnostics,
  EditDropClass,
  VisualAnalysis,
} from "@/lib/firebase/schema";

/** Human-readable labels for each bottleneck kind (shared across UIs). */
export const BOTTLENECK_LABEL: Record<EditBottleneck, string> = {
  understanding: "Understanding failure",
  planning: "Planning failure",
  execution: "Execution failure",
  coverage: "Coverage failure",
  "user-expectation": "User-expectation gap",
  healthy: "Healthy",
};

/**
 * Editing-funnel diagnostics — pure, reporting-only.
 *
 * This module answers the product question "out of N meaningful interactions,
 * how many does Framevo actually edit?" by joining three things the analyze
 * route already computes: the raw interaction counts, the candidate moment
 * pool, and the final timeline. It NEVER influences editing/balancing — the
 * thresholds here are for reporting only.
 *
 * Coverage is computed as an INTERSECTION, not a naive ratio of totals:
 *   coverage = |important ∩ applied| / |important|
 * so AI gap-fills that don't correspond to a real interaction can't push
 * coverage above 100%, and an honest "of the meaningful moments, how many did
 * we keep?" falls out directly.
 */

// ── Reporting thresholds (tunable; reporting-only, never read by editing) ──
const ATT_THRESHOLD = 0.5; // attentionScore at/above which a moment is "important"
const CONF_THRESHOLD = 0.6; // confidenceScore at/above which a moment is "important"
const ROWS_CAP = 200; // max drill-down rows persisted (Firestore doc-size guard)

/** rejectedReason prefixes that mark a genuinely lost edit (vs a correct drop). */
const SUPPRESSED_REASON = /^(boring-section|in-idle|no-target)/;

/**
 * Is this candidate a "meaningful interaction" for coverage purposes?
 * Reporting-only definition (confirmed with product): a real interaction
 * (event/user provenance) OR a high-confidence / high-attention candidate.
 */
function isImportant(m: DetectedMoment): boolean {
  if (m.provenance === "event" || m.provenance === "user") return true;
  if ((m.confidenceScore ?? 0) >= CONF_THRESHOLD) return true;
  if ((m.attentionScore ?? 0) >= ATT_THRESHOLD) return true;
  return false;
}

/** 0..1 importance for display — best available signal. */
function importanceOf(m: DetectedMoment): number {
  return m.attentionScore ?? m.confidenceScore ?? 0;
}

/** Did Gemini generate an edit instruction for this moment? */
function isAiGenerated(m: DetectedMoment): boolean {
  return (
    m.provenance === "ai" ||
    m.provenance === "ai-override" ||
    m.id.startsWith("mom_ai_")
  );
}

/** Short human label for the drill-down "detected event" column. */
function detectedEventLabel(m: DetectedMoment): string {
  if (m.label && m.label.trim().length > 0) return m.label;
  const prov = m.provenance ? `${m.provenance} ` : "";
  return `${prov}${m.effectType}`.trim();
}

export interface BuildEditDiagnosticsInput {
  /** In-scope interactions parsed from interactions.json (empty for external capture). */
  interactions: Interaction[];
  /** CV output — `sceneChanges` is the navigation headline source. */
  visualAnalysis?: VisualAnalysis;
  /** Per-tier click histogram; `nav` is the navigation sub-line. */
  clickMomentsByTier: ClickPipelineDiagnostics["clickMomentsByTier"];
  /** event + ai-gap + rejected candidates (the route's `rawPool`). */
  rawPool: DetectedMoment[];
  /** Final timeline moments (`balanced.moments`) — may include CV-kept moments not in rawPool. */
  appliedMoments: DetectedMoment[];
  /** Count of AI gap-fill moments Gemini proposed (`aiGapMoments.length`). */
  aiProposed: number;
  /** Subset of `BalancerResult.stats` we surface. */
  stats: {
    inputCount: number;
    quartileLeftEmpty: number;
    quotaDropped: number;
    droppedTooClose: number;
    eventOverlapsResolved: number;
    aiRejectedBoring: number;
    aiRejectedIdle: number;
    aiRejectedNoTarget: number;
    /** CV candidates the visual engine added to the pool. */
    cvCandidatesAdded: number;
  };
  /** Wall-clock for the staleness marker (pass Date.now()). */
  computedAt: number;
}

/**
 * Assemble the consolidated diagnostics record from already-computed analyze
 * locals. No recomputation, no Gemini calls — just joins and counts.
 */
export function buildEditDiagnostics(
  input: BuildEditDiagnosticsInput
): EditDiagnostics {
  const {
    interactions,
    visualAnalysis,
    clickMomentsByTier,
    rawPool,
    appliedMoments,
    aiProposed,
    stats,
    computedAt,
  } = input;

  // ── Raw interaction tally (single pass) ──
  const interactionCounts: Record<string, number> = {};
  for (const ev of interactions) {
    interactionCounts[ev.type] = (interactionCounts[ev.type] ?? 0) + 1;
  }
  const count = (t: string) => interactionCounts[t] ?? 0;
  const totalClicks = count("click") + count("dblclick") + count("rightclick");
  const totalScroll = count("scroll");
  const totalScrollPause = count("scrollpause");
  const totalHover = count("hover");
  const navScene = visualAnalysis?.sceneChanges.length ?? 0;
  const navClick = clickMomentsByTier.nav;

  // ── Visual editing engine (v3) ──
  const cursorTrackFound =
    (visualAnalysis?.cursorConf ?? []).some((c) => c > 0.4 * 255);
  const inferredClickCount = visualAnalysis?.inferredClicks?.length ?? 0;
  const cvMomentsEmitted = stats.cvCandidatesAdded;

  // ── Candidate union (dedup by id; include CV-kept moments from applied) ──
  const appliedIds = new Set(appliedMoments.map((m) => m.id));
  const byId = new Map<string, DetectedMoment>();
  for (const m of rawPool) if (!byId.has(m.id)) byId.set(m.id, m);
  for (const m of appliedMoments) if (!byId.has(m.id)) byId.set(m.id, m);
  const candidates = [...byId.values()];

  // ── Per-candidate classification → rows + funnel counts ──
  const rows: EditDiagnosticRow[] = [];
  let importantDetected = 0;
  let importantApplied = 0;
  let importantIntentionalDrops = 0;
  let intentionalDrops = 0;
  let suppressedDrops = 0;

  for (const m of candidates) {
    const applied = appliedIds.has(m.id) && !m.rejected;
    const important = isImportant(m);

    let dropClass: EditDropClass | undefined;
    if (!applied) {
      dropClass =
        m.rejectedReason && SUPPRESSED_REASON.test(m.rejectedReason)
          ? "suppressed"
          : "intentional";
      if (dropClass === "intentional") intentionalDrops += 1;
      else suppressedDrops += 1;
    }

    if (important) {
      importantDetected += 1;
      if (applied) importantApplied += 1;
      else if (dropClass === "intentional") importantIntentionalDrops += 1;
    }

    rows.push({
      id: m.id,
      ts: m.startTime,
      detectedEvent: detectedEventLabel(m),
      provenance: m.provenance,
      importanceScore: importanceOf(m),
      aiGenerated: isAiGenerated(m),
      timelineApplied: applied,
      rejectedReason: m.rejectedReason,
      dropClass,
    });
  }

  rows.sort((a, b) => a.ts - b.ts);

  // Coverage as an intersection so it stays in [0, 1] and reads as
  // "of the meaningful moments, how many did we keep?".
  const coverageRaw =
    importantDetected > 0 ? importantApplied / importantDetected : 0;
  const adjustedDenom = Math.max(
    1,
    importantDetected - importantIntentionalDrops
  );
  const coverageAdjusted = importantApplied / adjustedDenom;

  return {
    schemaVersion: 1,
    computedAt,

    interactionCounts,
    totalInteractions: interactions.length,
    totalClicks,
    totalScroll,
    totalScrollPause,
    totalHover,
    navScene,
    navClick,

    cursorTrackFound,
    inferredClickCount,
    cvMomentsEmitted,

    importantDetected,
    candidatesProposed: stats.inputCount,
    aiProposed,
    timelineApplied: appliedMoments.length,

    intentionalDrops,
    suppressedDrops,
    quartileLeftEmpty: stats.quartileLeftEmpty,
    dropBreakdown: {
      eventOverlapsResolved: stats.eventOverlapsResolved,
      droppedTooClose: stats.droppedTooClose,
      quotaDropped: stats.quotaDropped,
      aiRejectedBoring: stats.aiRejectedBoring,
      aiRejectedIdle: stats.aiRejectedIdle,
      aiRejectedNoTarget: stats.aiRejectedNoTarget,
    },

    coverageRaw,
    coverageAdjusted,

    rows: rows.slice(0, ROWS_CAP),
  };
}

export interface BottleneckVerdict {
  kind: EditBottleneck;
  /** 0..1 — how strongly this bottleneck fired (lower ratio = stronger). */
  score: number;
  /** One-line, number-backed justification. */
  evidence: string;
}

/**
 * Heuristic localisation of where edits are lost, computed purely from the
 * funnel counts. Ordered precedence: the FIRST failing stage wins, because an
 * upstream failure (e.g. nothing classified important) makes downstream ratios
 * meaningless. Reporting-only; tune freely.
 */
export function classifyBottleneck(d: EditDiagnostics): BottleneckVerdict {
  const meaningful = d.totalClicks + d.totalScroll + d.totalHover + d.navScene;
  const rUnderstand = d.importantDetected / Math.max(1, meaningful);
  const rPlan = d.candidatesProposed / Math.max(1, d.importantDetected);
  const rExec = d.timelineApplied / Math.max(1, d.candidatesProposed);
  const cov = d.coverageAdjusted;

  const pct = (n: number) => `${Math.round(n * 100)}%`;

  if (meaningful >= 8 && rUnderstand < 0.3) {
    return {
      kind: "understanding",
      score: rUnderstand,
      evidence: `${meaningful} meaningful interactions but only ${d.importantDetected} classified important (${pct(rUnderstand)}).`,
    };
  }
  if (d.importantDetected >= 5 && rPlan < 0.5) {
    return {
      kind: "planning",
      score: rPlan,
      evidence: `${d.importantDetected} important moments but only ${d.candidatesProposed} edit candidates generated (${pct(rPlan)}).`,
    };
  }
  if (d.candidatesProposed >= 5 && rExec < 0.4) {
    return {
      kind: "execution",
      score: rExec,
      evidence: `${d.candidatesProposed} candidates but only ${d.timelineApplied} applied (${pct(rExec)}).`,
    };
  }
  if (d.timelineApplied > 0 && cov < 0.5 && d.suppressedDrops > 0) {
    return {
      kind: "coverage",
      score: cov,
      evidence: `Adjusted coverage ${pct(cov)} with ${d.suppressedDrops} suppressed (lost) edits.`,
    };
  }
  if (cov >= 0.7) {
    return {
      kind: "user-expectation",
      score: cov,
      evidence: `Pipeline healthy — adjusted coverage ${pct(cov)}; gap is likely expectation, not lost edits.`,
    };
  }
  return {
    kind: "healthy",
    score: cov,
    evidence: `No dominant bottleneck — adjusted coverage ${pct(cov)}.`,
  };
}
