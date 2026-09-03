/**
 * AI Director — the chat turn.
 *
 * One message in, one timeline change out. This is the whole engine behind the
 * editor's AI panel, and it is deliberately PURE: no network, no Firebase, no
 * React. The caller supplies the project and the current timeline, and persists
 * whatever comes back.
 *
 * ── Why a follow-up costs nothing ─────────────────────────────────────────────
 * The expensive part of directing a video — watching it, transcribing it,
 * finding the moments — already happened during analysis and is stored in the
 * project. A follow-up ("make it 30 seconds", "fewer zooms") is a PATCH TO THE
 * PLAN followed by a deterministic re-execution, so it runs here, in the
 * browser, in a millisecond, for free. Only the FIRST plan needs the model, and
 * that one comes from the analyze route.
 *
 * That is what makes the chat feel like a chat instead of a queue.
 *
 * ── Why Plan mode can't lie ──────────────────────────────────────────────────
 * A proposal is produced by running the REAL pipeline and throwing the moments
 * away. It is not a prediction of the result; it is the result, unpersisted. So
 * "this would remove 12 pauses" cannot turn into 9 on approval.
 *
 * The one thing a proposal must never do is outlive the timeline it was
 * computed against — see `clearProposal` in state.ts.
 */
import type {
  DetectedMoment,
  EffectsSettings,
  OutputCanvas,
  ProjectDoc,
} from "../firebase/schema";
import { buildDirectorContext } from "./context-builder";
import { runDirectorPipeline } from "./pipeline";
import {
  applyRevision,
  parseRevisionCommand,
  type DirectorRevisionIntent,
} from "./revision";
import { clearProposal, commitRun, proposeRun, undoLastRevision } from "./state";
import type { DirectorPlan, DirectorState, DirectorSummary } from "./types";
import { resolveProjectPolicy } from "../editorial/resolve";
import { getTemplate } from "../editorial/templates";

/**
 * Instant applies; Plan proposes.
 *
 * Instant is the default everywhere and the mode the panel opens in: the whole
 * point of a local, deterministic, free revision is that you can just try it and
 * undo. Plan exists for the changes big enough that you want to read them first.
 */
export type ChatMode = "instant" | "plan";

/**
 * Changes this engine understands, in the user's own words.
 *
 * Every one of these is a command `parseRevisionCommand` really handles —
 * showing an example that then isn't understood would teach the opposite of
 * what an example is for. They are examples, not a grammar: the parser also
 * takes typos, synonyms and several instructions in one sentence, and anything
 * it still can't place escalates to the model rather than being refused.
 */
export const CHAT_EXAMPLES = [
  "Make it 30 seconds",
  "Change it to vertical",
  "Remove the zooms and the focus",
  "Fewer transitions",
  "Make the beginning faster",
  "Stronger call to action",
] as const;

/**
 * Openers for a video that hasn't been directed yet.
 *
 * These are BRIEFS, not revisions — the first message describes the video you
 * want, and goes to the model. Different job, so different examples.
 */
export const CHAT_BRIEF_EXAMPLES = [
  "A 30-second vertical clip for TikTok",
  "Punchy product demo, cut the dead air",
  "Calm walkthrough with captions",
] as const;

export interface ChatTurnInput {
  /** The project, carrying `director` and the analysis the plan was built on. */
  project: ProjectDoc;
  /** The CURRENT timeline. Director edits are replaced; user edits preserved. */
  moments: DetectedMoment[];
  command: string;
  mode: ChatMode;
  now?: number;
}

/** A change that landed (or would land) on the timeline. */
export interface ChatChange {
  state: DirectorState;
  summary: DirectorSummary;
  /** Plain-English record of what each understood intent actually did. */
  changes: string[];
  /** Intents that matched nothing — reported, never swallowed. */
  noops: string[];
}

export type ChatTurnResult =
  /** No plan yet: this project has never been directed. Run a full analysis. */
  | { kind: "needs-analysis" }
  /**
   * The LOCAL parser couldn't place this message.
   *
   * Deliberately not a final answer. The caller is expected to escalate to the
   * model (`/api/director/understand`) and try again with the intents it
   * returns; only when that also comes back empty does `reply` get shown, and
   * even then `canRedirect` says there is still a way forward — the message can
   * be run as a fresh brief, which is the path that handles arbitrary language
   * because a model plans it end to end.
   */
  | { kind: "not-understood"; reply: string; command: string; canRedirect: boolean }
  /** Understood, but it changed nothing (e.g. "remove the 9th clip" with 4 clips). */
  | { kind: "nothing-to-do"; reply: string; noops: string[] }
  /** Understood and applied. Persist `moments` AND `state`. */
  | ({ kind: "applied"; moments: DetectedMoment[]; outputCanvas?: OutputCanvas } & ChatChange)
  /** Understood; waiting for approval. Persist `state` ONLY — the timeline is untouched. */
  | ({ kind: "proposed" } & ChatChange)
  /** The plan came out empty or unexecutable. */
  | { kind: "failed"; reply: string };

/** The pipeline inputs every path here shares, read off the project once. */
function pipelineContext(project: ProjectDoc, effects?: EffectsSettings) {
  // The project's resolved editorial policy — a chat revision is judged under
  // the SAME template as the run that produced the timeline, so the
  // conversation can steer the Editorial Engine but never bypass it. Classic
  // resolutions carry mode "classic" and the gate stays inert.
  const policy = resolveProjectPolicy(project);
  return {
    duration: Math.max(0, project.duration ?? 0),
    transcript: project.analysis?.transcript ?? null,
    videoType: project.selectedVideoType,
    sourceWidth: project.width,
    sourceHeight: project.height,
    effects: effects ?? (project.effectsSettings as EffectsSettings | undefined),
    policy: {
      statuses: policy.statuses,
      mode: policy.mode,
      templateName: getTemplate(policy.templateId)?.name,
    },
  };
}

/**
 * Run one message.
 *
 * Note the order: parse, then apply to the plan, then execute. A command that
 * isn't understood never reaches the plan, and a plan that changes nothing never
 * reaches the timeline — so the two ways this can disappoint a user are both
 * reported as themselves rather than as a successful edit that did nothing.
 */
export function runChatTurn(input: ChatTurnInput): ChatTurnResult {
  const director = input.project.director as DirectorState | undefined;
  if (!director?.plan) return { kind: "needs-analysis" };

  const parsed = parseRevisionCommand(input.command);
  if (parsed.unrecognized || parsed.intents.length === 0) {
    return {
      kind: "not-understood",
      reply: NOT_UNDERSTOOD_REPLY,
      command: input.command,
      canRedirect: true,
    };
  }

  return runChatTurnWithIntents(input, parsed.intents);
}

/**
 * The reply of last resort — shown only after the model has also failed to place
 * the message.
 *
 * It states what it CAN'T do and immediately offers the thing it can, because a
 * chat that answers a real request with a list of accepted phrasings is teaching
 * the user to talk like a parser. The re-direct offer is not a consolation
 * prize: it is the path that genuinely handles any sentence.
 */
const NOT_UNDERSTOOD_REPLY =
  "I couldn't turn that into a change to the current edit. I can re-direct the whole video with that as the brief instead — or tell me about a length, a shape, or an edit type (“make it 30 seconds”, “vertical”, “remove the zooms”) and I'll patch what's there.";

/**
 * Run a turn from intents that are ALREADY understood.
 *
 * Split out from `runChatTurn` so the model escalation path and the local parser
 * converge here: whichever one read the message, the change is applied by the
 * same code, validated by the same validator and executed by the same pipeline.
 * There is no "model revision" that could behave differently from a typed one.
 */
export function runChatTurnWithIntents(
  input: ChatTurnInput,
  intents: DirectorRevisionIntent[]
): ChatTurnResult {
  const director = input.project.director as DirectorState | undefined;
  const plan = director?.plan;
  if (!director || !plan) return { kind: "needs-analysis" };

  if (intents.length === 0) {
    return {
      kind: "not-understood",
      reply: NOT_UNDERSTOOD_REPLY,
      command: input.command,
      canRedirect: true,
    };
  }

  const ctx = buildDirectorContext(input.project);
  // The index this revision WILL be committed at. The executor mints moment ids
  // from it (`dir_{revision}_{opId}`), so a proposal computed at one index and
  // approved at another would produce different ids than it showed. Approval
  // recomputes this rather than trusting the stored value.
  const revisionIndex = director.revisions.length;
  const revised = applyRevision(plan, intents, ctx, revisionIndex);

  if (revised.changes.length === 0) {
    return {
      kind: "nothing-to-do",
      reply:
        revised.noops[0] ??
        "That didn't match anything on the current plan, so I left the timeline alone.",
      noops: revised.noops,
    };
  }

  const result = runDirectorPipeline({
    plan: revised.plan,
    moments: input.moments,
    revision: revisionIndex,
    ...pipelineContext(input.project),
  });

  if (!result.applied) {
    return {
      kind: "failed",
      reply:
        result.failures[0]?.detail ??
        "That change left nothing the editor could apply, so I stopped rather than empty your timeline.",
    };
  }

  const shared = {
    summary: result.summary,
    changes: revised.changes,
    noops: revised.noops,
  };

  if (input.mode === "plan") {
    return {
      kind: "proposed",
      state: proposeRun(director, {
        plan: result.plan,
        summary: result.summary,
        review: result.review,
        failures: result.failures,
        command: input.command,
        now: input.now,
      }),
      ...shared,
    };
  }

  return {
    kind: "applied",
    moments: result.moments,
    ...(result.outputCanvas ? { outputCanvas: result.outputCanvas } : {}),
    // `clearProposal` first: an instant edit moves the timeline, which is
    // exactly what invalidates anything still pending review.
    state: commitRun(clearProposal(director), {
      plan: result.plan,
      summary: result.summary,
      review: result.review,
      failures: result.failures,
      appliedOperationIds: result.appliedOperationIds,
      command: input.command,
      now: input.now,
    }),
    ...shared,
  };
}

/**
 * Approve the pending proposal.
 *
 * Re-executes the stored plan against the timeline AS IT IS NOW, at the revision
 * index it is really being committed at — not against the timeline it was
 * proposed on. If something else changed in between, approval applies to what
 * the user is actually looking at, which is the only behaviour that can't
 * silently revert their other work.
 */
export function approveProposal(input: {
  project: ProjectDoc;
  moments: DetectedMoment[];
  now?: number;
}): ChatTurnResult {
  const director = input.project.director as DirectorState | undefined;
  const proposal = director?.proposal;
  if (!director || !proposal) return { kind: "failed", reply: "There's nothing to approve." };

  const revisionIndex = director.revisions.length;
  const result = runDirectorPipeline({
    plan: proposal.plan,
    moments: input.moments,
    revision: revisionIndex,
    ...pipelineContext(input.project),
  });

  if (!result.applied) {
    return {
      kind: "failed",
      reply:
        result.failures[0]?.detail ??
        "This plan no longer fits the timeline — the video changed after it was proposed.",
    };
  }

  return {
    kind: "applied",
    moments: result.moments,
    ...(result.outputCanvas ? { outputCanvas: result.outputCanvas } : {}),
    state: commitRun(director, {
      plan: result.plan,
      summary: result.summary,
      review: result.review,
      failures: result.failures,
      appliedOperationIds: result.appliedOperationIds,
      command: proposal.command,
      now: input.now,
    }),
    summary: result.summary,
    changes: [],
    noops: [],
  };
}

export interface ChatUndoResult {
  state: DirectorState;
  moments: DetectedMoment[];
  outputCanvas?: OutputCanvas;
  /** What was undone, in the user's words. */
  undoneCommand: string;
}

/**
 * Undo the last applied change.
 *
 * Replays the PREVIOUS plan through the same pipeline rather than restoring a
 * snapshot — deterministic execution means that reproduces the earlier timeline
 * exactly, and it is why history stores plans instead of copies of the timeline.
 * Undoing the very first change removes every Director edit and leaves the plain
 * analysis behind.
 */
export function undoLastChange(input: {
  project: ProjectDoc;
  moments: DetectedMoment[];
}): ChatUndoResult | null {
  const director = input.project.director as DirectorState | undefined;
  if (!director) return null;
  const target = undoLastRevision(director);
  if (!target) return null;

  const base = pipelineContext(input.project);

  // Nothing left to restore: strip every Director edit and keep the rest.
  if (!target.plan) {
    return {
      state: target.state,
      moments: input.moments.filter((m) => m.source !== "ai-director"),
      undoneCommand: target.undoneCommand,
    };
  }

  const result = runDirectorPipeline({
    plan: target.plan,
    moments: input.moments,
    revision: target.revision,
    ...base,
  });

  return {
    state: target.state,
    moments: result.moments,
    ...(result.outputCanvas ? { outputCanvas: result.outputCanvas } : {}),
    undoneCommand: target.undoneCommand,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Transcript
// ════════════════════════════════════════════════════════════════════════════

export interface ChatEntry {
  id: string;
  /** The user's words. Empty for the initial run, which nobody typed as a message. */
  command: string;
  /** What the change actually did, as bullets. */
  lines: string[];
  createdAt: number;
  /** Warnings the review raised on this change. */
  warnings: number;
  /** True for the newest applied entry — the only one that can be undone. */
  undoable: boolean;
}

/**
 * The applied history as a chat transcript.
 *
 * Derived, not stored: `DirectorState.revisions` already records every change
 * with the command that caused it, so the conversation IS the history. A
 * separate chat log would be a second source of truth that could disagree with
 * the timeline — the exact thing this codebase avoids everywhere else.
 */
export function transcriptFromState(state: DirectorState | undefined): ChatEntry[] {
  if (!state?.revisions?.length) return [];
  const last = state.revisions.length - 1;
  return state.revisions.map((r, i) => ({
    id: r.id,
    command: r.command,
    lines: r.summary?.lines ?? [],
    createdAt: r.createdAt,
    warnings: r.review?.warnings ?? 0,
    undoable: i === last,
  }));
}

/** A one-line description of a plan, for the proposal header. */
export function describePlan(plan: DirectorPlan): string {
  const ops =
    plan.clipOperations.length + plan.editOperations.length + plan.audioOperations.length;
  return `${ops} operation${ops === 1 ? "" : "s"} · ${plan.goal}`;
}
