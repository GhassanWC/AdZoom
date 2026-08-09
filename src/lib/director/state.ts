/**
 * AI Director — persistence layer (pure reducers).
 *
 * `DirectorState` is what survives a refresh, a reopen, and a browser crash. It
 * holds the prompt, the request, the current plan, the applied operation ids, the
 * review, the failures, the model + plan versions, and the full revision history.
 *
 * WHAT IT DOES NOT HOLD: a copy of the timeline. Storing timeline snapshots per
 * revision would balloon the document (a 10-minute video can carry 600 caption
 * moments) and, worse, would give us a SECOND source of truth that could drift
 * from `analysis.detectedMoments`.
 *
 * Instead each revision stores its PLAN, and undo works by replaying the previous
 * plan through the same pure pipeline. `executePlan` is deterministic — same plan
 * + same base + same revision index ⇒ byte-identical moments — so replaying is an
 * exact restore, not an approximation. History stays small AND correct.
 *
 * Pure. No Firebase. The caller writes the returned state.
 */
import type { DirectorFailure, DirectorPlan, DirectorProposal, DirectorRequest, DirectorReviewResult, DirectorRevisionEntry, DirectorStage, DirectorState, DirectorSummary } from "./types";

/** Cap history so a project document can't grow without bound. */
export const MAX_REVISIONS = 20;

export function emptyDirectorState(
  prompt: string,
  request: DirectorRequest
): DirectorState {
  return { prompt, request, status: "idle", revisions: [] };
}

/** Mark a run as started. Persisted immediately so a refresh shows the spinner. */
export function startRun(
  prev: DirectorState | undefined,
  prompt: string,
  request: DirectorRequest,
  requestHash: string,
  now = Date.now()
): DirectorState {
  return {
    ...(prev ?? emptyDirectorState(prompt, request)),
    prompt,
    request,
    status: "running",
    stage: "understanding",
    requestHash,
    startedAt: now,
    errorMessage: undefined,
    // Keep the previous plan/summary visible while the new run works — the panel
    // shouldn't blank out the result the user is currently looking at.
    revisions: prev?.revisions ?? [],
  };
}

export function setStage(state: DirectorState, stage: DirectorStage): DirectorState {
  return { ...state, status: "running", stage };
}

export interface CommitRunInput {
  plan: DirectorPlan;
  summary: DirectorSummary;
  review: DirectorReviewResult;
  failures: DirectorFailure[];
  appliedOperationIds: string[];
  /** The natural-language command. Empty for the initial run. */
  command?: string;
  now?: number;
}

/**
 * Commit a successful run (or revision) to the state, appending a history entry.
 *
 * The caller must only reach here when real edits were applied — `applied` is the
 * gate, and a run that applied nothing must be committed with `failRun` instead.
 * "Complete" has to mean the timeline actually changed.
 */
export function commitRun(
  state: DirectorState,
  input: CommitRunInput
): DirectorState {
  const now = input.now ?? Date.now();
  const index = state.revisions.length;

  const entry: DirectorRevisionEntry = {
    id: `rev-${index}-${now.toString(36)}`,
    index,
    command: input.command ?? "",
    createdAt: now,
    plan: input.plan,
    summary: input.summary,
    review: input.review,
    appliedOperationIds: input.appliedOperationIds,
    failures: input.failures,
  };

  const revisions = [...state.revisions, entry].slice(-MAX_REVISIONS);

  return {
    ...state,
    status: "complete",
    stage: undefined,
    plan: input.plan,
    summary: input.summary,
    review: input.review,
    failures: input.failures,
    revisions,
    // Whatever was pending is now either what we just committed, or was
    // computed against a timeline that no longer exists. Either way it must not
    // survive this write.
    proposal: undefined,
    modelVersion: input.plan.modelVersion,
    planVersion: input.plan.planVersion,
    completedAt: now,
    errorMessage: undefined,
  };
}

/**
 * Record a plan the user has NOT accepted — Plan mode's terminal state.
 *
 * Status is `proposed`, never `complete`: nothing was applied. The previous
 * plan/summary/review are left exactly as they were, because they still
 * describe the timeline the user is looking at. Only `proposal` is new.
 */
export function proposeRun(
  state: DirectorState,
  input: Omit<DirectorProposal, "createdAt"> & { now?: number }
): DirectorState {
  const now = input.now ?? Date.now();
  return {
    ...state,
    status: "proposed",
    stage: undefined,
    errorMessage: undefined,
    completedAt: now,
    proposal: {
      plan: input.plan,
      summary: input.summary,
      review: input.review,
      failures: input.failures,
      command: input.command,
      createdAt: now,
    },
  };
}

/**
 * Drop a pending proposal.
 *
 * Also the guard against a stale one: any change that moves the timeline out
 * from under a proposal (an instant-mode edit, an undo) must call this, because
 * a proposal's summary was computed against the timeline as it was, and showing
 * it afterwards would describe a result approving can no longer produce.
 *
 * Status falls back to what the applied history says, NOT to `complete` —
 * discarding the very first proposal leaves a project that was never directed.
 */
export function clearProposal(state: DirectorState): DirectorState {
  if (!state.proposal) return state;
  const next = { ...state, proposal: undefined };
  if (state.status !== "proposed") return next;
  return { ...next, status: state.revisions.length ? "complete" : "idle" };
}

export function failRun(
  state: DirectorState,
  message: string,
  failures: DirectorFailure[] = [],
  now = Date.now()
): DirectorState {
  return {
    ...state,
    // NEVER "complete" — the timeline didn't change, and saying otherwise would
    // send the user to an export that isn't what they asked for.
    status: "failed",
    stage: undefined,
    failures,
    errorMessage: message,
    completedAt: now,
  };
}

/** The plan to replay in order to undo the last revision. */
export interface UndoTarget {
  /** The plan to re-execute. `null` = undo everything (remove all Director edits). */
  plan: DirectorPlan | null;
  /** The revision index to execute it as. */
  revision: number;
  /** The state after the undo. */
  state: DirectorState;
  /** What was undone, for the user. */
  undoneCommand: string;
}

/**
 * Undo the last Director change.
 *
 * Pops the newest revision and returns the plan that came before it, for the
 * caller to replay through the pipeline. Undoing the ONLY revision returns
 * `plan: null`, which means "remove every Director edit" — the timeline returns
 * to exactly what the user + the normal analysis had before the Director ran.
 *
 * Returns null when there is nothing to undo.
 */
export function undoLastRevision(state: DirectorState): UndoTarget | null {
  if (!state.revisions.length) return null;

  const revisions = state.revisions.slice(0, -1);
  const undone = state.revisions[state.revisions.length - 1];
  const restore = revisions[revisions.length - 1];

  if (!restore) {
    // Undoing the initial run: no plan survives, so every Director edit goes.
    return {
      plan: null,
      revision: 0,
      undoneCommand: undone.command || "the initial edit",
      state: {
        ...state,
        status: "idle",
        stage: undefined,
        plan: undefined,
        summary: undefined,
        review: undefined,
        failures: [],
        revisions: [],
        // An undo moves the timeline, so any pending proposal now describes a
        // result approving it could no longer produce.
        proposal: undefined,
      },
    };
  }

  return {
    plan: restore.plan,
    // Replay under the SAME revision index it originally ran at, so the restored
    // moments get byte-identical ids to the ones that existed before the undone
    // revision. Anything else would leave dangling references.
    revision: restore.index,
    undoneCommand: undone.command || "the last change",
    state: {
      ...state,
      status: "complete",
      stage: undefined,
      plan: restore.plan,
      summary: restore.summary,
      review: restore.review,
      failures: restore.failures,
      revisions,
      proposal: undefined,
      modelVersion: restore.plan.modelVersion,
      planVersion: restore.plan.planVersion,
    },
  };
}

/** True when this exact request already produced the current plan. */
export function isSameRequest(
  state: DirectorState | undefined,
  requestHash: string
): boolean {
  return (
    !!state &&
    state.status === "complete" &&
    state.requestHash === requestHash &&
    !!state.plan
  );
}

/**
 * Strip `undefined` recursively. Firestore REJECTS undefined field values, and a
 * rejected write is how a "completed" Director run silently fails to survive a
 * refresh. Every state write goes through this.
 */
export function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefinedDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefinedDeep(v);
    }
    return out as T;
  }
  return value;
}
