/**
 * AI Director — plan validator.
 *
 * THE GATE. Every plan passes through here before a single edit is created —
 * the model's plan and the heuristic plan alike. Nothing downstream trusts an
 * operation this module didn't pass.
 *
 * Its contract is deliberately narrow and honest:
 *   • It REJECTS operations, never rewrites them into something plausible. A
 *     hallucinated edit type becomes a reported failure the user can see, not a
 *     silent coercion to `zoom` that puts the wrong edit on the timeline.
 *   • It CLAMPS only what is unambiguously a bounds problem (an op that runs
 *     0.3s past the end of the video is clamped; an op that starts after the
 *     video ends is rejected).
 *   • A rejected op NEVER sinks the run — `executePlan` applies everything that
 *     validated and reports the rest.
 *
 * Pure. No I/O.
 */
import {
  DIRECTOR_SECTION_ORDER,
  isDirectorEditType,
  type DirectorAudioOperation,
  type DirectorClipOperation,
  type DirectorEditOperation,
  type DirectorFailure,
  type DirectorPlan,
  type DirectorSection,
} from "./types";

export interface DirectorValidation {
  /** The plan with every invalid operation removed and bounds clamped. */
  plan: DirectorPlan;
  /** Every operation that did NOT survive, with a reason the user can read. */
  failures: DirectorFailure[];
  /** True when the plan still has at least one applicable operation. */
  usable: boolean;
}

/** Windows shorter than this can't render as anything but a glitch. */
const MIN_OP_SECONDS = 0.15;
/** Tolerance for an op that overruns the end of the video — clamp, don't reject. */
const BOUNDS_SLACK = 0.5;

function fail(
  operationId: string,
  subject: string,
  reason: DirectorFailure["reason"],
  detail: string
): DirectorFailure {
  return { operationId, subject, reason, detail };
}

/**
 * Validate a window against the source duration.
 * Returns the clamped window, or null when it is unsalvageable.
 */
function checkWindow(
  start: number,
  end: number,
  duration: number
): { start: number; end: number } | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < -BOUNDS_SLACK) return null;
  if (start >= duration) return null; // starts after the video ends — not a bounds slip
  if (end <= start) return null;

  const s = Math.max(0, start);
  const e = Math.min(duration, end);
  if (e - s < MIN_OP_SECONDS) return null;
  return { start: s, end: e };
}

/**
 * Validate a plan against the real source duration.
 *
 * `duration` is the SOURCE duration in seconds — the authority for every bounds
 * check. A plan built against a stale duration (e.g. the source was re-uploaded)
 * fails loudly here rather than producing edits hanging off the end of the video.
 */
export function validateDirectorPlan(
  plan: DirectorPlan,
  duration: number
): DirectorValidation {
  const failures: DirectorFailure[] = [];

  if (!(duration > 0)) {
    return {
      plan: { ...plan, storyStructure: [], clipOperations: [], editOperations: [], audioOperations: [] },
      failures: [
        fail(
          "plan",
          "plan",
          "invalid_window",
          "The project has no known duration yet — the Director can't place edits without one."
        ),
      ],
      usable: false,
    };
  }

  const seenIds = new Set<string>();
  /** Duplicate detection: same id, OR the same (type + window) twice. */
  const seenSignatures = new Set<string>();

  // ── Sections ─────────────────────────────────────────────────────────────
  const sections: DirectorSection[] = [];
  for (const s of plan.storyStructure) {
    const w = checkWindow(s.startTime, s.endTime, duration);
    if (!w) {
      failures.push(
        fail(
          s.id,
          `section "${s.title}"`,
          "invalid_window",
          `Section window ${s.startTime.toFixed(1)}s–${s.endTime.toFixed(1)}s is outside the ${duration.toFixed(1)}s video.`
        )
      );
      continue;
    }
    if (DIRECTOR_SECTION_ORDER[s.kind] === undefined) {
      failures.push(
        fail(s.id, `section "${s.title}"`, "unsupported_operation", `Unknown section kind "${s.kind}".`)
      );
      continue;
    }
    if (seenIds.has(s.id)) {
      failures.push(
        fail(s.id, `section "${s.title}"`, "duplicate_operation", `Duplicate section id "${s.id}".`)
      );
      continue;
    }
    seenIds.add(s.id);
    sections.push({ ...s, startTime: w.start, endTime: w.end });
  }

  /**
   * STORY ORDER. Sections must appear in canonical narrative order
   * (hook → context → demo → result → cta). A plan whose CTA precedes its demo
   * isn't a stylistic choice — it's a broken story, and it would produce a video
   * that ends in the middle. We sort rather than reject, because the section
   * WINDOWS are the real data and their order is derivable from them.
   */
  sections.sort((a, b) => {
    const byKind = DIRECTOR_SECTION_ORDER[a.kind] - DIRECTOR_SECTION_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    return a.startTime - b.startTime;
  });

  const sectionIds = new Set(sections.map((s) => s.id));

  // ── Clip operations ──────────────────────────────────────────────────────
  const clipOperations: DirectorClipOperation[] = [];
  for (const o of plan.clipOperations) {
    /**
     * REORDER IS NOT RENDERABLE. `buildTimelineMap` (the one source of truth for
     * cuts + speed, shared by preview, browser export, the Cloud Run worker and
     * Remotion) walks source time strictly forwards. There is no representation
     * for "play 40s–50s before 10s–20s" anywhere in the render pipeline.
     *
     * Rejecting it here is the honest move: the alternative is accepting the op,
     * emitting cuts that keep both windows, and shipping a video in the WRONG
     * ORDER while telling the user we reordered it.
     */
    if (o.kind === "reorder") {
      failures.push(
        fail(
          o.id,
          "clip reorder",
          "unsupported_operation",
          "Clip reordering isn't supported: Framevo's render pipeline plays source time in order, so a reordered clip can't be previewed or exported. The clips were kept in their original order."
        )
      );
      continue;
    }

    const w = checkWindow(o.startTime, o.endTime, duration);
    if (!w) {
      failures.push(
        fail(
          o.id,
          `clip ${o.kind}`,
          o.startTime >= duration ? "out_of_bounds" : "invalid_window",
          `Window ${o.startTime.toFixed(1)}s–${o.endTime.toFixed(1)}s is not inside the ${duration.toFixed(1)}s video.`
        )
      );
      continue;
    }

    const sig = `clip:${o.kind}:${w.start.toFixed(2)}:${w.end.toFixed(2)}`;
    if (seenIds.has(o.id) || seenSignatures.has(sig)) {
      failures.push(
        fail(
          o.id,
          `clip ${o.kind}`,
          "duplicate_operation",
          `A ${o.kind} operation for ${w.start.toFixed(1)}s–${w.end.toFixed(1)}s already exists.`
        )
      );
      continue;
    }
    seenIds.add(o.id);
    seenSignatures.add(sig);

    if (o.sectionId && !sectionIds.has(o.sectionId)) {
      // Dangling section ref — keep the op, drop the ref. It's still a valid cut.
      clipOperations.push({ ...o, startTime: w.start, endTime: w.end, sectionId: undefined });
      continue;
    }
    clipOperations.push({ ...o, startTime: w.start, endTime: w.end });
  }

  // ── Edit operations ──────────────────────────────────────────────────────
  const editOperations: DirectorEditOperation[] = [];
  for (const o of plan.editOperations) {
    // The allowlist. This is the single check that makes "the Director can never
    // generate an unsupported edit type" true rather than aspirational.
    if (!isDirectorEditType(o.editType)) {
      failures.push(
        fail(
          o.id,
          String(o.editType || "unknown"),
          "unsupported_edit_type",
          `"${o.editType}" isn't an edit type Framevo can apply. Nothing was added for it.`
        )
      );
      continue;
    }

    const w = checkWindow(o.startTime, o.endTime, duration);
    if (!w) {
      failures.push(
        fail(
          o.id,
          o.editType,
          o.startTime >= duration ? "out_of_bounds" : "invalid_window",
          `Window ${o.startTime.toFixed(1)}s–${o.endTime.toFixed(1)}s is not inside the ${duration.toFixed(1)}s video.`
        )
      );
      continue;
    }

    // Text-bearing edits with no text would render as an empty plate.
    const needsText =
      o.editType === "hook-text" || o.editType === "text-overlay" || o.editType === "callout";
    if (needsText && !o.params?.text?.trim()) {
      failures.push(
        fail(o.id, o.editType, "missing_params", `A ${o.editType} needs text, and none was provided.`)
      );
      continue;
    }
    if (o.editType === "branding-cta" && !o.params?.ctaText?.trim()) {
      failures.push(
        fail(o.id, o.editType, "missing_params", "A CTA needs text, and none was provided.")
      );
      continue;
    }
    if (o.editType === "speed-up" && !(Number(o.params?.speedMultiplier) > 1)) {
      failures.push(
        fail(
          o.id,
          o.editType,
          "missing_params",
          "A speed-up needs a multiplier greater than 1×."
        )
      );
      continue;
    }

    const sig = `edit:${o.editType}:${w.start.toFixed(2)}:${w.end.toFixed(2)}`;
    if (seenIds.has(o.id) || seenSignatures.has(sig)) {
      failures.push(
        fail(
          o.id,
          o.editType,
          "duplicate_operation",
          `A ${o.editType} for ${w.start.toFixed(1)}s–${w.end.toFixed(1)}s already exists.`
        )
      );
      continue;
    }
    seenIds.add(o.id);
    seenSignatures.add(sig);

    editOperations.push({
      ...o,
      startTime: w.start,
      endTime: w.end,
      ...(o.sectionId && !sectionIds.has(o.sectionId) ? { sectionId: undefined } : {}),
    });
  }

  // ── Audio operations ─────────────────────────────────────────────────────
  const audioOperations: DirectorAudioOperation[] = [];
  for (const o of plan.audioOperations) {
    const w = checkWindow(o.startTime, o.endTime, duration);
    if (!w) {
      failures.push(
        fail(
          o.id,
          `audio ${o.kind}`,
          o.startTime >= duration ? "out_of_bounds" : "invalid_window",
          `Window ${o.startTime.toFixed(1)}s–${o.endTime.toFixed(1)}s is not inside the ${duration.toFixed(1)}s video.`
        )
      );
      continue;
    }
    const sig = `audio:${o.kind}:${w.start.toFixed(2)}:${w.end.toFixed(2)}`;
    if (seenIds.has(o.id) || seenSignatures.has(sig)) {
      failures.push(
        fail(o.id, `audio ${o.kind}`, "duplicate_operation", `A ${o.kind} for this window already exists.`)
      );
      continue;
    }
    seenIds.add(o.id);
    seenSignatures.add(sig);
    audioOperations.push({ ...o, startTime: w.start, endTime: w.end });
  }

  const validated: DirectorPlan = {
    ...plan,
    storyStructure: sections,
    clipOperations,
    editOperations,
    audioOperations,
  };

  const usable =
    editOperations.length > 0 ||
    clipOperations.some((o) => o.kind === "remove" || o.kind === "trim") ||
    audioOperations.some((o) => o.kind !== "keep-audio") ||
    validated.captionInstructions.enabled;

  return { plan: validated, failures, usable };
}
