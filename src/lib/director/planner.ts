/**
 * AI Director — the planner.
 *
 * Two entry points, one output type:
 *
 *   buildHeuristicPlan(ctx, request)  — a complete, deterministic plan built from
 *                                       the project's real signals. No network.
 *   sanitizeDirectorPlan(raw, ...)    — coerces a MODEL's JSON into the same
 *                                       validated shape (used by gemini-planner).
 *
 * The heuristic planner is not a stub or a fallback afterthought: it is the
 * reference implementation of Framevo's editorial judgment, and it is what makes
 * the whole feature testable end-to-end under `node --test` with no API key. The
 * Gemini planner's job is to be *better* at story judgment, not to be the only
 * thing that works.
 *
 * STORY INTELLIGENCE — the part that matters:
 * The naive approach (take the top-N highest-scoring moments) produces a reel of
 * disconnected peaks that no viewer can follow. Instead this planner:
 *   1. Lays down the story spine FIRST (hook → context → demo → result → CTA)
 *      and assigns each section a real source window.
 *   2. Fills each section with the strongest CONTIGUOUS material from that
 *      window, so kept time stays connected.
 *   3. Removes dead air INSIDE kept sections rather than shattering them.
 *   4. Sacrifices whole low-priority sections (context first, hook/result last)
 *      when the target duration bites — never the middle of a demonstration.
 *
 * Pure: no Gemini, no Firebase, no DOM. Loadable by `node --test`.
 */
import type { OverlayTextPreset, CaptionPosition, TextStyle } from "../firebase/schema";
import type { DirectorCandidate, DirectorVideoContext } from "./context-builder";
import {
  DEFAULT_REVIEW_RULES,
  DIRECTOR_PLAN_VERSION,
  isDirectorEditType,
  type DirectorAspect,
  type DirectorAudioOperation,
  type DirectorCaptionInstructions,
  type DirectorClipOperation,
  type DirectorEditOperation,
  type DirectorEvidence,
  type DirectorPlan,
  type DirectorRequest,
  type DirectorSection,
  type DirectorSectionKind,
  type DirectorStyle,
} from "./types";

export const HEURISTIC_MODEL_VERSION = "heuristic-v1";

/** Sub-second slivers are unusable as clips — they read as glitches, not cuts. */
export const MIN_KEEP_SECONDS = 1.2;
/** A hook shorter than this can't land; longer than this stops being a hook. */
const HOOK_MIN = 2;
const HOOK_MAX = 8;
const CTA_SECONDS = 3.5;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < bE && bS < aE;
}

/** Merge overlapping/adjacent ranges. The basis of "kept time stays connected". */
function mergeRanges(
  ranges: Array<{ start: number; end: number }>,
  gap = 0
): Array<{ start: number; end: number }> {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .slice()
    .sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Complement of `holes` within [start, end]. */
function subtractRanges(
  start: number,
  end: number,
  holes: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let cursor = start;
  for (const h of mergeRanges(holes)) {
    if (h.end <= start || h.start >= end) continue;
    const hs = Math.max(start, h.start);
    if (hs > cursor) out.push({ start: cursor, end: hs });
    cursor = Math.max(cursor, Math.min(end, h.end));
  }
  if (cursor < end) out.push({ start: cursor, end });
  return out.filter((r) => r.end - r.start > 0.01);
}

// ── Style → concrete look ────────────────────────────────────────────────────

/**
 * "Energetic captions" has to mean something REAL. This is where an adjective
 * becomes a concrete `TextStyle` the renderer actually honors — bigger, heavier,
 * uppercase, stroked. Without this the style dropdown would be decoration.
 */
export function captionTextStyleFor(style: DirectorStyle): TextStyle {
  switch (style) {
    case "energetic":
      return {
        preset: "bold",
        fontScale: 0.062,
        fontWeight: 800,
        uppercase: true,
        letterSpacing: 0.01,
        background: "none",
        strokeColor: "#000000",
        strokeWidth: 0.09,
        shadow: true,
        shadowOpacity: 0.7,
      };
    case "professional":
      return {
        preset: "clean",
        fontScale: 0.046,
        fontWeight: 600,
        uppercase: false,
        background: "pill",
        backgroundOpacity: 0.6,
      };
    case "minimal":
      return {
        preset: "minimal",
        fontScale: 0.042,
        fontWeight: 500,
        background: "none",
        shadow: true,
        shadowOpacity: 0.5,
      };
    case "cinematic":
      return {
        preset: "shadow",
        fontScale: 0.05,
        fontWeight: 700,
        background: "none",
        shadow: true,
        shadowBlur: 0.4,
        shadowOpacity: 0.75,
      };
    case "calm":
    default:
      return {
        preset: "clean",
        fontScale: 0.046,
        fontWeight: 600,
        background: "pill",
        backgroundOpacity: 0.5,
      };
  }
}

function captionPresetFor(
  request: DirectorRequest
): OverlayTextPreset {
  switch (request.captionStyle) {
    case "bold_social":
      return "bold_social";
    case "minimal":
      return "minimal";
    case "podcast":
      return "podcast";
    case "tutorial":
      return "tutorial";
    case "clean":
      return "clean";
    case "none":
    default:
      return "clean";
  }
}

/** Vertical formats put captions high enough to clear the platform's UI chrome. */
function captionPositionFor(aspect: DirectorAspect | undefined): CaptionPosition {
  return aspect === "9:16" || aspect === "4:5" ? "center" : "bottom";
}

/** How aggressively to zoom, per style. */
function zoomIntensityFor(style: DirectorStyle): number {
  switch (style) {
    case "energetic":
      return 0.8;
    case "cinematic":
      return 0.75;
    case "professional":
      return 0.6;
    case "minimal":
      return 0.45;
    case "calm":
    default:
      return 0.5;
  }
}

/** Max zooms per minute of OUTPUT — the review engine enforces the same budget. */
function zoomBudgetPerMinute(style: DirectorStyle): number {
  switch (style) {
    case "energetic":
      return 8;
    case "cinematic":
      return 6;
    case "professional":
      return 5;
    case "minimal":
      return 3;
    case "calm":
    default:
      return 4;
  }
}

function defaultCtaText(request: DirectorRequest): string {
  if (request.ctaText) return request.ctaText;
  switch (request.goal) {
    case "product-demo":
      return "Try it now";
    case "tutorial":
      return "Learn more";
    case "promo":
      return "Get started";
    case "social-clips":
      return "Follow for more";
    default:
      return "Follow for more";
  }
}

// ── The planner ──────────────────────────────────────────────────────────────

let opCounter = 0;
/**
 * Deterministic within a single plan build (reset per call). Ids are stable for
 * the same input, which is what makes re-running the same request idempotent
 * instead of duplicating every edit.
 */
function opId(kind: string): string {
  opCounter += 1;
  return `${kind}-${opCounter}`;
}

/**
 * Assign the story spine. Prefers the narrative beats the analysis already
 * found; falls back to proportional windows when there are none, so a bare
 * upload still gets a real structure instead of nothing.
 */
function planSections(
  ctx: DirectorVideoContext,
  request: DirectorRequest,
  wantCta: boolean
): DirectorSection[] {
  const dur = ctx.durationSeconds;
  const sections: DirectorSection[] = [];
  const ev = (
    kind: DirectorEvidence["kind"],
    detail: string,
    at?: number
  ): DirectorEvidence => ({ kind, detail, ...(at !== undefined ? { at } : {}) });

  // Best hook = the strongest thing in the opening third. A hook has to actually
  // hook, so we prefer a high-scoring candidate over "the first N seconds".
  const openingLimit = Math.max(HOOK_MAX, dur * 0.34);
  const hookPick = ctx.candidates
    .filter((c) => c.startTime < openingLimit && c.endTime - c.startTime >= 1)
    .sort((a, b) => b.score - a.score)[0];

  const hookStart = hookPick ? Math.max(0, hookPick.startTime) : 0;
  const hookEnd = Math.min(
    dur,
    Math.max(hookStart + HOOK_MIN, Math.min(hookStart + HOOK_MAX, hookPick?.endTime ?? HOOK_MAX))
  );

  sections.push({
    id: "sec-hook",
    kind: "hook",
    title: hookPick?.label?.slice(0, 40) || "Opening hook",
    startTime: round(hookStart),
    endTime: round(hookEnd),
    reason: hookPick
      ? `Strongest opening beat — it earns the viewer's first seconds.`
      : `Opens on the first frames; no stronger opening beat was detected.`,
    confidence: hookPick ? clamp01(0.55 + 0.4 * hookPick.score) : 0.4,
    evidence: hookPick
      ? hookPick.evidence.slice(0, 2)
      : [ev("heuristic", "No candidate in the opening third — used the first frames.", 0)],
  });

  // The CTA claims the tail.
  const ctaStart = wantCta ? Math.max(hookEnd, dur - CTA_SECONDS) : dur;

  // Everything between the hook and the CTA is the body. Split it by the
  // narrative roles the analysis already labelled: explanation/intro/setup →
  // context, action → demo, result → result.
  const bodyStart = hookEnd;
  const bodyEnd = ctaStart;

  if (bodyEnd > bodyStart) {
    const resultBeat = ctx.narrative.find(
      (s) => s.role === "result" && s.endTime > bodyStart && s.startTime < bodyEnd
    );
    const resultStart = resultBeat
      ? Math.max(bodyStart, resultBeat.startTime)
      : bodyStart + (bodyEnd - bodyStart) * 0.8;

    const contextBeats = ctx.narrative.filter(
      (s) =>
        (s.role === "intro" || s.role === "setup" || s.role === "explanation") &&
        s.endTime > bodyStart &&
        s.startTime < resultStart
    );
    // Context is whatever sits before the first "action" beat.
    const firstAction = ctx.narrative.find(
      (s) => s.role === "action" && s.endTime > bodyStart && s.startTime < resultStart
    );
    const contextEnd = firstAction
      ? Math.max(bodyStart, Math.min(resultStart, firstAction.startTime))
      : contextBeats.length
        ? Math.min(resultStart, Math.max(...contextBeats.map((b) => b.endTime)))
        : bodyStart;

    if (contextEnd > bodyStart + 0.5) {
      sections.push({
        id: "sec-context",
        kind: "context",
        title: contextBeats[0]?.label?.slice(0, 40) || "Context",
        startTime: round(bodyStart),
        endTime: round(contextEnd),
        reason: "Sets up what the viewer is about to see.",
        confidence: contextBeats.length ? 0.7 : 0.45,
        evidence: contextBeats.length
          ? [
              ev(
                "narrative",
                `${contextBeats.length} setup/explanation beat(s)`,
                contextBeats[0].startTime
              ),
            ]
          : [ev("heuristic", "Proportional context window.", bodyStart)],
      });
    }

    const demoStart = Math.max(bodyStart, contextEnd);
    if (resultStart > demoStart + 0.5) {
      const demoClicks = ctx.interactionTimes.filter(
        (t) => t >= demoStart && t < resultStart
      );
      sections.push({
        id: "sec-demo",
        kind: "demo",
        title: "Main demonstration",
        startTime: round(demoStart),
        endTime: round(resultStart),
        reason: demoClicks.length
          ? `The core of the video — ${demoClicks.length} real interaction(s) happen here.`
          : "The core demonstration / explanation.",
        confidence: demoClicks.length ? 0.85 : 0.6,
        evidence: demoClicks.length
          ? [ev("click", `${demoClicks.length} interactions`, demoClicks[0])]
          : [ev("heuristic", "Main body of the recording.", demoStart)],
      });
    }

    if (bodyEnd > resultStart + 0.3) {
      sections.push({
        id: "sec-result",
        kind: "result",
        title: resultBeat?.label?.slice(0, 40) || "Result",
        startTime: round(Math.max(demoStart, resultStart)),
        endTime: round(bodyEnd),
        reason: "The payoff — what the viewer came to see.",
        confidence: resultBeat ? 0.85 : 0.5,
        evidence: resultBeat
          ? [ev("narrative", `result beat: ${resultBeat.label}`, resultBeat.startTime)]
          : [ev("heuristic", "Final stretch of the demonstration.", resultStart)],
      });
    }
  }

  if (wantCta && dur > ctaStart) {
    sections.push({
      id: "sec-cta",
      kind: "cta",
      title: "Call to action",
      startTime: round(ctaStart),
      endTime: round(dur),
      reason: "Closes with a clear next step.",
      confidence: 0.8,
      evidence: [ev("user-request", `CTA requested (${request.cta})`, ctaStart)],
    });
  }

  return sections;
}

/** The best contiguous material inside a section, dead air removed. */
function keptRangesForSection(
  section: DirectorSection,
  ctx: DirectorVideoContext
): Array<{ start: number; end: number }> {
  const holes = ctx.deadZones
    .filter((d) => overlaps(d.startTime, d.endTime, section.startTime, section.endTime))
    // Never gut the hook or the CTA — they're short and structural. Removing a
    // pause from a 3s hook leaves nothing.
    .filter(() => section.kind !== "hook" && section.kind !== "cta")
    .map((d) => ({ start: d.startTime, end: d.endTime }));

  const kept = subtractRanges(section.startTime, section.endTime, holes);
  // Slivers left behind by removal are unusable — fold them away.
  return mergeRanges(
    kept.filter((r) => r.end - r.start >= MIN_KEEP_SECONDS),
    0.35
  );
}

/**
 * Enforce the target duration by dropping whole low-priority sections, then
 * trimming the longest survivor. Structure is preserved: we'd rather lose the
 * context section entirely than leave a demo that stops mid-click.
 */
function enforceTargetDuration(
  sections: DirectorSection[],
  keptBySection: Map<string, Array<{ start: number; end: number }>>,
  target: number | undefined
): { drops: DirectorSection[]; trims: Map<string, Array<{ start: number; end: number }>> } {
  const trims = new Map(keptBySection);
  const drops: DirectorSection[] = [];
  if (!target || target <= 0) return { drops, trims };

  const total = () =>
    [...trims.values()]
      .flat()
      .reduce((acc, r) => acc + (r.end - r.start), 0);

  // Sacrifice order: context first, then demo tail, then result. Hook and CTA
  // are structural — a video with no hook and no ending isn't a shorter video,
  // it's a broken one.
  const SACRIFICE: DirectorSectionKind[] = ["context", "demo", "result"];

  for (const kind of SACRIFICE) {
    if (total() <= target) break;
    const sec = sections.find((s) => s.kind === kind);
    if (!sec) continue;
    const ranges = trims.get(sec.id) ?? [];
    const secLen = ranges.reduce((a, r) => a + (r.end - r.start), 0);
    const excess = total() - target;

    if (excess >= secLen && kind === "context") {
      // Dropping the whole context section gets us under — do it cleanly.
      trims.set(sec.id, []);
      drops.push(sec);
      continue;
    }

    // Otherwise trim this section from its END (keep the beginning: a demo that
    // starts at the click and stops early still reads; one that starts mid-click
    // does not).
    let budget = Math.max(0, secLen - excess);
    const trimmed: Array<{ start: number; end: number }> = [];
    for (const r of ranges) {
      const len = r.end - r.start;
      if (budget <= 0) break;
      if (len <= budget) {
        trimmed.push(r);
        budget -= len;
      } else if (budget >= MIN_KEEP_SECONDS) {
        trimmed.push({ start: r.start, end: r.start + budget });
        budget = 0;
      } else {
        break;
      }
    }
    trims.set(sec.id, trimmed);
  }

  return { drops, trims };
}

/**
 * Build a complete, deterministic Director plan from the project's real signals.
 */
export function buildHeuristicPlan(
  ctx: DirectorVideoContext,
  request: DirectorRequest,
  now = Date.now()
): DirectorPlan {
  opCounter = 0;
  const dur = ctx.durationSeconds;
  const wantCta =
    request.cta === "always" ||
    (request.cta === "auto" &&
      (request.goal === "product-demo" ||
        request.goal === "promo" ||
        request.goal === "social-clips"));

  const sections = planSections(ctx, request, wantCta && dur > 6);

  // ── Kept ranges per section, dead air already removed ────────────────────
  const keptBySection = new Map<string, Array<{ start: number; end: number }>>();
  for (const s of sections) keptBySection.set(s.id, keptRangesForSection(s, ctx));

  const { drops, trims } = enforceTargetDuration(
    sections,
    keptBySection,
    request.targetDurationSeconds
  );
  const droppedIds = new Set(drops.map((d) => d.id));
  const survivingSections = sections.filter((s) => (trims.get(s.id) ?? []).length > 0);

  // ── Clip operations ──────────────────────────────────────────────────────
  const clipOperations: DirectorClipOperation[] = [];
  const allKept = mergeRanges(
    survivingSections.flatMap((s) => trims.get(s.id) ?? []),
    0.2
  );

  for (const s of survivingSections) {
    for (const r of trims.get(s.id) ?? []) {
      clipOperations.push({
        id: opId("keep"),
        kind: "keep",
        sectionId: s.id,
        startTime: round(r.start),
        endTime: round(r.end),
        reason: `Keeps the ${s.kind} — ${s.reason}`,
        confidence: s.confidence,
        priority: s.kind === "hook" || s.kind === "cta" ? 1 : s.kind === "result" ? 0.9 : 0.7,
        evidence: s.evidence.slice(0, 2),
      });
    }
  }

  // Everything NOT kept is removed. This is the single mechanism that shortens
  // the video: one `remove` op per gap, each compiled to a real `cut` moment.
  const removals = subtractRanges(0, dur, allKept);
  for (const r of removals) {
    if (r.end - r.start < 0.25) continue;
    // Attribute the removal to the dead zone that explains it, when there is one.
    const zone = ctx.deadZones.find((d) =>
      overlaps(d.startTime, d.endTime, r.start, r.end)
    );
    const dropped = drops.find((d) => overlaps(d.startTime, d.endTime, r.start, r.end));
    clipOperations.push({
      id: opId("remove"),
      kind: "remove",
      startTime: round(r.start),
      endTime: round(r.end),
      reason: dropped
        ? `Cut to hit the ${request.targetDurationSeconds}s target — the ${dropped.kind} section was the least essential.`
        : zone
          ? zone.reason
          : "Removed — outside the story structure.",
      confidence: zone ? 0.85 : dropped ? 0.7 : 0.6,
      priority: 0.8,
      evidence: zone
        ? zone.evidence.slice(0, 2)
        : [
            {
              kind: "heuristic",
              detail: dropped
                ? `dropped section ${dropped.id} (target duration)`
                : "not part of any kept section",
              at: r.start,
            },
          ],
    });
  }

  // ── Audio operations ─────────────────────────────────────────────────────
  // Pauses/silences INSIDE kept ranges (the removals above already took the ones
  // between sections). These are the "removed 8 pauses" the summary reports.
  const audioOperations: DirectorAudioOperation[] = [];
  for (const d of ctx.deadZones) {
    if (d.kind !== "pause" && d.kind !== "silence" && d.kind !== "filler") continue;
    const insideKept = allKept.some((k) =>
      overlaps(k.start, k.end, d.startTime, d.endTime)
    );
    if (!insideKept) continue;
    const clipped = {
      start: Math.max(d.startTime, Math.min(...allKept.map((k) => k.start), d.startTime)),
      end: d.endTime,
    };
    void clipped;
    audioOperations.push({
      id: opId(d.kind === "filler" ? "filler" : "silence"),
      kind: d.kind === "filler" ? "remove-filler" : "remove-silence",
      startTime: round(d.startTime),
      endTime: round(d.endTime),
      reason: d.reason,
      confidence: 0.8,
      priority: 0.75,
      evidence: d.evidence.slice(0, 2),
    });
  }

  // ── Edit operations ──────────────────────────────────────────────────────
  const editOperations: DirectorEditOperation[] = [];
  const keptSeconds = allKept.reduce((a, r) => a + (r.end - r.start), 0);
  const zoomBudget = Math.max(
    1,
    Math.round((keptSeconds / 60) * zoomBudgetPerMinute(request.style))
  );

  const hookSection = survivingSections.find((s) => s.kind === "hook");
  const ctaSection = survivingSections.find((s) => s.kind === "cta");

  // 1. Hook text — opens the video. Uses the REAL first spoken line when there
  //    is one; never invents a claim about the product.
  if (hookSection) {
    const firstLine = ctx.transcript?.segments?.find(
      (s) => s.endTime > hookSection.startTime && s.startTime < hookSection.endTime
    );
    const hookText =
      firstLine?.text.trim().split(/(?<=[.!?])\s+/)[0]?.slice(0, 58) ||
      ctx.title.slice(0, 58) ||
      "Watch this";
    editOperations.push({
      id: opId("hook"),
      editType: "hook-text",
      sectionId: hookSection.id,
      startTime: round(hookSection.startTime + 0.15),
      endTime: round(Math.min(hookSection.endTime, hookSection.startTime + 3)),
      reason: firstLine
        ? "Opening hook, taken from the first spoken line."
        : "Opening hook, from the project title.",
      confidence: firstLine ? 0.8 : 0.5,
      priority: 0.95,
      evidence: firstLine
        ? [
            {
              kind: "transcript",
              ref: firstLine.id,
              detail: `"${firstLine.text.slice(0, 70)}"`,
              at: firstLine.startTime,
            },
          ]
        : [{ kind: "heuristic", detail: "no transcript — used project title" }],
      params: { text: hookText },
    });
  }

  // 2. Zooms — on the strongest grounded moments inside kept time, spaced out.
  //    Grounded-first ordering (a real click beats a CV guess) is why these land
  //    on the thing the viewer should be looking at.
  const zoomCandidates: DirectorCandidate[] = ctx.candidates
    .filter((c) => c.id.startsWith("mom-"))
    .filter((c) => allKept.some((k) => overlaps(k.start, k.end, c.startTime, c.endTime)))
    .sort((a, b) => {
      if (a.hasInteraction !== b.hasInteraction) return a.hasInteraction ? -1 : 1;
      return b.score - a.score;
    });

  const placedZooms: Array<{ start: number; end: number }> = [];
  const MIN_ZOOM_GAP = 2.5;
  for (const c of zoomCandidates) {
    if (editOperations.filter((o) => o.editType === "zoom").length >= zoomBudget) break;
    if (
      placedZooms.some(
        (p) => c.startTime < p.end + MIN_ZOOM_GAP && p.start - MIN_ZOOM_GAP < c.endTime
      )
    ) {
      continue;
    }
    const src = ctx.moments.find((m) => `mom-${m.id}` === c.id);
    if (!src) continue;
    const start = Math.max(c.startTime, 0);
    const end = Math.min(c.endTime, dur);
    if (end - start < 0.4) continue;

    editOperations.push({
      id: opId("zoom"),
      editType: "zoom",
      startTime: round(start),
      endTime: round(end),
      sectionId: survivingSections.find(
        (s) => start >= s.startTime && start < s.endTime
      )?.id,
      reason: c.hasInteraction
        ? `Emphasizes a real interaction — ${c.label}.`
        : `Emphasizes a high-attention moment — ${c.label}.`,
      confidence: clamp01(src.confidenceScore ?? c.score),
      priority: clamp01(0.5 + 0.5 * c.score),
      evidence: c.evidence.slice(0, 2),
      focusRegion: src.focusRegion,
      intensity: clamp01(
        (src.recommendedIntensity ?? zoomIntensityFor(request.style)) *
          (0.7 + 0.6 * zoomIntensityFor(request.style))
      ),
    });
    placedZooms.push({ start, end });
  }

  // 3. Callouts — only on windows grounded in a REAL click/UI target. A callout
  //    pointing at nothing is worse than no callout, so ungrounded moments are
  //    skipped rather than guessed at.
  const calloutSources = ctx.moments
    .filter(
      (m) =>
        (m.targetRegionSource === "click-event" || m.targetRegionSource === "ui-region") &&
        (m.confidenceScore ?? 0) >= 0.6 &&
        allKept.some((k) => overlaps(k.start, k.end, m.startTime, m.endTime))
    )
    .sort((a, b) => (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0))
    .slice(0, request.style === "minimal" ? 1 : 3);

  for (const m of calloutSources) {
    editOperations.push({
      id: opId("callout"),
      editType: "callout",
      startTime: round(m.startTime),
      endTime: round(Math.min(m.endTime, m.startTime + 2.5)),
      reason: `Points at the element the user actually interacted with.`,
      confidence: clamp01(m.confidenceScore ?? 0.6),
      priority: 0.6,
      evidence: [
        {
          kind: "click",
          ref: m.id,
          detail: `grounded target (${m.targetRegionSource})`,
          at: m.startTime,
        },
      ],
      focusRegion: m.focusRegion,
      params: {
        text: m.label && m.label.length > 4 ? m.label : "Here",
        calloutStyle: "box",
      },
    });
  }

  // 4. Speed-up — compress merely-slow (not dead) stretches inside kept time.
  //    Only for styles that want pace; a calm tutorial shouldn't jitter.
  if (request.style === "energetic" || request.style === "cinematic") {
    const slow = ctx.deadZones.filter(
      (d) =>
        d.kind === "boring" &&
        allKept.some((k) => overlaps(k.start, k.end, d.startTime, d.endTime))
    );
    for (const d of slow.slice(0, 3)) {
      const start = Math.max(d.startTime, Math.min(...allKept.map((k) => k.start)));
      const end = Math.min(d.endTime, dur);
      if (end - start < 1.5) continue;
      editOperations.push({
        id: opId("speed"),
        editType: "speed-up",
        startTime: round(start),
        endTime: round(end),
        reason: "Compresses a slow stretch without removing it.",
        confidence: 0.65,
        priority: 0.5,
        evidence: d.evidence.slice(0, 1),
        params: { speedMultiplier: request.style === "energetic" ? 2 : 1.6 },
      });
    }
  }

  // 5. Transitions — soften each cut boundary where the video resumes.
  if (request.style !== "minimal") {
    const resumePoints = allKept
      .map((k) => k.start)
      .filter((t) => t > 0.3 && t < dur - 0.5)
      .slice(0, 5);
    for (const t of resumePoints) {
      editOperations.push({
        id: opId("transition"),
        editType: "transition",
        startTime: round(t),
        endTime: round(Math.min(dur, t + 0.4)),
        reason: "Softens the cut where the video resumes.",
        confidence: 0.7,
        priority: 0.4,
        evidence: [{ kind: "heuristic", detail: "cut boundary", at: t }],
        params: {
          transitionStyle: request.style === "energetic" ? "flash" : "fade",
        },
      });
    }
  }

  // 6. CTA end card.
  if (ctaSection) {
    editOperations.push({
      id: opId("cta"),
      editType: "branding-cta",
      sectionId: ctaSection.id,
      startTime: round(ctaSection.startTime),
      endTime: round(ctaSection.endTime),
      reason: "Closes with a clear next step.",
      confidence: 0.85,
      priority: 0.95,
      evidence: [
        { kind: "user-request", detail: `CTA requested (${request.cta})` },
      ],
      params: { ctaText: defaultCtaText(request) },
    });
  }

  // 7. Smart crop — only when the target aspect differs from the source's.
  const sourceAspect =
    ctx.sourceWidth > 0 && ctx.sourceHeight > 0
      ? ctx.sourceWidth / ctx.sourceHeight
      : 16 / 9;
  const wantsVertical = request.aspectRatio === "9:16" || request.aspectRatio === "4:5";
  const isAlreadyVertical = sourceAspect < 1;
  if (request.aspectRatio && !(wantsVertical && isAlreadyVertical)) {
    const aspectParam =
      request.aspectRatio === "4:5" ? "1:1" : request.aspectRatio; // SmartCropAspect has no 4:5
    editOperations.push({
      id: opId("smartcrop"),
      editType: "smart-crop",
      startTime: 0,
      endTime: round(dur),
      reason: `Reframes to ${request.aspectRatio} for ${request.platform}.`,
      confidence: 0.9,
      priority: 0.9,
      evidence: [
        {
          kind: "user-request",
          detail: `${request.platform} → ${request.aspectRatio}`,
        },
      ],
      params: {
        aspectRatio: aspectParam as "9:16" | "1:1" | "16:9",
        focusTarget: ctx.hasInteractionData ? "screen_action" : "motion",
      },
    });
  }

  // ── Captions ─────────────────────────────────────────────────────────────
  const captionsWanted = request.captionStyle !== "none";
  const captionInstructions: DirectorCaptionInstructions = {
    // Captions are generated from a REAL transcript only. If there is none, the
    // instruction records that honestly rather than promising captions that
    // would have to be invented.
    enabled: captionsWanted && ctx.hasTranscript,
    stylePreset: captionPresetFor(request),
    position: captionPositionFor(request.aspectRatio),
    textStyle: captionTextStyleFor(request.style),
    reason: !captionsWanted
      ? "Captions were not requested."
      : ctx.hasTranscript
        ? `${request.style} captions from the transcript.`
        : "No transcript available — captions can't be generated without one.",
  };

  const explanation = buildExplanation(ctx, request, survivingSections, drops, keptSeconds);

  return {
    planVersion: DIRECTOR_PLAN_VERSION,
    goal: request.prompt || `Create a ${request.goal.replace("-", " ")}`,
    platform: request.platform,
    ...(request.targetDurationSeconds !== undefined
      ? { targetDurationSeconds: request.targetDurationSeconds }
      : {}),
    aspectRatio: request.aspectRatio,
    tone: request.style,
    storyStructure: survivingSections,
    clipOperations,
    editOperations,
    audioOperations,
    captionInstructions,
    reviewRules: DEFAULT_REVIEW_RULES,
    explanation,
    modelVersion: HEURISTIC_MODEL_VERSION,
    createdAt: now,
  };
}

function buildExplanation(
  ctx: DirectorVideoContext,
  request: DirectorRequest,
  sections: DirectorSection[],
  drops: DirectorSection[],
  keptSeconds: number
): string {
  const parts: string[] = [];
  parts.push(
    `Built a ${sections.map((s) => s.kind).join(" → ")} structure from ${ctx.durationSeconds.toFixed(0)}s of source.`
  );
  if (request.targetDurationSeconds) {
    parts.push(
      `Target was ${request.targetDurationSeconds}s; kept ${keptSeconds.toFixed(0)}s of source before speed changes.`
    );
  }
  if (drops.length) {
    parts.push(
      `Dropped the ${drops.map((d) => d.kind).join(", ")} section${drops.length > 1 ? "s" : ""} to hit the target.`
    );
  }
  if (ctx.deadSeconds > 0) {
    parts.push(`Removed ${ctx.deadSeconds.toFixed(0)}s of pauses and dead air.`);
  }
  if (!ctx.hasTranscript && request.captionStyle !== "none") {
    parts.push(
      `No transcript exists for this project, so captions were skipped rather than invented.`
    );
  }
  return parts.join(" ");
}

// ════════════════════════════════════════════════════════════════════════════
// Sanitizer — coerces a MODEL's raw JSON into a well-formed plan
// ════════════════════════════════════════════════════════════════════════════

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function evidenceList(v: unknown): DirectorEvidence[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((e) => {
      const rec = e as Record<string, unknown>;
      return {
        kind: str(rec.kind, "heuristic") as DirectorEvidence["kind"],
        detail: str(rec.detail).slice(0, 240),
        ...(rec.ref !== undefined ? { ref: str(rec.ref) } : {}),
        ...(rec.at !== undefined ? { at: num(rec.at) } : {}),
      };
    })
    .filter((e) => e.detail.length > 0)
    .slice(0, 4);
}

/**
 * Coerce a model's JSON into a structurally-valid `DirectorPlan`.
 *
 * This is NOT the validator — it only fixes shape (missing arrays, string
 * numbers, out-of-range confidences). Semantic rejection (bad windows,
 * unsupported edit types, duplicates) is `validate.ts`'s job, and it runs after
 * this on every path. Keeping the two separate is what lets the model's output
 * and the heuristic plan go through the exact same gate.
 */
export function sanitizeDirectorPlan(
  raw: unknown,
  request: DirectorRequest,
  modelVersion: string,
  now = Date.now()
): DirectorPlan {
  const r = (raw ?? {}) as Record<string, unknown>;

  const storyStructure: DirectorSection[] = Array.isArray(r.storyStructure)
    ? (r.storyStructure as Array<Record<string, unknown>>)
        .map((s, i) => ({
          id: str(s.id, `sec-${i}`),
          kind: str(s.kind, "demo") as DirectorSectionKind,
          title: str(s.title, "Section").slice(0, 60),
          startTime: Math.max(0, num(s.startTime)),
          endTime: Math.max(0, num(s.endTime)),
          reason: str(s.reason).slice(0, 240),
          confidence: clamp01(num(s.confidence, 0.5)),
          evidence: evidenceList(s.evidence),
        }))
        .filter((s) => s.endTime > s.startTime)
    : [];

  const clipOperations: DirectorClipOperation[] = Array.isArray(r.clipOperations)
    ? (r.clipOperations as Array<Record<string, unknown>>).map((o, i) => ({
        id: str(o.id, `clip-${i}`),
        kind: str(o.kind, "keep") as DirectorClipOperation["kind"],
        startTime: Math.max(0, num(o.startTime)),
        endTime: Math.max(0, num(o.endTime)),
        reason: str(o.reason).slice(0, 240),
        confidence: clamp01(num(o.confidence, 0.5)),
        priority: clamp01(num(o.priority, 0.5)),
        evidence: evidenceList(o.evidence),
        ...(o.sectionId !== undefined ? { sectionId: str(o.sectionId) } : {}),
        ...(o.order !== undefined ? { order: num(o.order) } : {}),
      }))
    : [];

  const editOperations: DirectorEditOperation[] = Array.isArray(r.editOperations)
    ? (r.editOperations as Array<Record<string, unknown>>).map((o, i) => {
        const p = (o.params ?? {}) as Record<string, unknown>;
        const fr = o.focusRegion as Record<string, unknown> | undefined;
        return {
          id: str(o.id, `edit-${i}`),
          // Left AS-IS when unknown — the validator rejects it with
          // `unsupported_edit_type` and reports it. Coercing a hallucinated type
          // to "zoom" here would silently put the wrong edit on the timeline.
          editType: str(o.editType) as DirectorEditOperation["editType"],
          startTime: Math.max(0, num(o.startTime)),
          endTime: Math.max(0, num(o.endTime)),
          reason: str(o.reason).slice(0, 240),
          confidence: clamp01(num(o.confidence, 0.5)),
          priority: clamp01(num(o.priority, 0.5)),
          evidence: evidenceList(o.evidence),
          ...(o.sectionId !== undefined ? { sectionId: str(o.sectionId) } : {}),
          ...(fr
            ? {
                focusRegion: {
                  x: clamp01(num(fr.x)),
                  y: clamp01(num(fr.y)),
                  width: clamp01(num(fr.width, 0.4)),
                  height: clamp01(num(fr.height, 0.4)),
                },
              }
            : {}),
          ...(o.intensity !== undefined ? { intensity: clamp01(num(o.intensity)) } : {}),
          params: {
            ...(p.text !== undefined ? { text: str(p.text).slice(0, 120) } : {}),
            ...(p.ctaText !== undefined ? { ctaText: str(p.ctaText).slice(0, 60) } : {}),
            ...(p.speedMultiplier !== undefined
              ? { speedMultiplier: Math.max(1, num(p.speedMultiplier, 2)) }
              : {}),
            ...(p.transitionStyle !== undefined
              ? { transitionStyle: str(p.transitionStyle) as never }
              : {}),
            ...(p.calloutStyle !== undefined
              ? { calloutStyle: str(p.calloutStyle) as never }
              : {}),
            ...(p.aspectRatio !== undefined
              ? { aspectRatio: str(p.aspectRatio) as never }
              : {}),
            ...(p.focusTarget !== undefined
              ? { focusTarget: str(p.focusTarget) as never }
              : {}),
            // Carried through AS-IS, exactly like `editType`. An id that isn't in
            // the registry must reach the executor's gate so it gets REPORTED —
            // dropping it here would turn "you asked for a design we don't have"
            // into a silent substitution, which is the failure mode this whole
            // validated-id mechanism exists to prevent.
            ...(p.presetId !== undefined ? { presetId: str(p.presetId) } : {}),
          },
        };
      })
    : [];

  const audioOperations: DirectorAudioOperation[] = Array.isArray(r.audioOperations)
    ? (r.audioOperations as Array<Record<string, unknown>>).map((o, i) => ({
        id: str(o.id, `audio-${i}`),
        kind: str(o.kind, "remove-silence") as DirectorAudioOperation["kind"],
        startTime: Math.max(0, num(o.startTime)),
        endTime: Math.max(0, num(o.endTime)),
        reason: str(o.reason).slice(0, 240),
        confidence: clamp01(num(o.confidence, 0.5)),
        priority: clamp01(num(o.priority, 0.5)),
        evidence: evidenceList(o.evidence),
        ...(o.sectionId !== undefined ? { sectionId: str(o.sectionId) } : {}),
      }))
    : [];

  const ci = (r.captionInstructions ?? {}) as Record<string, unknown>;
  const captionInstructions: DirectorCaptionInstructions = {
    enabled: ci.enabled === true && request.captionStyle !== "none",
    stylePreset: (str(ci.stylePreset) || captionPresetFor(request)) as OverlayTextPreset,
    position: (str(ci.position) ||
      captionPositionFor(request.aspectRatio)) as CaptionPosition,
    textStyle: captionTextStyleFor(request.style),
    // As-is — the executor's registry gate validates it and reports a bad id.
    ...(ci.presetId !== undefined ? { presetId: str(ci.presetId) } : {}),
    reason: str(ci.reason, "Captions from the transcript.").slice(0, 240),
  };

  return {
    planVersion: DIRECTOR_PLAN_VERSION,
    goal: str(r.goal, request.prompt || request.goal).slice(0, 300),
    platform: request.platform,
    ...(request.targetDurationSeconds !== undefined
      ? { targetDurationSeconds: request.targetDurationSeconds }
      : {}),
    aspectRatio: request.aspectRatio,
    tone: str(r.tone, request.style).slice(0, 60),
    storyStructure,
    clipOperations,
    editOperations: editOperations.filter((o) => o.editType !== undefined),
    audioOperations,
    captionInstructions,
    reviewRules: DEFAULT_REVIEW_RULES,
    explanation: str(r.explanation, "").slice(0, 1200),
    modelVersion,
    createdAt: now,
  };
}

/** True when a plan has at least one operation that could change the timeline. */
export function planHasWork(plan: DirectorPlan): boolean {
  return (
    plan.editOperations.some((o) => isDirectorEditType(o.editType)) ||
    plan.clipOperations.some((o) => o.kind === "remove" || o.kind === "trim") ||
    plan.audioOperations.some((o) => o.kind !== "keep-audio") ||
    plan.captionInstructions.enabled
  );
}
