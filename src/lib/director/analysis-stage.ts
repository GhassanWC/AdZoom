/**
 * The Director as a STAGE OF ANALYSIS.
 *
 * This is what makes "Direct my video" part of the main flow instead of a second,
 * disconnected pass. Analysis produces the understanding (transcript, moments,
 * narrative beats, attention curve); the Director is the last thing that runs
 * over it, turning the user's brief into real edits before anything is persisted.
 *
 * WHY A SHARED MODULE: the analyze route and the Director route must not grow two
 * different notions of what a Director run is. Both call `runDirectorStage`, so a
 * brief applied during analysis and a brief applied from the panel produce
 * byte-identical timelines — same plan, same validated presets, same moment ids.
 *
 * WHAT IT DOES NOT DO: it does not transcribe. Analysis never runs ASR (that is
 * the separate, quota-metered captions action), so when a brief asks for captions
 * and no transcript exists, this reports it and applies everything else. Spending
 * a user's caption minutes from a button that says "analyze" would be a bill they
 * didn't agree to.
 *
 * Server-only by virtue of `planDirector` (Gemini). Every other import is pure.
 */
import type {
  DetectedMoment,
  EffectsSettings,
  OutputCanvas,
  ProjectDoc,
} from "../firebase/schema";
import { buildDirectorContext } from "./context-builder";
import { planDirector } from "./gemini-planner";
import { runDirectorPipeline } from "./pipeline";
import { hashDirectorRequest, parseDirectorRequest } from "./request";
import { commitRun, failRun, proposeRun, startRun } from "./state";
import type { DirectorBrief, DirectorState } from "./types";

/** A line for the analysis activity log. Same shape the route already emits. */
export interface DirectorStageLog {
  kind: "info" | "ok" | "warn" | "error";
  text: string;
}

export interface RunDirectorStageInput {
  /**
   * The project AS IT WILL BE after this analysis — i.e. carrying the FRESH
   * analysis, not the one on disk. The Director plans against what analysis just
   * learned, which is the whole point of running it here rather than afterwards.
   */
  project: ProjectDoc;
  brief: DirectorBrief;
  /** The timeline analysis just produced. Director edits are layered onto this. */
  moments: DetectedMoment[];
  effects?: EffectsSettings;
  /** Prior Director state, if the project has been directed before. */
  prior?: DirectorState;
  /**
   * Plan mode: build the plan and report exactly what it WOULD do, but leave
   * the timeline alone.
   *
   * The pipeline still runs — that is the only way to know the real answer —
   * and its moments are then thrown away. Approving later re-runs it against
   * whatever the timeline is at that point, which is why nothing here is
   * cached beyond the plan itself.
   */
  planOnly?: boolean;
  /**
   * The run's editorial-policy slice (Editorial Engine, Phase 2C). Passed
   * through to the pipeline's judgment stage so a brief can't produce edit
   * categories the selected template forbids. Absent ⇒ pre-policy behaviour.
   */
  policy?: import("./pipeline").RunPipelineInput["policy"];
}

export interface RunDirectorStageResult {
  /** The finished timeline. On failure this is the INPUT timeline, untouched. */
  moments: DetectedMoment[];
  outputCanvas?: OutputCanvas;
  /** The state to persist on `project.director`. */
  state: DirectorState;
  /** True only when real Director edits landed. */
  applied: boolean;
  /** Lines for the analysis activity feed, in order. */
  log: DirectorStageLog[];
}

/**
 * Run the user's brief against a freshly-analyzed project.
 *
 * NEVER THROWS. A Director failure must not sink an analysis the user already
 * waited minutes for — the analysis result is real and worth keeping even if the
 * brief couldn't be applied. Failures come back as a `failed` state plus log
 * lines, and the caller persists the analysis regardless.
 */
export async function runDirectorStage(
  input: RunDirectorStageInput
): Promise<RunDirectorStageResult> {
  const { project, brief, moments, effects, prior } = input;
  const log: DirectorStageLog[] = [];
  const duration = Math.max(0, project.duration ?? 0);

  const unchanged = (state: DirectorState): RunDirectorStageResult => ({
    moments,
    state,
    applied: false,
    log,
  });

  const request = parseDirectorRequest(brief.prompt, brief.form);
  const requestHash = hashDirectorRequest(
    request,
    `${project.storagePath ?? ""}:${duration.toFixed(2)}`
  );
  let state = startRun(prior, brief.prompt, request, requestHash);

  // Say what it understood, in the user's terms, before doing anything with it.
  // A brief that was misread is the failure mode users can't debug on their own.
  const bits = [
    `${request.platform} · ${request.aspectRatio} · ${request.style}`,
    request.targetDurationSeconds
      ? `target ${request.targetDurationSeconds}s`
      : "no length target",
    request.captionStyle === "none" ? "no captions" : `${request.captionStyle} captions`,
    `CTA: ${request.cta}`,
  ];
  // "Framevo AI" is the one user-facing name for the intelligence — the
  // Director stays an internal architecture concept (approved rule 3). These
  // lines are shown verbatim in the activity feed, so they carry the name.
  log.push({ kind: "info", text: `Framevo AI understood — ${bits.join(", ")}` });

  const ctx = buildDirectorContext(project);
  if (!ctx.hasAnalysis && !ctx.hasTranscript) {
    // Nothing to plan against. Shouldn't happen (analysis just ran), but a plan
    // built on nothing would be invented, and inventing is the one thing we don't do.
    log.push({
      kind: "warn",
      text: "Framevo AI skipped your instructions — this analysis produced nothing to build a plan on.",
    });
    return unchanged(failRun(state, "No analysis or transcript to plan against."));
  }

  // Captions need REAL words. Analysis doesn't transcribe, so say plainly what's
  // missing and what to do about it, rather than silently dropping the captions
  // the user explicitly asked for.
  const wantsCaptions = request.captionStyle !== "none";
  if (wantsCaptions && !ctx.hasTranscript) {
    log.push({
      kind: "warn",
      text: 'Captions need a transcript — run "Generate AI Captions", then ask Framevo AI again. Every other instruction was applied.',
    });
  }

  let planned;
  try {
    planned = await planDirector(ctx, request);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.push({ kind: "warn", text: `Framevo AI could not build a plan — ${detail}` });
    return unchanged(failRun(state, detail));
  }

  if (planned.fallbackReason) {
    // The heuristic planner is a real planner, not a stub — say we used it, but
    // don't dress it up as the model's work.
    log.push({
      kind: "info",
      text: `Framevo AI planned without the model (${planned.fallbackReason}) — using the built-in planner.`,
    });
  }

  state = { ...state, status: "running", stage: "applying" };

  const result = runDirectorPipeline({
    plan: planned.plan,
    moments,
    duration,
    // The NEXT index in the existing history — matching what `commitRun` will
    // append below, so the moment ids (`dir_{revision}_{opId}`) and the revision
    // entry that explains them agree. Not 0: re-analyzing a project that was
    // already directed would then mint ids identical to the previous revision's,
    // and undo — which replays a stored plan at its own index — would restore the
    // wrong set of edits.
    revision: prior?.revisions.length ?? 0,
    transcript: project.analysis?.transcript ?? null,
    videoType: project.selectedVideoType,
    sourceWidth: project.width,
    sourceHeight: project.height,
    effects,
    ...(input.policy ? { policy: input.policy } : {}),
  });

  // ── Plan mode: report, don't apply. ───────────────────────────────────────
  // The check is the same one instant mode makes — a plan that would apply
  // nothing is a failure, and proposing it would ask the user to approve a
  // no-op. It has to fail here, before anything is shown as a choice.
  if (input.planOnly) {
    if (!result.applied) {
      const why =
        result.failures[0]?.detail ?? "No operation from the plan could be applied.";
      log.push({ kind: "warn", text: `Framevo AI had nothing to propose — ${why}` });
      return unchanged(failRun(state, why, result.failures));
    }
    log.push({
      kind: "ok",
      text: `Framevo AI proposed ${result.appliedOperationIds.length} change${
        result.appliedOperationIds.length === 1 ? "" : "s"
      } for review — the timeline is unchanged until you approve it.`,
    });
    return unchanged(
      proposeRun(state, {
        plan: result.plan,
        summary: result.summary,
        review: result.review,
        failures: result.failures,
        command: "",
      })
    );
  }

  if (!result.applied) {
    // "Applied nothing" is a failed run, however cleanly it failed. Never report
    // it as a success with an empty result.
    const why =
      result.failures[0]?.detail ?? "No operation from the plan could be applied.";
    log.push({ kind: "warn", text: `Framevo AI applied no edits — ${why}` });
    return unchanged(failRun(state, why, result.failures));
  }

  // ── Report the DESIGNS, by name. The user chose a style; which looks that
  // actually resolved to is the first thing they'll want to check. ───────────
  for (const p of result.summary.presets ?? []) {
    const how = p.chosenBy === "plan" ? "chose" : "matched";
    log.push({
      kind: "ok",
      text: `Framevo AI ${how} ${p.presetName} for ${p.slot} (${p.presetId}) — ${p.momentCount} edit${
        p.momentCount === 1 ? "" : "s"
      }`,
    });
  }

  // A preset id the plan named but the library doesn't have. Surfaced, not hidden:
  // the edit still landed wearing a real design, and the user should know which
  // request wasn't honoured.
  for (const f of result.failures) {
    if (f.reason !== "unknown_preset") continue;
    log.push({ kind: "warn", text: `Framevo AI: ${f.detail}` });
  }

  const applied = result.appliedOperationIds.length;
  log.push({
    kind: "ok",
    text: `Framevo AI applied ${applied} decision${applied === 1 ? "" : "s"}${
      result.summary.lines.length ? ` — ${result.summary.lines.join("; ")}` : ""
    }`,
  });

  const committed = commitRun(state, {
    plan: result.plan,
    summary: result.summary,
    review: result.review,
    failures: result.failures,
    appliedOperationIds: result.appliedOperationIds,
  });

  return {
    moments: result.moments,
    ...(result.outputCanvas ? { outputCanvas: result.outputCanvas } : {}),
    state: committed,
    applied: true,
    log,
  };
}
