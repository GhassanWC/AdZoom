/**
 * Golden Editorial Benchmark — objective metrics over a produced timeline.
 *
 * These are the AUTO-COMPUTABLE half of the benchmark (the human rubric in
 * bench/scores/RUBRIC.md is the judge of publishability). Every number here is
 * a fact about the moment array — no model, no I/O — so the replay tier is
 * fully deterministic and CI-comparable with exact equality.
 *
 * "Inappropriate" is defined per fixture KIND, mirroring the approved
 * matrix: cursor emphasis on camera-only footage, speed ramps on talking
 * footage, decorative overlays (transitions/callouts) on talking footage.
 */
import type { DetectedMoment } from "@/lib/firebase/schema";
import { buildTimelineMap } from "@/lib/timeline/crop-speed";
import { categoryForEffectType, type ResolvedEditorialPolicy } from "./policy";

export type FixtureKind = "talking-head" | "screen-recording" | "hybrid" | "other";

export interface BenchMetricsInput {
  moments: DetectedMoment[];
  durationSeconds: number;
  kind: FixtureKind;
  silenceSegments?: Array<{ startTime: number; endTime: number }>;
  /** When given, spacing/budget violations are judged against this policy. */
  policy?: ResolvedEditorialPolicy;
}

export interface BenchMetrics {
  totalAi: number;
  totalLive: number; // enabled AI edits (what the viewer gets)
  byType: Record<string, number>;
  perMinuteOutput: number;
  zoomCount: number;
  cursorEmphasisCount: number;
  cutCount: number;
  speedCount: number;
  decorativeOverlayCount: number; // transitions + callouts + text labels
  /** Zoom pairs closer (end→start) than the policy's spacing (or 12s default). */
  zoomSpacingViolations: number;
  /** Enabled emphasis edits that start inside a detected silence. */
  zoomsInSilence: number;
  /** Instants where ≥2 emphasis edits overlap. */
  overlapEmphasisPairs: number;
  /** Rolling 8s windows holding ≥3 enabled AI edits. */
  clusters: number;
  /** Share of the video ≥5s away from any enabled AI edit (quiet time). */
  editFreeShare: number;
  /** Edits present but turned off (Gate D or review actions). */
  disabledCount: number;
  /** Kind-aware wrongness — the headline "inappropriate edits" number. */
  inappropriate: {
    cursorOnCameraFootage: number;
    speedOnTalkingFootage: number;
    decorativeOnTalkingFootage: number;
    total: number;
  };
}

const isAi = (m: DetectedMoment) => m.source !== "user" && m.provenance !== "user";
const live = (m: DetectedMoment) => m.enabled !== false;
const start = (m: DetectedMoment) => Number(m.startTime) || 0;

const EMPHASIS = new Set(["zoom", "click-highlight", "cursor-focus", "callout", "text-overlay"]);
const DECOR = new Set(["transition", "callout", "text-overlay"]);

export function computeBenchMetrics(input: BenchMetricsInput): BenchMetrics {
  const ai = input.moments.filter(isAi);
  const on = ai.filter(live);
  const byType: Record<string, number> = {};
  for (const m of on) byType[m.effectType] = (byType[m.effectType] ?? 0) + 1;

  const outputDuration = Math.max(
    1,
    buildTimelineMap(input.moments, input.durationSeconds).outputDuration
  );

  const zooms = on
    .filter((m) => m.effectType === "zoom")
    .sort((a, b) => a.startTime - b.startTime);
  const minGap = input.policy?.composition.zoom?.minGapSeconds ?? 12;
  let zoomSpacingViolations = 0;
  for (let i = 1; i < zooms.length; i++) {
    if (zooms[i].startTime - zooms[i - 1].endTime < minGap) zoomSpacingViolations++;
  }

  const inSilence = (t: number) =>
    (input.silenceSegments ?? []).some((s) => t >= s.startTime && t < s.endTime);
  const zoomsInSilence = on.filter(
    (m) => EMPHASIS.has(m.effectType) && m.effectType !== "text-overlay" && inSilence(start(m))
  ).length;

  const emphasis = on
    .filter((m) => EMPHASIS.has(m.effectType))
    .sort((a, b) => a.startTime - b.startTime);
  let overlapEmphasisPairs = 0;
  for (let i = 0; i < emphasis.length; i++) {
    for (let j = i + 1; j < emphasis.length; j++) {
      if (emphasis[j].startTime >= emphasis[i].endTime) break;
      overlapEmphasisPairs++;
    }
  }

  // Clusters: count starts-in-window ≥3, sliding on each edit as an anchor.
  const sortedOn = [...on].sort((a, b) => a.startTime - b.startTime);
  let clusters = 0;
  for (let i = 0; i < sortedOn.length; i++) {
    const inWindow = sortedOn.filter(
      (m) => start(m) >= start(sortedOn[i]) && start(m) < start(sortedOn[i]) + 8
    );
    if (inWindow.length >= 3) clusters++;
  }

  // Quiet share: fraction of whole seconds ≥5s from every enabled AI edit.
  let quiet = 0;
  const dur = Math.max(1, Math.floor(input.durationSeconds));
  for (let t = 0; t < dur; t++) {
    const near = sortedOn.some((m) => t >= start(m) - 5 && t <= m.endTime + 5);
    if (!near) quiet++;
  }

  const cursorEmphasisCount = on.filter(
    (m) => categoryForEffectType(m.effectType) === "cursor_emphasis"
  ).length;
  const speedCount = on.filter((m) => m.effectType === "speed-up").length;
  const decorativeOverlayCount = on.filter((m) => DECOR.has(m.effectType)).length;

  const talkingLike = input.kind === "talking-head";
  const inappropriate = {
    cursorOnCameraFootage: talkingLike ? cursorEmphasisCount : 0,
    speedOnTalkingFootage: talkingLike ? speedCount : 0,
    decorativeOnTalkingFootage: talkingLike ? decorativeOverlayCount : 0,
    total: 0,
  };
  inappropriate.total =
    inappropriate.cursorOnCameraFootage +
    inappropriate.speedOnTalkingFootage +
    inappropriate.decorativeOnTalkingFootage;

  return {
    totalAi: ai.length,
    totalLive: on.length,
    byType,
    perMinuteOutput: Number(((on.length / outputDuration) * 60).toFixed(2)),
    zoomCount: zooms.length,
    cursorEmphasisCount,
    cutCount: on.filter((m) => m.effectType === "cut").length,
    speedCount,
    decorativeOverlayCount,
    zoomSpacingViolations,
    zoomsInSilence,
    overlapEmphasisPairs,
    clusters,
    editFreeShare: Number((quiet / dur).toFixed(3)),
    disabledCount: ai.length - on.length,
    inappropriate,
  };
}
