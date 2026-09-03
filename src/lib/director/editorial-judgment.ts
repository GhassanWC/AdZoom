/**
 * AI Director — editorial judgment (the AI Editor / decision engine).
 *
 * Runs between `validate.ts` and `execute.ts`:
 *
 *     plan → validate → editorial judgment → execute → review → timeline
 *
 * `validate.ts` only ever asks whether an edit COULD exist — a real edit type,
 * a window inside the video, its required params. Nothing before this module
 * asked whether an edit SHOULD exist. This module does:
 *
 *   • Does this edit improve the viewer's experience, or is it filler?
 *   • Is it grounded in something real, or is it a guess?
 *   • Does it crowd another edit at the same moment?
 *
 * If an edit can't be justified, it is DROPPED — never weakened, never forced
 * through to hit a quota. "No edit" is a fully valid, and often correct,
 * outcome: nothing here requires a minimum edit count.
 *
 * Every edit that survives is stamped with an internal `justification`
 * (emphasis / pacing / attention / action / clarity / engagement / structure)
 * — the "why does this exist" a professional editor could give for keeping it.
 *
 * Scoped to `editOperations`: clip removals, audio cleanup and captions are
 * already structural decisions gated by the planner's own dead-zone/transcript
 * grounding and by `validate.ts`'s param checks. This is where the Director's
 * additive, optional edits — zooms, callouts, text, transitions — earn their
 * place.
 *
 * Pure. No I/O.
 */
import {
  type DirectorEditOperation,
  type DirectorEditType,
  type DirectorFailure,
  type DirectorJustification,
  type DirectorPlan,
} from "./types";
import {
  categoryForEffectType,
  statusAllowsGeneration,
  type EditCategoryId,
  type PolicyStatus,
} from "../editorial/policy";

/**
 * The slice of the run's ResolvedEditorialPolicy this stage consults (Phase 2C
 * — "the conversation controls the Editorial Engine; it does not bypass it").
 * Statuses only: an op of a category the template doesn't use is rejected
 * before per-op judgment. Budgets/spacing stay with the review + Gate D (the
 * per-style constants below remain allowlisted until Phase 4 — see
 * tests/editorial-ownership.test.ts).
 */
export interface JudgmentPolicy {
  statuses: Partial<Record<EditCategoryId, PolicyStatus>>;
  /** "classic" = pre-policy behaviour: the status gate does not run. */
  mode: "classic" | "enforce";
  templateName?: string;
}

/** Below this, the Director isn't sure enough to put the edit in front of a viewer. */
const MIN_CONFIDENCE = 0.35;
/** A reason shorter than this reads as a placeholder, not a justification. */
const MIN_REASON_LENGTH = 8;

/**
 * Edits that exist because the user directly asked for them (a hook, a CTA, a
 * reframe to a target aspect) rather than because the Director noticed
 * something worth calling out in the footage. They still need a real reason
 * and honest confidence, but not independent evidence — the user's request
 * IS the evidence.
 */
const STRUCTURAL_TYPES: ReadonlySet<DirectorEditType> = new Set([
  "hook-text",
  "branding-cta",
  "smart-crop",
]);

/** Same-type edits landing this close together read as clutter, not intent. */
const CROWD_WINDOW_SECONDS = 2;

/**
 * Edit types whose local density is judged HERE, against the PLAN's windows.
 * Zoom is deliberately excluded: its density is judged by the review engine
 * (`review.ts`, rule `zoom-density`) against the REAL rendered timeline, after
 * cuts have moved everything around. Judging the same thing twice against two
 * different timelines would just produce disagreeing answers.
 */
const CROWD_TYPES: ReadonlySet<DirectorEditType> = new Set([
  "callout",
  "text-overlay",
  "click-highlight",
  "cursor-focus",
]);

/** The "why" behind each edit type — what a human editor would say it's for. */
const JUSTIFICATION_BY_TYPE: Record<DirectorEditType, DirectorJustification> = {
  zoom: "emphasis",
  "click-highlight": "action",
  "cursor-focus": "attention",
  "speed-up": "pacing",
  cut: "pacing",
  captions: "clarity",
  "hook-text": "structure",
  "text-overlay": "clarity",
  callout: "attention",
  transition: "engagement",
  "branding-cta": "structure",
  "smart-crop": "structure",
};

export interface EditorialJudgmentResult {
  /** The plan with every unjustified edit dropped and survivors stamped. */
  plan: DirectorPlan;
  /** Every edit that did NOT survive judgment, with a reason the user can read. */
  failures: DirectorFailure[];
}

function fail(operationId: string, subject: string, detail: string): DirectorFailure {
  return { operationId, subject, reason: "not_justified", detail };
}

/** A reason that's just the edit type restated ("Zoom.", "Callout") isn't one. */
function isTrivialReason(reason: string): boolean {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_LENGTH) return true;
  return /^(zoom|callout|cuts?|edit|transition|text([ -]?overlay)?|captions?|hook|cta)s?\.?$/i.test(
    trimmed
  );
}

/** Does this single edit earn its place? Returns the rejection, or null to keep it. */
function judgeOne(op: DirectorEditOperation): DirectorFailure | null {
  if (isTrivialReason(op.reason)) {
    return fail(
      op.id,
      op.editType,
      `No real justification was given for this ${op.editType} — an edit that can't be explained isn't one a professional editor would make.`
    );
  }
  if (!(op.confidence >= MIN_CONFIDENCE)) {
    return fail(
      op.id,
      op.editType,
      `Confidence (${op.confidence.toFixed(2)}) is too low to put this ${op.editType} in front of a viewer. No edit beats a guess.`
    );
  }
  if (!STRUCTURAL_TYPES.has(op.editType) && op.evidence.length === 0) {
    return fail(
      op.id,
      op.editType,
      `Nothing in the video grounds this ${op.editType} — an edit with no evidence behind it is a guess, not a decision.`
    );
  }
  return null;
}

/**
 * Thin same-type edits crowding the same beat down to the single strongest
 * one. A cluster is a run of same-type edits each starting less than
 * `CROWD_WINDOW_SECONDS` after the previous one ends; only the
 * highest-confidence edit in the cluster survives.
 */
function thinCrowding(ops: DirectorEditOperation[]): {
  kept: DirectorEditOperation[];
  dropped: DirectorFailure[];
} {
  const dropped: DirectorFailure[] = [];
  const dropIds = new Set<string>();

  for (const type of CROWD_TYPES) {
    const group = ops.filter((o) => o.editType === type).sort((a, b) => a.startTime - b.startTime);

    let cluster: DirectorEditOperation[] = [];
    const flush = () => {
      if (cluster.length > 1) {
        const strongest = cluster.reduce((best, o) => (o.confidence > best.confidence ? o : best));
        for (const o of cluster) {
          if (o.id === strongest.id) continue;
          dropIds.add(o.id);
          dropped.push(
            fail(
              o.id,
              o.editType,
              `Crowds another ${o.editType} within ${CROWD_WINDOW_SECONDS}s (kept "${strongest.id}", the stronger of the two) — one intentional edit beats two competing for the same moment.`
            )
          );
        }
      }
      cluster = [];
    };

    for (const op of group) {
      const prev = cluster[cluster.length - 1];
      if (prev && op.startTime - prev.endTime < CROWD_WINDOW_SECONDS) {
        cluster.push(op);
      } else {
        flush();
        cluster.push(op);
      }
    }
    flush();
  }

  return { kept: ops.filter((o) => !dropIds.has(o.id)), dropped };
}

/**
 * The AI Editor. Runs on a VALIDATED plan, before execution.
 *
 * Judges every proposed edit against the questions a professional human
 * editor would ask, drops what can't be justified, then looks at the whole
 * set of survivors to thin out edits crowding the same moment — so the result
 * reads as one consistent editorial pass, not a pile of isolated per-chunk
 * decisions. Every edit that makes it through is stamped with why it exists.
 */
export function applyEditorialJudgment(
  plan: DirectorPlan,
  policy?: JudgmentPolicy
): EditorialJudgmentResult {
  const failures: DirectorFailure[] = [];
  const survivors: DirectorEditOperation[] = [];

  const enforce = policy?.mode === "enforce";
  const styleName = policy?.templateName ?? "this editing style";

  for (const op of plan.editOperations) {
    // Gate A/B — the template's stance on this edit type. A brief cannot talk
    // the Director into an edit category the selected template forbids: the op
    // is reported (`policy_forbidden`), never executed. Classic policies skip
    // this gate entirely, so pre-template behaviour is untouched.
    if (enforce) {
      const status = policy!.statuses[categoryForEffectType(op.editType)];
      if (status !== undefined && !statusAllowsGeneration(status)) {
        failures.push({
          operationId: op.id,
          subject: op.editType,
          reason: "policy_forbidden",
          detail: `${styleName} doesn't use ${op.editType.replace(/-/g, " ")} edits — the request stays inside the selected editing style.`,
        });
        continue;
      }
    }

    const rejection = judgeOne(op);
    if (rejection) {
      failures.push(rejection);
      continue;
    }
    survivors.push({ ...op, justification: JUSTIFICATION_BY_TYPE[op.editType] });
  }

  const { kept, dropped } = thinCrowding(survivors);
  failures.push(...dropped);

  return {
    plan: { ...plan, editOperations: kept },
    failures,
  };
}
