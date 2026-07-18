/**
 * AI Director — the pipeline.
 *
 * ONE path from a plan to a finished timeline:
 *
 *     plan → validate → judge → execute → review → (fixed) timeline
 *
 * The initial run and every revision go through this exact function. There is no
 * second code path that could produce a timeline the first one couldn't, and no
 * place for the UI, the preview or the export to independently interpret the
 * model's response — by the time anything sees a result, it is already a
 * validated, editorially-judged plan compiled into ordinary `DetectedMoment`s.
 *
 * The JUDGE step is the decision engine: `validate` only asks whether an
 * operation CAN exist (a real edit type, an in-bounds window, required params
 * present); `applyEditorialJudgment` asks whether it DESERVES to — a real
 * reason, real evidence, honest confidence, and no crowding out its neighbors.
 * An edit that fails validation is broken; an edit that fails judgment is fine,
 * just not good enough to keep. Both are reported as failures either way, and
 * neither one sinks the run.
 *
 * Pure. No I/O, no model calls. The caller supplies the plan (from Gemini or the
 * heuristic planner) and persists the result.
 */
import type {
  DetectedMoment,
  EffectsSettings,
  OutputCanvas,
  SelectedVideoType,
  Transcript,
} from "../firebase/schema";
import { applyEditorialJudgment } from "./editorial-judgment";
import { executePlan } from "./executor";
import { reviewDirectorResult } from "./review";
import { validateDirectorPlan } from "./validate";
import type {
  DirectorFailure,
  DirectorPlan,
  DirectorReviewResult,
  DirectorSummary,
} from "./types";
import { buildTimelineMap } from "../timeline/crop-speed";

export interface RunPipelineInput {
  plan: DirectorPlan;
  /** The current timeline. Prior Director edits are replaced; user edits kept. */
  moments: DetectedMoment[];
  duration: number;
  revision: number;
  transcript?: Transcript | null;
  videoType?: SelectedVideoType;
  sourceWidth?: number;
  sourceHeight?: number;
  effects?: EffectsSettings;
}

export interface RunPipelineResult {
  /** The VALIDATED, JUDGED plan — this, not the input plan, is what gets persisted. */
  plan: DirectorPlan;
  /** The finished timeline, after execution AND the review's auto-fixes. */
  moments: DetectedMoment[];
  outputCanvas?: OutputCanvas;
  summary: DirectorSummary;
  review: DirectorReviewResult;
  /** Validation rejections + editorial judgment rejections + executor failures, together. */
  failures: DirectorFailure[];
  appliedOperationIds: string[];
  /**
   * False when NOTHING was applied. The caller must NOT report "complete" in
   * this case — a run that produced no timeline change is a failed run, however
   * cleanly it failed.
   */
  applied: boolean;
}

export function runDirectorPipeline(input: RunPipelineInput): RunPipelineResult {
  const { duration } = input;

  // ── 1. Validate. Rejected ops become reported failures, not silent drops. ──
  const validation = validateDirectorPlan(input.plan, duration);

  // ── 2. Judge. The decision engine: is each surviving edit actually earned? ─
  // Runs on the STRUCTURALLY valid plan only — judging a window that's already
  // out of bounds or missing required params would be double work for no gain.
  const judgment = applyEditorialJudgment(validation.plan);

  // ── 3. Execute the judged plan. Per-op failures don't sink the run. ───────
  const execution = executePlan({
    plan: judgment.plan,
    moments: input.moments,
    duration,
    revision: input.revision,
    transcript: input.transcript,
    videoType: input.videoType,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    effects: input.effects,
  });

  // ── 4. Review the REAL timeline and apply the safe fixes. ────────────────
  // The review sees the executed timeline (with the new canvas already in
  // effect), so a caption safe-area check on a 9:16 reframe tests the aspect the
  // video will actually be exported at — not the one it had a moment ago.
  const effectsForReview: EffectsSettings | undefined = execution.outputCanvas
    ? ({
        ...(input.effects ?? ({} as EffectsSettings)),
        outputCanvas: execution.outputCanvas,
      } as EffectsSettings)
    : input.effects;

  const review = reviewDirectorResult({
    plan: judgment.plan,
    moments: execution.moments,
    duration,
    effects: effectsForReview,
    reportedOutputDuration: execution.summary.outputDurationSeconds,
  });

  // ── 5. The review's auto-fixes CHANGED the timeline, so the summary has to be
  // recomputed from what actually survived. Reporting the pre-fix numbers would
  // be exactly the kind of quiet lie this feature can't afford: if the review
  // disabled 3 zooms, the summary must not still claim 9. ───────────────────
  const finalMoments = review.moments;
  const map = buildTimelineMap(finalMoments, duration);
  const summary = recountSummary(execution.summary, finalMoments, map.outputDuration, map.totalRemoved);

  const failures: DirectorFailure[] = [
    ...validation.failures,
    ...judgment.failures,
    ...execution.failures,
  ];

  return {
    plan: judgment.plan,
    moments: finalMoments,
    ...(execution.outputCanvas ? { outputCanvas: execution.outputCanvas } : {}),
    summary,
    review,
    failures,
    appliedOperationIds: execution.appliedOperationIds,
    // "Applied" means real edits exist on the timeline — the ONLY basis on which
    // we're allowed to tell the user the Director completed.
    applied: execution.appliedOperationIds.length > 0,
  };
}

/**
 * Recount the summary from the FINAL timeline. Only edits that are still present
 * AND still enabled are counted — a zoom the review turned off is not a zoom the
 * user got.
 */
function recountSummary(
  base: DirectorSummary,
  moments: DetectedMoment[],
  outputDuration: number,
  removedSeconds: number
): DirectorSummary {
  const counts: DirectorSummary["counts"] = {};
  const presetUse = new Map<string, number>();
  let pausesRemoved = 0;
  let hookSeconds = 0;

  for (const m of moments) {
    if (m.source !== "ai-director") continue;
    if (m.enabled === false) continue; // disabled by the review — don't claim it
    const t = m.effectType as keyof DirectorSummary["counts"];
    counts[t] = (counts[t] ?? 0) + 1;
    // Recount the designs off the real moments too. A preset whose every edit the
    // review disabled is a preset the user did not get, and must not be listed.
    if (m.preset?.id) presetUse.set(m.preset.id, (presetUse.get(m.preset.id) ?? 0) + 1);
    if (m.effectType === "cut" && (m.label === "Silence" || m.label === "Filler")) {
      pausesRemoved += 1;
    }
    if (m.effectType === "hook-text") {
      hookSeconds = Math.max(hookSeconds, m.endTime - m.startTime);
    }
  }

  const presets = (base.presets ?? [])
    .map((p) => ({ ...p, momentCount: presetUse.get(p.presetId) ?? 0 }))
    .filter((p) => p.momentCount > 0);

  const lines: string[] = [];
  const fmt = (s: number) => {
    const v = Math.max(0, Math.round(s));
    return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
  };
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  if (outputDuration > 0 && Math.abs(base.sourceDurationSeconds - outputDuration) > 0.5) {
    lines.push(
      `Reduced video from ${fmt(base.sourceDurationSeconds)} to ${fmt(outputDuration)}`
    );
  }
  if (pausesRemoved > 0) lines.push(`Removed ${plural(pausesRemoved, "pause", "pauses")}`);
  if (hookSeconds > 0) lines.push(`Created a ${hookSeconds.toFixed(0)}-second hook`);
  if (counts.captions) lines.push(`Added ${plural(counts.captions, "caption", "captions")}`);
  if (counts.zoom) lines.push(`Added ${plural(counts.zoom, "zoom", "zooms")}`);
  if (counts.callout) lines.push(`Added ${plural(counts.callout, "callout", "callouts")}`);
  if (counts["text-overlay"]) {
    lines.push(`Added ${plural(counts["text-overlay"], "text overlay", "text overlays")}`);
  }
  if (counts["speed-up"]) {
    lines.push(`Sped up ${plural(counts["speed-up"], "section", "sections")}`);
  }
  if (counts.transition) {
    lines.push(`Added ${plural(counts.transition, "transition", "transitions")}`);
  }
  if (counts["smart-crop"]) lines.push("Reframed the canvas");
  if (counts["branding-cta"]) lines.push("Added a final CTA");

  // Name the designs. The user picked a style, and "which look did it actually
  // use" is the first thing they'll want to check against what they asked for.
  if (presets.length > 0) {
    lines.push(`Styled with ${presets.map((p) => p.presetName).join(", ")}`);
  }

  return {
    ...base,
    outputDurationSeconds: outputDuration,
    removedSeconds,
    pausesRemoved,
    hookSeconds,
    counts,
    ...(presets.length ? { presets } : { presets: undefined }),
    lines,
  };
}
