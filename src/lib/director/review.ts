/**
 * AI Director — review engine.
 *
 * Runs AFTER the plan is applied, against the REAL timeline the executor
 * produced — not against the plan's intentions. That distinction is the whole
 * point: a plan can promise a CTA and still not produce one (the op failed, the
 * window got cut). The review only ever reports what it can actually observe on
 * the timeline.
 *
 * Two kinds of outcome, and the line between them is deliberate:
 *   • AUTO-FIX — only where the correct fix is unambiguous (a caption below the
 *     safe area, an edit hanging 0.3s off the end, two identical overlays).
 *     These are mechanical mistakes with exactly one right answer.
 *   • WARN — anything editorial (a missing CTA, a silent stretch, a target
 *     duration overshoot). Quietly rewriting a user's video to satisfy a
 *     heuristic is worse than telling them what we noticed.
 *
 * Deterministic + pure: same timeline in, same findings out. No model, no I/O.
 */
import type { DetectedMoment, EffectsSettings } from "../firebase/schema";
import { buildTimelineMap } from "../timeline/crop-speed";
import { resolveTextStyleValues } from "../render/text-style";
import { CLASSIC_ZOOM_COMPOSITION } from "../editorial/constants";
import { zoomDensityPass } from "../editorial/composition";
import { isDirectorMoment } from "./executor";
import type {
  DirectorPlan,
  DirectorReviewFinding,
  DirectorReviewResult,
  DirectorReviewRuleId,
  DirectorReviewSeverity,
} from "./types";

export interface ReviewInput {
  plan: DirectorPlan;
  /** The timeline the executor produced. */
  moments: DetectedMoment[];
  duration: number;
  effects?: EffectsSettings;
  /** The output duration the executor reported — cross-checked, not trusted. */
  reportedOutputDuration: number;
}

export interface ReviewOutput extends DirectorReviewResult {
  /** The timeline after auto-fixes. Same array when nothing was fixed. */
  moments: DetectedMoment[];
}

/**
 * Vertical safe area, as a fraction of canvas height. Below 0.88 on a 9:16 feed
 * is where TikTok/Reels stack their own UI (caption text, buttons), so anything
 * drawn there is partly invisible to a real viewer even though it looks fine in
 * our preview.
 */
const SAFE_TOP = 0.08;
const SAFE_BOTTOM = 0.88;

/**
 * Zoom-density backstop numbers — sourced from the editorial constants module
 * (the single owner; see tests/editorial-ownership.test.ts). Values unchanged.
 */
const MIN_ZOOM_GAP_SECONDS = CLASSIC_ZOOM_COMPOSITION.minGapSeconds;
const MAX_ZOOMS_PER_MINUTE = CLASSIC_ZOOM_COMPOSITION.maxPerOutputMinute;

/** A surviving segment shorter than this can't read as a shot. */
const MIN_SEGMENT_SECONDS = 0.7;

/** A kept stretch longer than this with nothing happening is dead screen time. */
const MAX_SILENT_STRETCH = 8;

function enabled(plan: DirectorPlan, rule: DirectorReviewRuleId): boolean {
  return plan.reviewRules.find((r) => r.id === rule)?.enabled !== false;
}

function canAutoFix(plan: DirectorPlan, rule: DirectorReviewRuleId): boolean {
  return plan.reviewRules.find((r) => r.id === rule)?.autoFix === true;
}

function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < bE && bS < aE;
}

export function reviewDirectorResult(input: ReviewInput): ReviewOutput {
  const { plan, duration, reportedOutputDuration } = input;
  const findings: DirectorReviewFinding[] = [];
  // Work on a copy — auto-fixes mutate this, and the caller persists it.
  let moments = input.moments.map((m) => ({ ...m }));
  let findingSeq = 0;

  const add = (
    rule: DirectorReviewRuleId,
    severity: DirectorReviewSeverity,
    message: string,
    momentIds: string[],
    opts: { at?: number; fixed?: boolean; fixDetail?: string } = {}
  ) => {
    findingSeq += 1;
    findings.push({
      id: `rev-${findingSeq}`,
      rule,
      severity,
      message,
      momentIds,
      fixed: opts.fixed === true,
      ...(opts.at !== undefined ? { at: opts.at } : {}),
      ...(opts.fixDetail ? { fixDetail: opts.fixDetail } : {}),
    });
  };

  /** Only Director edits are ever auto-fixed. The user's edits are untouchable. */
  const dir = () => moments.filter(isDirectorMoment);

  const aspect = input.effects?.outputCanvas?.aspectRatio ?? plan.aspectRatio;
  const isVertical = aspect === "9:16" || aspect === "4:5";

  // ── 1. Out of bounds ─────────────────────────────────────────────────────
  if (enabled(plan, "out-of-bounds")) {
    const bad = dir().filter(
      (m) => m.startTime < -0.001 || m.endTime > duration + 0.001 || m.endTime <= m.startTime
    );
    if (bad.length) {
      if (canAutoFix(plan, "out-of-bounds")) {
        const dropIds = new Set<string>();
        moments = moments.map((m) => {
          if (!isDirectorMoment(m)) return m;
          if (m.startTime >= duration || m.endTime <= 0) {
            dropIds.add(m.id);
            return m;
          }
          const start = Math.max(0, m.startTime);
          const end = Math.min(duration, m.endTime);
          if (end - start < 0.05) {
            dropIds.add(m.id);
            return m;
          }
          return { ...m, startTime: start, endTime: end };
        });
        moments = moments.filter((m) => !dropIds.has(m.id));
        add(
          "out-of-bounds",
          "warning",
          `${bad.length} edit${bad.length === 1 ? "" : "s"} extended past the end of the video.`,
          bad.map((m) => m.id),
          {
            fixed: true,
            fixDetail:
              dropIds.size > 0
                ? `Clamped to the video bounds; ${dropIds.size} that fell entirely outside were removed.`
                : "Clamped to the video bounds.",
          }
        );
      } else {
        add(
          "out-of-bounds",
          "error",
          `${bad.length} edit${bad.length === 1 ? "" : "s"} fall outside the video.`,
          bad.map((m) => m.id)
        );
      }
    }
  }

  // ── 2. Duplicate edits ───────────────────────────────────────────────────
  if (enabled(plan, "duplicate-clip")) {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const m of dir()) {
      const sig = `${m.effectType}:${m.startTime.toFixed(2)}:${m.endTime.toFixed(2)}`;
      const prev = seen.get(sig);
      if (prev) dupes.push(m.id);
      else seen.set(sig, m.id);
    }
    if (dupes.length) {
      if (canAutoFix(plan, "duplicate-clip")) {
        const drop = new Set(dupes);
        moments = moments.filter((m) => !drop.has(m.id));
        add(
          "duplicate-clip",
          "info",
          `${dupes.length} duplicate edit${dupes.length === 1 ? "" : "s"} covered the same window.`,
          dupes,
          { fixed: true, fixDetail: "Removed the duplicates." }
        );
      } else {
        add("duplicate-clip", "warning", `${dupes.length} duplicate edits.`, dupes);
      }
    }
  }

  // ── 3. Caption safe area ─────────────────────────────────────────────────
  if (enabled(plan, "caption-safe-area")) {
    const offenders: string[] = [];
    const fixedIds: string[] = [];

    moments = moments.map((m) => {
      if (m.effectType !== "captions" || !isDirectorMoment(m)) return m;
      const style = resolveTextStyleValues(m);

      // A custom Y outside the safe band, or bottom-anchored captions on a
      // vertical feed (where the platform's own UI sits).
      const customOutside =
        style.position === "custom" &&
        (style.customY < SAFE_TOP || style.customY > SAFE_BOTTOM);
      const bottomOnVertical = isVertical && m.captions?.position === "bottom";

      if (!customOutside && !bottomOnVertical) return m;
      offenders.push(m.id);
      if (!canAutoFix(plan, "caption-safe-area")) return m;

      fixedIds.push(m.id);
      if (customOutside) {
        return {
          ...m,
          textStyle: {
            ...(m.textStyle ?? {}),
            customY: Math.min(SAFE_BOTTOM, Math.max(SAFE_TOP, style.customY)),
          },
        };
      }
      // Vertical feed: lift the captions clear of the platform's UI chrome.
      return {
        ...m,
        captions: m.captions ? { ...m.captions, position: "center" as const } : m.captions,
        textStyle: { ...(m.textStyle ?? {}), position: "center" as const },
      };
    });

    if (offenders.length) {
      add(
        "caption-safe-area",
        fixedIds.length ? "info" : "warning",
        `${offenders.length} caption${offenders.length === 1 ? "" : "s"} sat outside the safe area${
          isVertical ? " for a vertical feed" : ""
        }.`,
        offenders,
        fixedIds.length
          ? {
              fixed: true,
              fixDetail: isVertical
                ? "Moved them up, clear of the platform's on-screen controls."
                : "Pulled them back inside the safe area.",
            }
          : {}
      );
    }
  }

  // ── 4. Text covering an important UI element ─────────────────────────────
  // Not auto-fixable: only the user knows whether the label or the button
  // underneath it matters more. We point at it and let them decide.
  if (enabled(plan, "text-covers-ui")) {
    const grounded = moments.filter(
      (m) =>
        (m.targetRegionSource === "click-event" || m.targetRegionSource === "ui-region") &&
        m.focusRegion
    );
    const offenders: string[] = [];
    for (const t of moments) {
      if (t.effectType !== "text-overlay" && t.effectType !== "branding-cta") continue;
      if (!isDirectorMoment(t)) continue;
      // Both are drawn bottom-anchored, so a grounded target low in the frame is
      // the one at risk of being covered.
      const hit = grounded.find(
        (g) =>
          overlaps(t.startTime, t.endTime, g.startTime, g.endTime) &&
          g.focusRegion.y + g.focusRegion.height > 0.72
      );
      if (hit) offenders.push(t.id);
    }
    if (offenders.length) {
      add(
        "text-covers-ui",
        "warning",
        `${offenders.length} text overlay${offenders.length === 1 ? "" : "s"} may cover an interface element the viewer needs to see.`,
        offenders
      );
    }
  }

  // ── 5. Overlapping overlays ──────────────────────────────────────────────
  // Two output-anchored overlays live in the same place on the canvas, so
  // showing both at once stacks them illegibly. The hook is the one with the
  // shorter, more structural window, so captions yield to it.
  if (enabled(plan, "overlay-overlap")) {
    const hooks = moments.filter((m) => m.effectType === "hook-text");
    const clashes: string[] = [];
    const trimmed: string[] = [];

    moments = moments.map((m) => {
      if (m.effectType !== "captions" || !isDirectorMoment(m)) return m;
      const hook = hooks.find((h) => overlaps(h.startTime, h.endTime, m.startTime, m.endTime));
      if (!hook) return m;
      clashes.push(m.id);
      if (!canAutoFix(plan, "overlay-overlap")) return m;

      // Push the caption to start after the hook clears. If that leaves nothing,
      // the caption is fully inside the hook — drop it (the hook says it better).
      const start = Math.max(m.startTime, hook.endTime);
      if (m.endTime - start < 0.35) {
        trimmed.push(m.id);
        return { ...m, enabled: false };
      }
      trimmed.push(m.id);
      return { ...m, startTime: start };
    });

    if (clashes.length) {
      add(
        "overlay-overlap",
        trimmed.length ? "info" : "warning",
        `${clashes.length} caption${clashes.length === 1 ? "" : "s"} overlapped the hook text.`,
        clashes,
        trimmed.length
          ? { fixed: true, fixDetail: "Held the captions until the hook clears." }
          : {}
      );
    }
  }

  // ── 6. Zoom density ──────────────────────────────────────────────────────
  // The judgment itself is the shared Gate-D implementation
  // (`editorial/composition.ts:zoomDensityPass`) — one owner for "zooms too
  // close / too many", called here with this review's exact historical
  // constants and Director-only scope, and by the analyze route with the
  // run's template numbers. Semantics are pinned equivalent by
  // tests/editorial-composition.test.ts.
  if (enabled(plan, "zoom-density")) {
    const zooms = dir()
      .filter((m) => m.effectType === "zoom" && m.enabled !== false)
      .sort((a, b) => a.startTime - b.startTime);

    const tooClose = zoomDensityPass(zooms, {
      minGapSeconds: MIN_ZOOM_GAP_SECONDS,
      maxPerOutputMinute: MAX_ZOOMS_PER_MINUTE,
      outputDurationSeconds: reportedOutputDuration,
    });

    if (tooClose.length) {
      if (canAutoFix(plan, "zoom-density")) {
        const off = new Set(tooClose);
        // DISABLE rather than delete: the user can flip any of them back on from
        // the timeline, which they can't do with an edit we removed.
        moments = moments.map((m) => (off.has(m.id) ? { ...m, enabled: false } : m));
        add(
          "zoom-density",
          "info",
          `${tooClose.length} zoom${tooClose.length === 1 ? "" : "s"} were packed too close together.`,
          tooClose,
          {
            fixed: true,
            fixDetail:
              "Turned off the weakest of each cluster — they're still on the timeline if you want them back.",
          }
        );
      } else {
        add(
          "zoom-density",
          "warning",
          `${tooClose.length} zooms are very close together.`,
          tooClose
        );
      }
    }
  }

  // ── 7. Timeline-derived checks (cuts, segments, pacing) ──────────────────
  // Everything below reads the SAME timeline map the export uses, so a problem
  // found here is a problem the viewer would actually have seen.
  const map = buildTimelineMap(moments, duration);

  if (enabled(plan, "tiny-clip")) {
    const tiny = map.segments.filter(
      (s) => s.outputEnd - s.outputStart < MIN_SEGMENT_SECONDS
    );
    if (tiny.length) {
      // Auto-fix by ABSORBING the sliver: extend the neighbouring cut over it, so
      // it disappears instead of flashing. Only ever touches Director cuts.
      if (canAutoFix(plan, "tiny-clip")) {
        let absorbed = 0;
        for (const seg of tiny) {
          const cut = moments.find(
            (m) =>
              m.effectType === "cut" &&
              isDirectorMoment(m) &&
              m.cut?.active !== false &&
              Math.abs(m.endTime - seg.sourceStart) < 0.05
          );
          if (cut) {
            cut.endTime = Math.min(duration, seg.sourceEnd);
            absorbed += 1;
          }
        }
        add(
          "tiny-clip",
          absorbed ? "info" : "warning",
          `${tiny.length} surviving clip${tiny.length === 1 ? " was" : "s were"} too short to read (under ${MIN_SEGMENT_SECONDS}s).`,
          [],
          absorbed
            ? { fixed: true, fixDetail: `Absorbed ${absorbed} into the adjacent cut.` }
            : {}
        );
      } else {
        add("tiny-clip", "warning", `${tiny.length} clips are unusably short.`, []);
      }
    }
  }

  if (enabled(plan, "abrupt-cut")) {
    // A cut that lands in the middle of a spoken word chops the audio mid-syllable.
    const words = plan.captionInstructions.enabled
      ? moments
          .filter((m) => m.effectType === "captions")
          .flatMap((m) => m.captions?.words ?? [])
      : [];
    const abrupt: string[] = [];
    for (const m of moments) {
      if (m.effectType !== "cut" || !isDirectorMoment(m) || m.cut?.active === false) continue;
      const chops = words.some(
        (w) =>
          (m.startTime > w.start + 0.06 && m.startTime < w.end - 0.06) ||
          (m.endTime > w.start + 0.06 && m.endTime < w.end - 0.06)
      );
      if (chops) abrupt.push(m.id);
    }
    if (abrupt.length) {
      add(
        "abrupt-cut",
        "warning",
        `${abrupt.length} cut${abrupt.length === 1 ? "" : "s"} land mid-word — the audio may clip. Nudge the cut edges if it sounds wrong.`,
        abrupt
      );
    }
  }

  if (enabled(plan, "silent-section")) {
    const speechWindows = moments
      .filter((m) => m.effectType === "captions" && m.enabled !== false)
      .map((m) => ({ start: m.startTime, end: m.endTime }));
    if (speechWindows.length > 0) {
      const quiet = map.segments.filter((s) => {
        const len = s.sourceEnd - s.sourceStart;
        if (len < MAX_SILENT_STRETCH) return false;
        return !speechWindows.some((w) => overlaps(w.start, w.end, s.sourceStart, s.sourceEnd));
      });
      if (quiet.length) {
        add(
          "silent-section",
          "warning",
          `${quiet.length} stretch${quiet.length === 1 ? "" : "es"} of the final video ${quiet.length === 1 ? "has" : "have"} no speech for over ${MAX_SILENT_STRETCH}s.`,
          [],
          { at: quiet[0].sourceStart }
        );
      }
    }
  }

  // ── 8. Did we do what was asked? ─────────────────────────────────────────
  if (enabled(plan, "missing-captions") && plan.captionInstructions.enabled) {
    const have = moments.some((m) => m.effectType === "captions" && isDirectorMoment(m));
    if (!have) {
      add(
        "missing-captions",
        "warning",
        "Captions were requested but none were produced — this project has no completed transcript, and Framevo won't invent caption text.",
        []
      );
    }
  }

  if (enabled(plan, "missing-cta")) {
    const wantsCta = plan.editOperations.some((o) => o.editType === "branding-cta");
    const haveCta = moments.some((m) => m.effectType === "branding-cta");
    if (wantsCta && !haveCta) {
      add("missing-cta", "warning", "A CTA was planned but didn't make it onto the timeline.", []);
    }
  }

  if (enabled(plan, "smart-crop-mismatch") && plan.aspectRatio) {
    const canvasAspect = input.effects?.outputCanvas?.aspectRatio;
    const cropMoment = moments.find((m) => m.effectType === "smart-crop");
    if (cropMoment && canvasAspect && canvasAspect !== plan.aspectRatio) {
      add(
        "smart-crop-mismatch",
        "warning",
        `The canvas is ${canvasAspect} but the plan asked for ${plan.aspectRatio}.`,
        [cropMoment.id]
      );
    }
  }

  if (enabled(plan, "target-duration") && plan.targetDurationSeconds) {
    const target = plan.targetDurationSeconds;
    const actual = map.outputDuration;
    const drift = Math.abs(actual - target);
    // 20% or 5s, whichever is looser — cuts land on real boundaries, so hitting
    // a target to the second isn't achievable without butchering the content.
    const tolerance = Math.max(5, target * 0.2);
    if (drift > tolerance) {
      add(
        "target-duration",
        "warning",
        `The result is ${actual.toFixed(0)}s but you asked for ${target}s. ${
          actual > target
            ? "There wasn't enough removable material to get shorter without cutting into the demonstration."
            : "The source didn't have enough strong material to fill the target."
        }`,
        []
      );
    }
  }

  // ── 9. Preview / export parity ───────────────────────────────────────────
  /**
   * Preview and export can only disagree if something is wrong with the DATA,
   * because they run the same resolvers over the same array. So parity is
   * checked by re-deriving the export's own view of the timeline and confirming
   * it matches what we reported — plus verifying every moment is actually
   * persistable.
   *
   * `undefined` is the real hazard: Firestore REJECTS undefined field values, so
   * a moment carrying one would fail to save and the reloaded project would be
   * missing that edit — preview (in memory) and export (from the doc) would then
   * genuinely differ. Catching it here turns a silent divergence into a finding.
   */
  if (enabled(plan, "preview-export-parity")) {
    const recomputed = buildTimelineMap(moments, duration);
    const durationMatches =
      Math.abs(recomputed.outputDuration - reportedOutputDuration) < 0.05;

    const unserializable = moments.filter(
      (m) =>
        !Number.isFinite(m.startTime) ||
        !Number.isFinite(m.endTime) ||
        hasUndefined(m)
    );

    if (!durationMatches || unserializable.length > 0) {
      add(
        "preview-export-parity",
        "error",
        !durationMatches
          ? `Preview and export disagree on the output length (${recomputed.outputDuration.toFixed(1)}s vs ${reportedOutputDuration.toFixed(1)}s).`
          : `${unserializable.length} edit${unserializable.length === 1 ? "" : "s"} can't be saved and would be lost on reload.`,
        unserializable.map((m) => m.id)
      );
    }
  }

  const parityOk = !findings.some((f) => f.rule === "preview-export-parity");

  return {
    moments,
    findings,
    autoFixed: findings.filter((f) => f.fixed).length,
    warnings: findings.filter((f) => f.severity === "warning" && !f.fixed).length,
    errors: findings.filter((f) => f.severity === "error").length,
    parityOk,
  };
}

/** Recursively true when any own property is literally `undefined`. */
function hasUndefined(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (value === undefined) return true;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasUndefined(v, depth + 1));
  return Object.values(value as Record<string, unknown>).some((v) =>
    hasUndefined(v, depth + 1)
  );
}
