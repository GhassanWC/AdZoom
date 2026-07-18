/**
 * AI Director — editorial judgment (the decision engine).
 *
 * Runs between `validate` and `execute`. Validation only asks whether an edit
 * COULD exist: a real edit type, an in-bounds window, its required params.
 * Nothing there asks whether it SHOULD — so a technically-valid but pointless
 * or speculative edit used to sail straight onto the timeline. This module is
 * that missing question: the pass a professional human editor makes before
 * committing an effect, not after.
 *
 * Two passes:
 *   1. PER-EDIT — does this edit, on its own, earn its place? An edit with no
 *      real reason, nothing grounding it in the video, or confidence the
 *      Director itself doesn't trust is exactly the "random or unnecessary"
 *      edit this stage exists to catch. "No edit" is a normal outcome here,
 *      not a fallback.
 *   2. WHOLE-VIDEO — does this edit fit with the ones around it? Edits of the
 *      same kind crowding one beat (two callouts a second apart, three text
 *      overlays back to back) read as the AI maximizing edit count, not as
 *      one intentional pass. Only the strongest edit on a crowded beat
 *      survives.
 *
 * Every edit that survives both passes is stamped with an internal
 * `justification` — the category of "why" it exists (see
 * `DirectorJustification`) — even though nothing requires it be shown to the
 * user. An edit that can't be justified is dropped, not shipped.
 *
 * Pure. No I/O, no model calls.
 */
import {
  type DirectorEditOperation,
  type DirectorEditType,
  type DirectorFailure,
  type DirectorJustification,
  type DirectorPlan,
} from "./types";

export interface DirectorEditorialJudgment {
  /** The plan with unjustified edits dropped and every survivor stamped. */
  plan: DirectorPlan;
  /** Every edit the decision engine rejected, with a reason the user can read. */
  failures: DirectorFailure[];
}

/** Below this, the Director itself isn't sure enough to put it in front of a viewer. */
const MIN_CONFIDENCE = 0.3;
/** A reason this short is a placeholder, not a justification. */
const MIN_REASON_LENGTH = 8;
/** Same-kind edits inside this many seconds of each other are one beat, not two. */
const CROWD_WINDOW_SECONDS = 2;

/** What kind of editorial purpose each edit type most directly serves. */
const JUSTIFICATION_BY_EDIT_TYPE: Record<DirectorEditType, DirectorJustification> = {
  zoom: "emphasis",
  "click-highlight": "action",
  "cursor-focus": "attention",
  "speed-up": "pacing",
  cut: "pacing",
  captions: "clarity",
  "hook-text": "engagement",
  "text-overlay": "clarity",
  callout: "action",
  transition: "pacing",
  "branding-cta": "structure",
  "smart-crop": "structure",
};

function rejection(
  op: DirectorEditOperation,
  reason: DirectorFailure["reason"],
  detail: string
): DirectorFailure {
  return { operationId: op.id, subject: op.editType, reason, detail };
}

/**
 * PASS 1 — per-edit judgment.
 *
 * A real edit can point at something: a transcript line, a click, a detected
 * moment, the user's own request. An edit with no evidence, a throwaway
 * reason, or confidence too low to trust is the "applies edits that feel
 * random or unnecessary" behavior this stage exists to stop. Returns the
 * rejection, or null when the edit earns its place.
 */
function judgeEdit(op: DirectorEditOperation): DirectorFailure | null {
  if (!(op.confidence >= MIN_CONFIDENCE)) {
    return rejection(
      op,
      "not_editorially_justified",
      `Confidence ${op.confidence.toFixed(2)} is below the bar for putting this in front of a viewer — no edit was the safer choice.`
    );
  }
  if (!op.reason || op.reason.trim().length < MIN_REASON_LENGTH) {
    return rejection(
      op,
      "not_editorially_justified",
      "No real justification was given for this edit, so it wasn't made."
    );
  }
  if (op.evidence.length === 0) {
    return rejection(
      op,
      "not_editorially_justified",
      "Nothing grounds this edit — no transcript line, click, moment or user request behind it."
    );
  }
  return null;
}

/**
 * PASS 2 — whole-video judgment.
 *
 * Groups edits by type and, within each group, collapses runs that sit
 * within `CROWD_WINDOW_SECONDS` of each other down to the single edit the
 * Director trusts most (confidence, then priority, breaks ties). This is
 * what keeps "three callouts on the same click" from reading as three
 * separate editorial decisions instead of one edit applied three times.
 */
function thinCrowding(ops: DirectorEditOperation[]): {
  survivors: DirectorEditOperation[];
  failures: DirectorFailure[];
} {
  const failures: DirectorFailure[] = [];
  const byType = new Map<DirectorEditType, DirectorEditOperation[]>();
  for (const op of ops) {
    const list = byType.get(op.editType) ?? [];
    list.push(op);
    byType.set(op.editType, list);
  }

  const dropped = new Set<string>();
  for (const group of byType.values()) {
    const sorted = [...group].sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      if (dropped.has(a.id)) continue;
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        if (dropped.has(b.id)) continue;
        // Windows are sorted by start time, so once a gap exceeds the crowd
        // window every later item is even further away — safe to stop.
        if (b.startTime - a.endTime > CROWD_WINDOW_SECONDS) break;

        const aStronger =
          a.confidence !== b.confidence ? a.confidence > b.confidence : a.priority >= b.priority;
        const loser = aStronger ? b : a;
        dropped.add(loser.id);
        failures.push(
          rejection(
            loser,
            "editorially_redundant",
            `Crowds another ${loser.editType} within ${CROWD_WINDOW_SECONDS}s — only the stronger edit on this beat was kept.`
          )
        );
        if (!aStronger) break; // `a` itself lost — stop comparing it further.
      }
    }
  }

  return { survivors: ops.filter((op) => !dropped.has(op.id)), failures };
}

/**
 * Run the decision engine over a VALIDATED plan's edit operations.
 *
 * Must run AFTER `validateDirectorPlan` — validation has already thrown out
 * anything that can't exist (bad type, out-of-bounds window, missing
 * required params); this throws out what technically could exist but
 * shouldn't. Only `editOperations` are judged: clip/audio operations and
 * captions are driven by dead-zone detection and the user's own caption
 * request respectively, not by the same "is this worth doing" call.
 */
export function applyEditorialJudgment(plan: DirectorPlan): DirectorEditorialJudgment {
  const failures: DirectorFailure[] = [];
  const candidates: DirectorEditOperation[] = [];

  for (const op of plan.editOperations) {
    const rejected = judgeEdit(op);
    if (rejected) {
      failures.push(rejected);
      continue;
    }
    candidates.push(op);
  }

  const { survivors, failures: crowdFailures } = thinCrowding(candidates);
  failures.push(...crowdFailures);

  const editOperations = survivors.map((op) => ({
    ...op,
    justification: JUSTIFICATION_BY_EDIT_TYPE[op.editType],
  }));

  return { plan: { ...plan, editOperations }, failures };
}
