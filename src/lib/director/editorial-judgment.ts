/**
 * AI Director — editorial judgment (the decision engine).
 *
 * Runs AFTER the plan is structurally validated (`validate.ts` has already
 * settled whether an operation CAN exist) and BEFORE a single edit is executed.
 * This is where Framevo decides whether an edit DESERVES to exist.
 *
 * A professional editor doesn't apply every technically-possible edit. For each
 * candidate they ask: does this help the viewer, is it the best choice for this
 * moment (or would no edit be better), does it fit with what comes right before
 * and after it, and will it distract rather than clarify? An edit that can't
 * clear that bar doesn't survive here — "no edit" is a normal, common outcome,
 * not something the pipeline treats as a shortfall.
 *
 * Two passes:
 *   1. PER-EDIT judgment — an edit with no honest reason, no supporting
 *      evidence, or confidence too low to trust is dropped, never waved
 *      through on the theory that more edits look more thorough. Everything
 *      that survives is stamped with WHY it exists (`justification`) — the
 *      internal reason a viewer never has to see: emphasis, pacing, guiding
 *      attention, highlighting an action, clarity, engagement, or narrative
 *      structure. An edit that can't be assigned one of these doesn't ship.
 *   2. WHOLE-VIDEO judgment — edits are judged against their neighbors, not in
 *      isolation. Same-purpose edits (callouts, text overlays, click/cursor
 *      focus) packed too close together read as noise regardless of how good
 *      any single one is, so only the stronger of a crowded pair survives.
 *      (Zoom density is judged separately, against the rendered timeline, by
 *      `review.ts` — this pass doesn't duplicate that.)
 *
 * Pure. No I/O, no model calls — deterministic judgment over data the plan
 * already carries (confidence / evidence / priority / reason), so it runs
 * identically over a Gemini plan and the heuristic plan alike. That matters
 * because the model is coached to self-limit but nothing enforces it; this is
 * the backstop that makes "quality over quantity" true rather than aspirational.
 */
import type {
  DirectorEditOperation,
  DirectorEditType,
  DirectorFailure,
  DirectorJustificationKind,
  DirectorPlan,
} from "./types";

export interface EditorialJudgmentResult {
  /** The plan with every edit that couldn't be justified removed. */
  plan: DirectorPlan;
  /** Every edit the decision engine rejected, with a reason the user can read. */
  failures: DirectorFailure[];
}

/**
 * Edit types that ARE the story rather than decoration on top of it. They come
 * straight from the user's request or the narrative spine, so they're judged on
 * having a real reason — not on evidence density or a confidence floor the way a
 * speculative zoom or callout is.
 */
const STRUCTURAL_EDIT_TYPES = new Set<DirectorEditType>([
  "hook-text",
  "branding-cta",
  "smart-crop",
  "cut",
  "captions",
]);

/**
 * Below this confidence, a careful editor leaves the moment alone rather than
 * guess. Deliberately loose — this is a backstop against genuinely speculative
 * edits, not a tool for second-guessing an honest 0.5. Structural types (see
 * above) have no entry here: they're evaluated on justification, not a score.
 */
const CONFIDENCE_FLOOR: Partial<Record<DirectorEditType, number>> = {
  zoom: 0.35,
  "click-highlight": 0.35,
  "cursor-focus": 0.35,
  callout: 0.4,
  "text-overlay": 0.35,
  "speed-up": 0.3,
  transition: 0.3,
};

/**
 * Minimum gap (seconds) between two edits of the SAME type before they start
 * competing for the viewer's attention instead of taking turns. Only covers
 * types with no other collision handling — zoom already gets a density pass
 * from `review.ts`, run against the real rendered timeline where it belongs.
 */
const MIN_GAP_SECONDS: Partial<Record<DirectorEditType, number>> = {
  callout: 1.2,
  "text-overlay": 1.0,
  "click-highlight": 1.0,
  "cursor-focus": 1.0,
};

/** What surviving this edit says about why it's worth keeping. */
function classifyJustification(op: DirectorEditOperation): DirectorJustificationKind {
  switch (op.editType) {
    case "hook-text":
    case "branding-cta":
      return "engagement";
    case "smart-crop":
      return "structure";
    case "cut":
      return "pacing";
    case "zoom":
      return op.evidence.some((e) => e.kind === "click" || e.kind === "moment")
        ? "action"
        : "emphasis";
    case "click-highlight":
    case "cursor-focus":
    case "callout":
      return "attention";
    case "text-overlay":
    case "captions":
      return "clarity";
    case "speed-up":
    case "transition":
      return "pacing";
    default:
      return "engagement";
  }
}

/** Combined strength used to pick a winner when two edits crowd each other. */
function editScore(op: DirectorEditOperation): number {
  return op.confidence * 0.6 + op.priority * 0.4;
}

function reject(
  failures: DirectorFailure[],
  op: DirectorEditOperation,
  detail: string
): void {
  failures.push({
    operationId: op.id,
    subject: op.editType,
    reason: "weak_justification",
    detail,
  });
}

/**
 * Per-edit judgment. Returns the edits that earned their place, each stamped
 * with the internal reason it exists.
 */
function judgeEdits(
  editOperations: DirectorEditOperation[],
  failures: DirectorFailure[]
): DirectorEditOperation[] {
  const kept: DirectorEditOperation[] = [];

  for (const op of editOperations) {
    const reason = op.reason?.trim();
    if (!reason) {
      reject(
        failures,
        op,
        `No reason was given for this ${op.editType} — an edit that can't be explained doesn't get made.`
      );
      continue;
    }

    const structural = STRUCTURAL_EDIT_TYPES.has(op.editType);

    if (!structural && op.evidence.length === 0) {
      reject(
        failures,
        op,
        `Nothing in the transcript, clicks or detected moments backs up this ${op.editType} — it was left out rather than guessed at.`
      );
      continue;
    }

    const floor = CONFIDENCE_FLOOR[op.editType];
    if (floor !== undefined && op.confidence < floor) {
      reject(
        failures,
        op,
        `Confidence (${op.confidence.toFixed(2)}) was too low to justify this ${op.editType} — leaving the moment alone was the safer editorial call.`
      );
      continue;
    }

    kept.push({ ...op, justification: classifyJustification(op) });
  }

  return kept;
}

/**
 * Whole-video judgment: same-type edits that crowd each other lose the weaker
 * of the pair. Walks each governed type in time order, comparing every edit
 * only to the last one that actually survived — so a chain of near-misses
 * collapses to the single strongest edit in the cluster, not an alternating
 * keep/drop pattern.
 */
function enforceFlowSpacing(
  ops: DirectorEditOperation[],
  failures: DirectorFailure[]
): DirectorEditOperation[] {
  const byType = new Map<DirectorEditType, DirectorEditOperation[]>();
  for (const op of ops) {
    if (MIN_GAP_SECONDS[op.editType] === undefined) continue;
    const list = byType.get(op.editType);
    if (list) list.push(op);
    else byType.set(op.editType, [op]);
  }

  const dropped = new Set<string>();
  for (const [editType, list] of byType) {
    const gap = MIN_GAP_SECONDS[editType]!;
    const sorted = list.slice().sort((a, b) => a.startTime - b.startTime);
    let lastKept = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const candidate = sorted[i];
      if (candidate.startTime - lastKept.endTime < gap) {
        const weaker = editScore(candidate) < editScore(lastKept) ? candidate : lastKept;
        dropped.add(weaker.id);
        if (weaker.id === lastKept.id) lastKept = candidate;
        continue;
      }
      lastKept = candidate;
    }
  }

  if (dropped.size === 0) return ops;

  for (const op of ops) {
    if (!dropped.has(op.id)) continue;
    reject(
      failures,
      op,
      `Too close to another ${op.editType} to read as separate beats — only the stronger of the two was kept.`
    );
  }

  return ops.filter((op) => !dropped.has(op.id));
}

/**
 * Judge a validated plan's edits. Clip and audio operations (what survives,
 * what's silenced) aren't second-guessed here — they're the structural cut,
 * already the product of the planner's own editorial pass over the story. This
 * is specifically the gate for the decorative and emphasis layer on top of it.
 */
export function applyEditorialJudgment(plan: DirectorPlan): EditorialJudgmentResult {
  const failures: DirectorFailure[] = [];
  const judged = judgeEdits(plan.editOperations, failures);
  const spaced = enforceFlowSpacing(judged, failures);

  return {
    plan: { ...plan, editOperations: spaced },
    failures,
  };
}
