/**
 * Smart Clip Generation — a PURE, deterministic heuristic that proposes short,
 * self-contained clips cut from a single source video, using the signals
 * analysis already produced (transcript, attention curve, detected moments,
 * narrative structure, audio, motion) + the user-selected video type.
 *
 * No LLM call, no DOM, no Firestore. `generateClips(input)` in → `GeneratedClip[]`
 * out, so it's fully unit-testable and cheap to re-run on the client whenever
 * analysis changes. Each clip is just an [startTime,endTime] WINDOW over the
 * original media — it never duplicates the file. `clipRangeCutMoments()` turns a
 * window into the two synthetic `cut` moments that make the existing export
 * pipeline render exactly that window (see the export panel).
 */

import type {
  Analysis,
  VisualAnalysis,
  DetectedMoment,
  GeneratedClip,
  ClipType,
  ClipAspectRatio,
  NarrativeRole,
  NarrativeSegment,
  OverlayTextPreset,
  SelectedVideoType,
  Transcript,
  VideoType,
} from "@/lib/firebase/schema";
import { getAttentionAt } from "@/lib/attention/score";
import { dequantize, dequantizeArray } from "@/lib/cv/resample";

// ── Public metadata (also used by the Clips UI) ─────────────────────────────

export const CLIP_TYPE_META: Record<
  ClipType,
  { label: string; accent: string; blurb: string }
> = {
  best_hook: { label: "Hook", accent: "violet", blurb: "A strong opening that grabs attention fast." },
  valuable_explanation: { label: "Explainer", accent: "sky", blurb: "A clear, self-contained explanation." },
  funny_moment: { label: "Funny", accent: "amber", blurb: "A light or entertaining beat." },
  emotional_moment: { label: "Emotional", accent: "rose", blurb: "A high-feeling moment." },
  product_demo_moment: { label: "Demo", accent: "emerald", blurb: "A product / feature in action." },
  tutorial_step: { label: "Step", accent: "cyan", blurb: "A complete how-to step." },
  strong_opinion: { label: "Opinion", accent: "orange", blurb: "A confident, quotable take." },
  before_after: { label: "Before / After", accent: "teal", blurb: "A visible change or transformation." },
  result_reveal: { label: "Result", accent: "lime", blurb: "The payoff / outcome." },
  call_to_action: { label: "CTA", accent: "pink", blurb: "A closing call to action." },
};

/** Which aspect a clip is best exported at, per resolved video type. */
const ASPECT_BY_TYPE: Record<SelectedVideoType, ClipAspectRatio> = {
  auto: "9:16",
  "reels-shorts": "9:16",
  "talking-head": "9:16",
  "podcast-clip": "9:16",
  "product-demo": "16:9",
  tutorial: "16:9",
  vlog: "9:16",
  "ad-promo": "9:16",
  "screen-recording": "16:9",
};

const CAPTION_BY_TYPE: Record<SelectedVideoType, OverlayTextPreset> = {
  auto: "clean",
  "reels-shorts": "bold_social",
  "talking-head": "clean",
  "podcast-clip": "podcast",
  "product-demo": "tutorial",
  tutorial: "tutorial",
  vlog: "clean",
  "ad-promo": "bold_social",
  "screen-recording": "tutorial",
};

/** Preferred clip length window per resolved video type (seconds). */
interface LengthRule {
  min: number;
  max: number;
  ideal: number;
}
const LENGTH_RULES: Record<SelectedVideoType, LengthRule> = {
  auto: { min: 15, max: 60, ideal: 30 },
  "reels-shorts": { min: 15, max: 60, ideal: 28 },
  "talking-head": { min: 15, max: 60, ideal: 30 },
  "podcast-clip": { min: 30, max: 90, ideal: 50 },
  "product-demo": { min: 20, max: 120, ideal: 48 },
  tutorial: { min: 20, max: 90, ideal: 42 },
  vlog: { min: 15, max: 60, ideal: 30 },
  "ad-promo": { min: 12, max: 45, ideal: 22 },
  "screen-recording": { min: 20, max: 120, ideal: 48 },
};

/** Hard floor — never propose a clip shorter than this unless it's exceptional. */
const MIN_CLIP_SECONDS = 8;
const EXCEPTIONAL_SCORE = 0.85;
/** At or below this total duration we return ONE edited version, not many clips. */
const VERY_SHORT_MAX_SECONDS = 20;
/**
 * The ONLY duration at which zero clips is a legitimate answer: below the hard
 * floor there is no window left to cut. Every longer video gets at least one
 * clip — a real one when the signals support it, a fallback otherwise.
 */
export const MIN_SOURCE_SECONDS = MIN_CLIP_SECONDS;
/** How many fallback clips we propose when no strong moment survives scoring. */
const MAX_FALLBACK_CLIPS = 3;

export interface ClipGenInput {
  duration: number;
  selectedVideoType?: SelectedVideoType;
  analysis?: Pick<
    Analysis,
    | "detectedMoments"
    | "transcript"
    | "narrativeStructure"
    | "attentionCurve"
    | "attentionSampleRate"
    | "audioAnalysis"
    | "videoType"
    | "editRecipe"
  > | null;
  visualAnalysis?: Pick<
    VisualAnalysis,
    "motion" | "sampleRate" | "centroidX" | "centroidY" | "sceneChanges"
  > | null;
  /** Injected for deterministic tests; defaults to Date.now(). */
  now?: number;
}

/** Deterministic keyword cues — no LLM, just honest text signals. */
const CTA_CUES = [
  "subscribe",
  "link in bio",
  "sign up",
  "try it",
  "check out",
  "follow me",
  "comment below",
  "download",
  "get started",
];
const OPINION_CUES = [
  "honestly",
  "the truth is",
  "i think",
  "in my opinion",
  "biggest mistake",
  "the problem with",
  "nobody talks about",
  "unpopular opinion",
];

/** Resolve the user choice (or "auto") to a concrete type for length/aspect rules. */
export function resolveClipVideoType(
  selected: SelectedVideoType | undefined,
  detected: VideoType | undefined
): SelectedVideoType {
  if (selected && selected !== "auto") return selected;
  switch (detected) {
    case "vertical-short":
      return "reels-shorts";
    case "talking-tutorial":
      return "talking-head";
    case "saas-demo":
      return "product-demo";
    case "onboarding-flow":
      return "screen-recording";
    case "coding-tutorial":
    case "presentation":
      return "tutorial";
    default:
      return "reels-shorts"; // sensible short-form default for clips
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Why a run produced what it produced. `ok`/`fallback` carry clips; the rest are
 * the ONLY ways to legitimately get zero, and each maps to an exact sentence the
 * UI shows instead of a bare "No clips yet" (see clipGenMessage).
 *
 * `not_analyzed` is never returned by the generator itself — it's the caller's
 * gate (the generator happily works from duration alone), but it lives in this
 * union so one message map covers every empty state the panel can show.
 */
export type ClipGenReasonCode =
  | "ok"
  | "fallback"
  | "no_duration"
  | "source_too_short"
  | "not_analyzed";

/**
 * COUNTS ONLY — this is what gets logged. Never put transcript text (or any
 * other user content) in here; see the analytics contract in ClipsPanel.
 */
export interface ClipGenStats {
  durationSeconds: number;
  /** Existing timeline moments (the AI edits we mine for clip signals). */
  momentCount: number;
  transcriptAvailable: boolean;
  attentionSamples: number;
  clipCount: number;
  fallbackUsed: boolean;
}

export interface ClipGenResult {
  clips: GeneratedClip[];
  reasonCode: ClipGenReasonCode;
  /** True when no strong standalone moment survived scoring and we filled in. */
  fallbackUsed: boolean;
  stats: ClipGenStats;
}

/**
 * The full outcome of a generation run — clips PLUS why. Prefer this over
 * `generateClips` at any call site that has to explain itself to a user: an
 * empty `clips` array always comes with a `reasonCode` that says what was
 * missing, so the panel never has to guess.
 *
 * Guarantees:
 *   duration < MIN_SOURCE_SECONDS  → [] + "source_too_short" (the only honest zero)
 *   duration ≤ VERY_SHORT_MAX      → exactly one whole-video "edited version"
 *   otherwise                      → ≥ 1 clip, falling back to attention /
 *                                    edit-density / evenly-spaced windows when
 *                                    no strong standalone moment scores through.
 */
export function generateClipsDetailed(input: ClipGenInput): ClipGenResult {
  const { duration } = input;
  if (!Number.isFinite(duration) || duration <= 0) {
    return emptyResult(input, "no_duration");
  }
  if (duration < MIN_SOURCE_SECONDS) {
    return emptyResult(input, "source_too_short");
  }

  const resolvedType = resolveClipVideoType(
    input.selectedVideoType,
    input.analysis?.videoType
  );
  const rule = LENGTH_RULES[resolvedType];
  const now = input.now ?? Date.now();

  // Very short video → one edited version of the whole thing, not many clips.
  if (duration <= VERY_SHORT_MAX_SECONDS || duration < rule.min + 4) {
    const clip = buildWholeVideoClip(input, resolvedType, now);
    return result(input, [clip], "ok", false);
  }

  const candidates = buildCandidates(input, resolvedType, rule);
  const scored = candidates
    .map((c) => ({ ...c, ...scoreWindow(c, input, rule) }))
    // Drop sub-floor windows unless they're exceptional.
    .filter((c) => c.endTime - c.startTime >= MIN_CLIP_SECONDS || c.score >= EXCEPTIONAL_SCORE)
    .sort((a, b) => b.score - a.score);

  const target = clipCountForDuration(duration);
  const picked = greedyPickNonOverlapping(scored, target);

  // NEVER return empty for a video we can actually cut. Candidates can all get
  // filtered out (every narrative beat too short to fit the rule, no attention
  // curve, no clusters) — that's a weak-signal video, not a zero-clip one, so we
  // fill in from whatever signal IS present.
  if (picked.length === 0) {
    return result(input, generateFallbackClips(input), "fallback", true);
  }

  const clips = picked
    .sort((a, b) => a.startTime - b.startTime)
    .map((c, i) => finalizeClip(c, i, input, resolvedType, rule, now));
  return result(input, clips, "ok", false);
}

/**
 * Clips only — the original signature, kept for the call sites that don't need
 * to explain an empty result (single-clip re-roll, tests).
 */
export function generateClips(input: ClipGenInput): GeneratedClip[] {
  return generateClipsDetailed(input).clips;
}

/**
 * The FALLBACK set on its own: 1–3 clips built from whatever signal survives —
 * the highest-attention windows, else the densest existing-edit windows, else
 * evenly spaced ones. `generateClipsDetailed` calls this when nothing scores
 * through, and it's exported so the guarantee ("an analyzed video above the hard
 * floor always yields a clip") is directly testable — the scored path normally
 * wins, which would otherwise leave these branches unreachable.
 */
export function generateFallbackClips(input: ClipGenInput): GeneratedClip[] {
  const { duration } = input;
  if (!Number.isFinite(duration) || duration < MIN_SOURCE_SECONDS) return [];

  const resolvedType = resolveClipVideoType(input.selectedVideoType, input.analysis?.videoType);
  const rule = LENGTH_RULES[resolvedType];
  const now = input.now ?? Date.now();

  // A video too short to split is always answerable with one edited version.
  if (duration <= VERY_SHORT_MAX_SECONDS || duration < rule.min + 4) {
    return [buildWholeVideoClip(input, resolvedType, now)];
  }

  const clips = buildFallbackCandidates(input, rule)
    .map((c) => ({ ...c, ...scoreWindow(c, input, rule) }))
    .sort((a, b) => a.startTime - b.startTime)
    .map((c, i) => finalizeClip(c, i, input, resolvedType, rule, now, true));

  // Even a degenerate fallback owes the user a clip.
  return clips.length > 0 ? clips : [buildWholeVideoClip(input, resolvedType, now)];
}

function result(
  input: ClipGenInput,
  clips: GeneratedClip[],
  reasonCode: ClipGenReasonCode,
  fallbackUsed: boolean
): ClipGenResult {
  return { clips, reasonCode, fallbackUsed, stats: clipGenStats(input, clips, fallbackUsed) };
}

function emptyResult(input: ClipGenInput, reasonCode: ClipGenReasonCode): ClipGenResult {
  return result(input, [], reasonCode, false);
}

/** Counts only — safe to log verbatim. */
export function clipGenStats(
  input: ClipGenInput,
  clips: GeneratedClip[],
  fallbackUsed: boolean
): ClipGenStats {
  const a = input.analysis;
  return {
    durationSeconds: Number.isFinite(input.duration) ? Math.round(input.duration) : 0,
    momentCount: a?.detectedMoments?.length ?? 0,
    transcriptAvailable: (a?.transcript?.segments?.length ?? 0) > 0,
    attentionSamples: a?.attentionCurve?.length ?? 0,
    clipCount: clips.length,
    fallbackUsed,
  };
}

/** The exact sentence the panel shows for a run's outcome. */
export function clipGenMessage(reasonCode: ClipGenReasonCode, count: number): string {
  switch (reasonCode) {
    case "ok":
      return `${count} smart clip${count === 1 ? "" : "s"} generated`;
    case "fallback":
      return `Could not find strong moments, so ${count} fallback clip${
        count === 1 ? " was" : "s were"
      } created`;
    case "source_too_short":
      return `No clips can be generated because the video is shorter than ${MIN_SOURCE_SECONDS} seconds.`;
    case "no_duration":
      return "The video length isn't known yet, so no clip windows could be placed.";
    case "not_analyzed":
      return "Analyze video first to generate smart clips.";
  }
}

// ── Synthetic-cut helper (window → export) ──────────────────────────────────

/**
 * Two `cut` moments that, added to the timeline, make the INCLUDED complement
 * exactly [start,end] — so the existing export pipeline renders only the clip
 * (buildTimelineMap merges these with any real cuts). Returns [] for a
 * whole-video window. Guards inverted/degenerate ranges.
 */
export function clipRangeCutMoments(
  start: number,
  end: number,
  sourceDuration: number
): DetectedMoment[] {
  const s = Math.max(0, Math.min(start, end));
  const e = Math.min(sourceDuration, Math.max(start, end));
  const cuts: DetectedMoment[] = [];
  const EPS = 0.02;
  if (s > EPS) cuts.push(makeCut("clip-cut-lead", 0, s));
  if (e < sourceDuration - EPS) cuts.push(makeCut("clip-cut-tail", e, sourceDuration));
  return cuts;
}

function makeCut(id: string, startTime: number, endTime: number): DetectedMoment {
  return {
    id,
    startTime,
    endTime,
    label: "Clip trim",
    reason: "Outside the selected clip window",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType: "cut",
    cut: { active: true },
    source: "user",
  };
}

// ── Candidate windows ───────────────────────────────────────────────────────

interface Candidate {
  startTime: number;
  endTime: number;
  seedType: ClipType;
  role?: NarrativeRole;
  signals: string[];
}

function buildCandidates(
  input: ClipGenInput,
  resolvedType: SelectedVideoType,
  rule: LengthRule
): Candidate[] {
  const { duration, analysis } = input;
  const out: Candidate[] = [];

  // (a) Narrative segments — the strongest structural signal.
  const segments = analysis?.narrativeStructure ?? [];
  for (const seg of segments) {
    if (seg.role === "transition" || seg.role === "filler") continue;
    const w = fitWindowToRule(seg.startTime, seg.endTime, rule, duration, input);
    if (!w) continue;
    out.push({
      ...w,
      seedType: clipTypeForRole(seg.role, seg.startTime, duration),
      role: seg.role,
      signals: [`${narrativeLabel(seg.role)} beat`],
    });
  }

  // (b) Attention peaks — slide an ideal-length window across the video.
  if (hasAttention(analysis)) {
    const step = Math.max(4, rule.ideal / 2);
    for (let s = 0; s + rule.min <= duration; s += step) {
      const e = Math.min(duration, s + rule.ideal);
      out.push({
        startTime: s,
        endTime: e,
        seedType: positionalType(s, duration),
        signals: ["attention peak"],
      });
    }
  }

  // (c) Moment clusters — dense stretches of real edits (zooms/clicks/etc).
  const clusters = clusterMoments(analysis?.detectedMoments ?? [], rule);
  for (const cl of clusters) {
    const w = fitWindowToRule(cl.start, cl.end, rule, duration, input);
    if (!w) continue;
    out.push({ ...w, seedType: "product_demo_moment", signals: ["dense edits"] });
  }

  // (d) Call-to-action — when the recipe wants a CTA, add an end clip.
  if (recipeWantsCta(analysis) && duration > rule.min) {
    const s = Math.max(0, duration - rule.ideal);
    out.push({
      startTime: s,
      endTime: duration,
      seedType: "call_to_action",
      signals: ["call-to-action ending"],
    });
  }

  // NOTE: no fallback here. A signal-less video produces zero candidates on
  // purpose — `generateClipsDetailed` catches that and runs the ONE fallback
  // path (buildFallbackCandidates), so a filled-in window is always flagged as
  // such instead of being quietly mixed in with the scored picks.
  return dedupeWindows(out);
}

function clipTypeForRole(role: NarrativeRole, start: number, duration: number): ClipType {
  switch (role) {
    case "intro":
      return "best_hook";
    case "result":
      return "result_reveal";
    case "action":
      return "product_demo_moment";
    case "explanation":
      return "valuable_explanation";
    case "setup":
      return start < duration * 0.15 ? "best_hook" : "valuable_explanation";
    default:
      return "valuable_explanation";
  }
}

function positionalType(start: number, duration: number): ClipType {
  const p = start / duration;
  if (p < 0.15) return "best_hook";
  if (p > 0.8) return "result_reveal";
  return "valuable_explanation";
}

/** Expand a too-short window / trim a too-long one toward the ideal length. */
function fitWindowToRule(
  start: number,
  end: number,
  rule: LengthRule,
  duration: number,
  input: ClipGenInput
): { startTime: number; endTime: number } | null {
  let s = Math.max(0, start);
  let e = Math.min(duration, end);
  if (e <= s) return null;
  const len = e - s;

  if (len < rule.min) {
    // Grow symmetrically toward the ideal, clamped to the media bounds.
    const grow = rule.ideal - len;
    s = Math.max(0, s - grow / 2);
    e = Math.min(duration, e + grow / 2);
  } else if (len > rule.max) {
    // Keep the highest-attention `ideal`-length sub-window.
    const best = bestSubWindow(s, e, rule.ideal, input);
    s = best.start;
    e = best.end;
  }
  if (e - s < MIN_CLIP_SECONDS && e - s < rule.min) return null;
  return { startTime: s, endTime: e };
}

function bestSubWindow(
  start: number,
  end: number,
  len: number,
  input: ClipGenInput
): { start: number; end: number } {
  if (!hasAttention(input.analysis)) return { start, end: Math.min(end, start + len) };
  let best = { start, end: Math.min(end, start + len), score: -1 };
  const step = Math.max(2, len / 4);
  for (let s = start; s + len <= end + 0.01; s += step) {
    const score = meanAttention(input.analysis, s, s + len);
    if (score > best.score) best = { start: s, end: s + len, score };
  }
  return { start: best.start, end: best.end };
}

interface Cluster {
  start: number;
  end: number;
  /** How many real edits landed in it — a short, dense burst still counts. */
  count: number;
}
function clusterMoments(moments: DetectedMoment[], rule: LengthRule): Cluster[] {
  const relevant = moments
    .filter((m) => m.effectType !== "cut" && m.effectType !== "speed-up")
    .slice()
    .sort((a, b) => a.startTime - b.startTime);
  const clusters: Cluster[] = [];
  const GAP = 6; // seconds — moments closer than this join a cluster
  for (const m of relevant) {
    const last = clusters[clusters.length - 1];
    if (last && m.startTime - last.end <= GAP && last.end - last.start < rule.max) {
      last.end = Math.max(last.end, m.endTime);
      last.count++;
    } else {
      clusters.push({ start: m.startTime, end: m.endTime, count: 1 });
    }
  }
  // A cluster is interesting if it's LONG (a sustained stretch of action) or
  // DENSE (several edits stacked in a few seconds — a zoom + hook + caption +
  // CTA burst is a clip-worthy beat even though it only spans 8s). Short-but-
  // dense clusters are grown to the length rule by `fitWindowToRule`; requiring
  // a 10s raw span here used to throw them away, so an already-edited timeline
  // produced no clips around its own edits.
  return clusters.filter((c) => c.count >= 2 || c.end - c.start >= Math.min(rule.min, 10));
}

function recipeWantsCta(
  analysis: ClipGenInput["analysis"]
): boolean {
  const cats = analysis?.editRecipe?.enabledCategories;
  if (Array.isArray(cats) && (cats.includes("branding") || cats.includes("call_to_action" as never)))
    return true;
  // A branding-cta / CTA overlay near the end also implies a CTA.
  const moments = analysis?.detectedMoments ?? [];
  return moments.some((m) => m.effectType === "branding-cta");
}

/** Merge windows that start/end within ~2s of each other (near-duplicates). */
function dedupeWindows(cands: Candidate[]): Candidate[] {
  const sorted = cands.slice().sort((a, b) => a.startTime - b.startTime);
  const out: Candidate[] = [];
  for (const c of sorted) {
    const near = out.find(
      (o) => Math.abs(o.startTime - c.startTime) < 2 && Math.abs(o.endTime - c.endTime) < 2
    );
    if (near) {
      // Prefer the more "structural" seed (narrative role wins over positional).
      if (c.role && !near.role) {
        near.seedType = c.seedType;
        near.role = c.role;
      }
      near.signals = Array.from(new Set([...near.signals, ...c.signals]));
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

// ── Fallback windows (the "never return zero" path) ─────────────────────────

/**
 * How much EXISTING EDIT ACTIVITY sits inside a window, 0..1. This is the signal
 * that lets a video with no transcript and no attention curve still produce
 * clips: an already-edited timeline tells us where the interesting parts are.
 *
 * Unlike `momentDensityScore` (which scores clip QUALITY and so ignores cuts and
 * speed-ups) this counts EVERY edit type — a stretch dense with cuts, zooms,
 * captions, text overlays and a CTA is exactly where a clip wants to be. Weights
 * rank how much each type says "something happens here".
 */
const EDIT_SIGNAL_WEIGHT: Partial<Record<DetectedMoment["effectType"], number>> = {
  zoom: 1,
  "hook-text": 1,
  "branding-cta": 1,
  "cursor-focus": 0.9,
  "click-highlight": 0.8,
  "text-overlay": 0.8,
  callout: 0.8,
  captions: 0.6,
  "smart-crop": 0.5,
  crop: 0.4,
  transition: 0.4,
  cut: 0.35,
  "speed-up": 0.35,
  "blur-redaction": 0.3,
};

function editDensityScore(moments: DetectedMoment[], s: number, e: number): number {
  let sum = 0;
  for (const m of moments) {
    if (m.endTime <= s || m.startTime >= e) continue;
    sum += EDIT_SIGNAL_WEIGHT[m.effectType] ?? 0.5;
  }
  // ~4 weighted edits in a window is already "dense".
  return clamp01(sum / 4);
}

/**
 * Windows to fall back to when nothing scored through, in descending order of
 * honesty about what we actually know:
 *   1. attention curve  → the highest-attention windows
 *   2. existing edits   → the densest edit-activity windows
 *   3. neither          → evenly spaced safe windows
 * Always returns 1–3 non-overlapping windows for a video above the hard floor.
 */
function buildFallbackCandidates(input: ClipGenInput, rule: LengthRule): Candidate[] {
  const { duration, analysis } = input;
  const moments = analysis?.detectedMoments ?? [];

  // A window we can actually fit: the ideal length, but never longer than the
  // video and never below the hard floor.
  const len = Math.max(
    MIN_CLIP_SECONDS,
    Math.min(rule.ideal, Math.max(duration / MAX_FALLBACK_CLIPS, MIN_CLIP_SECONDS))
  );
  const windowLen = Math.min(len, duration);
  const count = clampInt(Math.floor(duration / windowLen), 1, MAX_FALLBACK_CLIPS);

  const attention = hasAttention(analysis);
  const edits = moments.length > 0;

  // (3) No attention and no edits → evenly spaced, no pretense of ranking.
  if (!attention && !edits) {
    const gap = duration / count;
    const out: Candidate[] = [];
    for (let i = 0; i < count; i++) {
      const s = i * gap;
      const e = Math.min(duration, s + Math.min(windowLen, gap));
      if (e - s < MIN_CLIP_SECONDS) continue;
      out.push({
        startTime: s,
        endTime: e,
        seedType: positionalType(s, duration),
        signals: ["evenly spaced window"],
      });
    }
    return out.length > 0
      ? out
      : [
          {
            startTime: 0,
            endTime: duration,
            seedType: "best_hook",
            signals: ["evenly spaced window"],
          },
        ];
  }

  // (1)/(2) Rank sliding windows by whichever signal we have.
  const signal = attention ? "highest-attention window" : "densest edit activity";
  const step = Math.max(2, windowLen / 2);
  const ranked: Array<Candidate & { rank: number }> = [];
  for (let s = 0; s + windowLen <= duration + 0.01; s += step) {
    const e = Math.min(duration, s + windowLen);
    const attn = attention ? meanAttention(analysis, s, e) : 0;
    const dens = edits ? editDensityScore(moments, s, e) : 0;
    ranked.push({
      startTime: s,
      endTime: e,
      seedType: positionalType(s, duration),
      signals: [signal],
      rank: attention ? 0.65 * attn + 0.35 * dens : dens,
    });
  }
  ranked.sort((a, b) => b.rank - a.rank || a.startTime - b.startTime);

  const picked: Candidate[] = [];
  for (const c of ranked) {
    if (picked.length >= count) break;
    if (picked.some((p) => overlapFraction(p, c) > 0.25)) continue;
    picked.push({ startTime: c.startTime, endTime: c.endTime, seedType: c.seedType, signals: c.signals });
  }
  return picked;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function scoreWindow(
  c: Candidate,
  input: ClipGenInput,
  rule: LengthRule
): { score: number; scoreSignals: string[] } {
  const { analysis } = input;
  const dur = c.endTime - c.startTime;
  const signals = new Set<string>();

  const attn = hasAttention(analysis) ? meanAttention(analysis, c.startTime, c.endTime) : 0.5;
  if (attn > 0.6) signals.add("high viewer attention");

  const lenFit = lengthFit(dur, rule);
  const momentScore = momentDensityScore(analysis?.detectedMoments ?? [], c.startTime, c.endTime);
  if (momentScore > 0.5) signals.add("dense, edit-worthy action");
  const speech = speechCoverage(analysis?.transcript, c.startTime, c.endTime);
  if (speech > 0.6) signals.add("clear narration");

  // ── Extra deterministic signals ──────────────────────────────────────────
  // Words-per-second: a well-packed explanation beats a rambling one.
  const density = transcriptDensity(analysis?.transcript, c.startTime, c.endTime);
  if (density > 0.6) signals.add("information-dense speech");
  // Loudest audio beat in the window (laughs, emphasis, reveals all spike).
  const audioPeak = audioPeakScore(analysis?.audioAnalysis, c.startTime, c.endTime);
  if (audioPeak > 0.7) signals.add("strong audio beat");
  // Visual motion — a static slide is a weaker clip than a live demo.
  const motion = meanMotion(input.visualAnalysis, c.startTime, c.endTime);
  if (motion !== null && motion > 0.25) signals.add("visually active");

  let bonus = 0;
  // Starting ON a scene boundary is a clean cut-in; starting 1s AFTER one means
  // we'd open mid-shot.
  const sceneFit = sceneBoundaryFit(input.visualAnalysis, c.startTime);
  if (sceneFit > 0) {
    bonus += 0.05;
    signals.add("clean scene cut-in");
  }
  bonus += 0.06 * density + 0.06 * audioPeak;
  if (motion !== null) bonus += 0.04 * motion;

  switch (c.role) {
    case "result":
      bonus += 0.15;
      signals.add("payoff / result");
      break;
    case "action":
      bonus += 0.12;
      signals.add("key action");
      break;
    case "intro":
      bonus += 0.1;
      signals.add("strong opening");
      break;
    case "explanation":
      bonus += 0.06;
      break;
    default:
      break;
  }
  if (c.seedType === "call_to_action") bonus += 0.06;
  // Hooks matter → a small boost to windows that begin near the start.
  if (c.startTime < input.duration * 0.1) {
    bonus += 0.06;
    signals.add("opens the video");
  }

  // Idle penalty — a low-attention, low-motion, silent stretch is a weak clip.
  let penalty = 0;
  if (attn < 0.22 && motion !== null && motion < 0.05) {
    penalty += 0.2;
  }
  if (speech < 0.15 && density < 0.1 && audioPeak < 0.2) {
    penalty += 0.1; // nothing said, nothing heard
  }

  const base = 0.44 * attn + 0.24 * lenFit + 0.16 * momentScore + 0.16 * speech;
  const score = clamp01(base + bonus - penalty);
  return { score, scoreSignals: [...signals] };
}

/** 1 at the ideal length, tapering to 0 outside [min*0.6, max*1.4]. */
function lengthFit(dur: number, rule: LengthRule): number {
  if (dur < MIN_CLIP_SECONDS) return 0;
  if (dur <= rule.ideal) {
    const lo = rule.min * 0.6;
    return clamp01((dur - lo) / (rule.ideal - lo));
  }
  const hi = rule.max * 1.4;
  return clamp01((hi - dur) / (hi - rule.ideal));
}

function momentDensityScore(moments: DetectedMoment[], s: number, e: number): number {
  let sum = 0;
  for (const m of moments) {
    if (m.effectType === "cut" || m.effectType === "speed-up") continue;
    if (m.endTime <= s || m.startTime >= e) continue;
    // Weight by confidence/provenance: event-sourced > cv > ai.
    const conf = m.confidenceScore ?? m.attentionScore ?? 0.5;
    const provWeight = m.provenance === "event" ? 1.1 : m.provenance === "cv" ? 0.9 : 0.7;
    sum += conf * provWeight;
  }
  return clamp01(sum / 3);
}

/**
 * Words per second inside the window, normalized against a brisk ~3 w/s. A
 * dense, well-packed explanation scores higher than a rambling stretch.
 */
function transcriptDensity(
  transcript: Transcript | undefined | null,
  s: number,
  e: number
): number {
  const span = e - s;
  if (span <= 0) return 0;
  const words = transcript?.words;
  if (words && words.length > 0) {
    const n = words.filter((w) => w.startTime < e && w.endTime > s).length;
    return clamp01(n / span / 3);
  }
  const segs = transcript?.segments;
  if (!segs || segs.length === 0) return 0;
  let n = 0;
  for (const seg of segs) {
    if (seg.endTime <= s || seg.startTime >= e) continue;
    n += seg.text.trim().split(/\s+/).filter(Boolean).length;
  }
  return clamp01(n / span / 3);
}

/** Loudest audio beat in the window (0..1) — reveals, laughs, emphasis spike. */
function audioPeakScore(
  audio: Analysis["audioAnalysis"] | undefined | null,
  s: number,
  e: number
): number {
  const arr = audio?.loudness;
  if (!arr || arr.length === 0) return 0;
  const rate = audio?.loudnessSampleRate || 1;
  const i0 = Math.max(0, Math.floor(s * rate));
  const i1 = Math.min(arr.length - 1, Math.ceil(e * rate));
  let peak = 0;
  for (let i = i0; i <= i1; i++) peak = Math.max(peak, dequantize(arr[i]));
  return clamp01(peak);
}

/** 1 when the window starts on a detected scene boundary (a clean cut-in). */
function sceneBoundaryFit(
  va: ClipGenInput["visualAnalysis"],
  start: number
): number {
  const scenes = va?.sceneChanges;
  if (!scenes || scenes.length === 0) return 0;
  return scenes.some((sc) => Math.abs(sc.t - start) < 1.2) ? 1 : 0;
}

/** All spoken text inside the window (for the deterministic keyword cues). */
function transcriptText(
  transcript: Transcript | undefined | null,
  s: number,
  e: number
): string {
  const segs = transcript?.segments;
  if (!segs || segs.length === 0) return "";
  return segs
    .filter((g) => g.endTime > s && g.startTime < e)
    .map((g) => g.text)
    .join(" ");
}

function speechCoverage(transcript: Transcript | undefined | null, s: number, e: number): number {
  const segs = transcript?.segments;
  if (!segs || segs.length === 0) return 0;
  const span = e - s;
  if (span <= 0) return 0;
  let covered = 0;
  for (const seg of segs) {
    const os = Math.max(s, seg.startTime);
    const oe = Math.min(e, seg.endTime);
    if (oe > os) covered += oe - os;
  }
  return clamp01(covered / span);
}

// ── Selection ───────────────────────────────────────────────────────────────

function clipCountForDuration(duration: number): number {
  if (duration < 30) return 1;
  if (duration < 90) return 3;
  if (duration <= 300) return clampInt(Math.round(duration / 50), 3, 6);
  return clampInt(Math.round(duration / 60), 5, 8);
}

function greedyPickNonOverlapping<T extends Candidate & { score: number }>(
  scored: T[],
  target: number
): T[] {
  const picked: T[] = [];
  for (const c of scored) {
    if (picked.length >= target) break;
    const overlaps = picked.some((p) => overlapFraction(p, c) > 0.4);
    if (!overlaps) picked.push(c);
  }
  return picked;
}

function overlapFraction(a: Candidate, b: Candidate): number {
  const os = Math.max(a.startTime, b.startTime);
  const oe = Math.min(a.endTime, b.endTime);
  const ov = Math.max(0, oe - os);
  const minLen = Math.min(a.endTime - a.startTime, b.endTime - b.startTime);
  return minLen > 0 ? ov / minLen : 0;
}

// ── Finalize ────────────────────────────────────────────────────────────────

function finalizeClip(
  c: Candidate & { score: number; scoreSignals?: string[] },
  index: number,
  input: ClipGenInput,
  resolvedType: SelectedVideoType,
  rule: LengthRule,
  now: number,
  fallback = false
): GeneratedClip {
  const snapped = snapToTranscript(c.startTime, c.endTime, input.analysis?.transcript, rule, input.duration);
  const startTime = snapped.start;
  const endTime = snapped.end;
  const duration = endTime - startTime;

  const snippet = transcriptSnippet(input.analysis?.transcript, startTime, endTime);
  const windowText = transcriptText(input.analysis?.transcript, startTime, endTime);
  // Text cues can promote the type (a CTA line makes it a CTA clip, a strong
  // take makes it an opinion clip) — deterministic keyword matching, no LLM.
  const clipType = refineTypeFromText(c.seedType, windowText);
  const meta = CLIP_TYPE_META[clipType];
  const signals = Array.from(new Set([...(c.scoreSignals ?? []), ...c.signals]));

  const aspect = ASPECT_BY_TYPE[resolvedType];
  const captionStyle = CAPTION_BY_TYPE[resolvedType];
  const hookText = buildHook(clipType, snippet);

  return {
    id: `clip_${Math.round(startTime * 1000)}_${index}`,
    title: buildTitle(clipType, snippet, startTime, endTime),
    reason: fallback
      ? buildFallbackReason(signals)
      : buildReason(clipType, signals, meta.blurb),
    startTime,
    endTime,
    duration,
    score: round2(c.score),
    clipType,
    ...(fallback ? { fallback: true as const } : {}),
    suggestedAspectRatio: aspect,
    suggestedCaptionStyle: captionStyle,
    suggestedHookText: hookText,
    editOperations: buildEditOperations(
      startTime,
      endTime,
      input,
      clipType,
      hookText,
      captionStyle,
      aspect
    ),
    exportStatus: "idle",
    signals,
    createdAt: now,
    updatedAt: now,
  };
}

/** Promote the seeded type when the spoken text clearly says otherwise. */
function refineTypeFromText(seed: ClipType, text: string): ClipType {
  if (!text) return seed;
  const t = text.toLowerCase();
  if (CTA_CUES.some((c) => t.includes(c))) return "call_to_action";
  if (OPINION_CUES.some((c) => t.includes(c))) return "strong_opinion";
  return seed;
}

function buildTitle(type: ClipType, snippet: string | null, s: number, e: number): string {
  const label = CLIP_TYPE_META[type].label;
  if (snippet) return `${label} — "${snippet}"`;
  return `${label} · ${fmt(s)}–${fmt(e)}`;
}

function buildReason(type: ClipType, signals: string[], blurb: string): string {
  const top = signals.slice(0, 2).join(" + ");
  return top ? `${blurb} ${capitalize(top)}.` : blurb;
}

/** A fallback clip says so plainly — it was never a strong standalone moment. */
function buildFallbackReason(signals: string[]): string {
  const top = signals.slice(0, 2).join(" + ");
  const base = "No strong standalone moment scored here, so Framevo built a fallback clip";
  return top ? `${base} from the ${top}.` : `${base}.`;
}

function buildHook(type: ClipType, snippet: string | null): string {
  if (snippet) return snippet;
  const fallbacks: Partial<Record<ClipType, string>> = {
    best_hook: "Don't scroll — watch this",
    result_reveal: "Here's the result",
    product_demo_moment: "Watch this in action",
    call_to_action: "Try it yourself",
    before_after: "Before vs after",
  };
  return fallbacks[type] ?? CLIP_TYPE_META[type].label;
}

/**
 * The clip's SMART EDITS — the ops that make it more than a time range. Each is
 * materialized into a real moment / canvas override by src/lib/clips/clip-edits.ts
 * (preview + export + "apply to timeline" all read these):
 *   trim         → the two synthetic range cuts
 *   smart-crop   → the output-canvas aspect override
 *   hook-text    → an opening hook line
 *   captions     → a caption-style override inside the window
 *   zoom         → an emphasis push on the window's attention peak
 *   branding-cta → a closing call to action
 */
function buildEditOperations(
  startTime: number,
  endTime: number,
  input: ClipGenInput,
  seedType: ClipType,
  hookText: string,
  captionStyle: OverlayTextPreset,
  aspect: ClipAspectRatio
): GeneratedClip["editOperations"] {
  const ops: GeneratedClip["editOperations"] = [
    { type: "trim", startTime, endTime },
    { type: "smart-crop", startTime, endTime, params: { aspect } },
  ];

  // Hook line over the opening beat (short — it's a hook, not a caption).
  if (hookText.trim()) {
    ops.push({
      type: "hook-text",
      startTime,
      endTime: Math.min(endTime, startTime + Math.min(3, (endTime - startTime) / 4)),
      params: { text: hookText },
    });
  }

  // Restyle the captions inside the window for the target platform. Only
  // meaningful when there IS speech to caption.
  const hasSpeech = (input.analysis?.transcript?.segments?.length ?? 0) > 0;
  const cats = input.analysis?.editRecipe?.enabledCategories ?? [];
  if (hasSpeech || cats.includes("captions")) {
    ops.push({
      type: "captions",
      startTime,
      endTime,
      params: { stylePreset: captionStyle },
    });
  }

  // Emphasis zoom on the window's strongest beat — only when we have a real
  // motion hotspot to aim at (never fabricate a region).
  const zoom = zoomOpForWindow(startTime, endTime, input);
  if (zoom) ops.push(zoom);

  // Closing CTA for CTA clips (or when the recipe wants branding).
  if (seedType === "call_to_action" || cats.includes("branding")) {
    const ctaStart = Math.max(startTime, endTime - 4);
    ops.push({
      type: "branding-cta",
      startTime: ctaStart,
      endTime,
      params: { text: "Try it yourself" },
    });
  }

  return ops;
}

/**
 * A zoom op aimed at the attention peak inside the window, using the CV motion
 * hotspot (centroid) as the focus region. Returns null when there's no attention
 * curve / centroid data, or when an existing zoom already covers the peak — we
 * never stack a synthetic zoom on top of a real one.
 */
function zoomOpForWindow(
  start: number,
  end: number,
  input: ClipGenInput
): GeneratedClip["editOperations"][number] | null {
  const va = input.visualAnalysis;
  if (!hasAttention(input.analysis) || !va?.centroidX || !va?.centroidY) return null;

  // Find the peak second inside the window.
  let peakT = start;
  let peak = -1;
  for (let t = start; t <= end; t += 1) {
    const a = getAttentionAt(input.analysis!, t);
    if (a > peak) {
      peak = a;
      peakT = t;
    }
  }
  if (peak < 0.55) return null; // not a strong enough beat to be worth a push

  // Don't double up on an existing zoom/focus at that beat.
  const existing = (input.analysis?.detectedMoments ?? []).some(
    (m) =>
      (m.effectType === "zoom" || m.effectType === "cursor-focus") &&
      m.startTime <= peakT &&
      m.endTime >= peakT
  );
  if (existing) return null;

  const rate = va.sampleRate || 1;
  const idx = Math.max(0, Math.min(va.centroidX.length - 1, Math.floor(peakT * rate)));
  const cx = dequantize(va.centroidX[idx]);
  const cy = dequantize(va.centroidY[idx]);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;

  const w = 0.55;
  const h = 0.55;
  const focusRegion = {
    x: clamp01(cx - w / 2),
    y: clamp01(cy - h / 2),
    width: w,
    height: h,
  };
  const zs = Math.max(start, peakT - 1);
  const ze = Math.min(end, peakT + 2.5);
  if (ze <= zs) return null;
  return {
    type: "zoom",
    startTime: zs,
    endTime: ze,
    params: { focusRegion, intensity: 0.8 },
  };
}

// ── Whole-video (very short) ────────────────────────────────────────────────

function buildWholeVideoClip(
  input: ClipGenInput,
  resolvedType: SelectedVideoType,
  now: number
): GeneratedClip {
  const { duration } = input;
  const snippet = transcriptSnippet(input.analysis?.transcript, 0, duration);
  return {
    id: `clip_full_0`,
    title: snippet ? `Edited clip — "${snippet}"` : "Edited version",
    reason:
      "This video is short enough to work as a single clip — Framevo prepared one edited version rather than splitting it.",
    startTime: 0,
    endTime: duration,
    duration,
    score: 1,
    clipType: "best_hook",
    suggestedAspectRatio: ASPECT_BY_TYPE[resolvedType],
    suggestedCaptionStyle: CAPTION_BY_TYPE[resolvedType],
    suggestedHookText: buildHook("best_hook", snippet),
    editOperations: [{ type: "trim", startTime: 0, endTime: duration }],
    exportStatus: "idle",
    signals: ["short video → one edited version"],
    createdAt: now,
  };
}

// ── Transcript helpers (avoid mid-sentence starts/ends) ─────────────────────

function snapToTranscript(
  start: number,
  end: number,
  transcript: Transcript | undefined | null,
  rule: LengthRule,
  duration: number
): { start: number; end: number } {
  const segs = transcript?.segments;
  if (!segs || segs.length === 0) return { start, end };

  // Begin at the start of the segment that contains (or is nearest before) `start`.
  let s = start;
  const startSeg = segs.find((g) => g.startTime <= start + 0.3 && g.endTime > start);
  if (startSeg) s = startSeg.startTime;
  else {
    const before = [...segs].reverse().find((g) => g.startTime <= start);
    if (before && start - before.startTime < 3) s = before.startTime;
  }

  // End at the end of the segment that contains (or is nearest after) `end`.
  let e = end;
  const endSeg = segs.find((g) => g.startTime < end && g.endTime >= end - 0.3);
  if (endSeg) e = endSeg.endTime;
  else {
    const after = segs.find((g) => g.endTime >= end);
    if (after && after.endTime - end < 3) e = after.endTime;
  }

  s = Math.max(0, s);
  e = Math.min(duration, e);
  // Don't let snapping balloon the clip well past its max.
  if (e - s > rule.max * 1.4) e = Math.min(e, s + rule.max);
  if (e <= s) return { start, end };
  return { start: s, end: e };
}

function transcriptSnippet(
  transcript: Transcript | undefined | null,
  start: number,
  end: number
): string | null {
  const segs = transcript?.segments;
  if (!segs || segs.length === 0) return null;
  const seg = segs.find((g) => g.endTime > start && g.startTime < end && g.text.trim());
  if (!seg) return null;
  const words = seg.text.trim().split(/\s+/).slice(0, 7).join(" ");
  return words.length > 60 ? words.slice(0, 57) + "…" : words;
}

// ── Signal utilities ────────────────────────────────────────────────────────

function hasAttention(analysis: ClipGenInput["analysis"]): boolean {
  return !!analysis?.attentionCurve && analysis.attentionCurve.length > 0;
}

function meanAttention(analysis: ClipGenInput["analysis"], s: number, e: number): number {
  if (!hasAttention(analysis)) return 0.5;
  const steps = Math.max(2, Math.round(e - s));
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t = s + ((e - s) * i) / (steps - 1);
    sum += getAttentionAt(analysis!, t);
  }
  return sum / steps;
}

function meanMotion(
  va: ClipGenInput["visualAnalysis"],
  s: number,
  e: number
): number | null {
  if (!va?.motion || va.motion.length === 0) return null;
  const rate = va.sampleRate || 1;
  const arr = dequantizeArray(va.motion);
  const i0 = Math.max(0, Math.floor(s * rate));
  const i1 = Math.min(arr.length - 1, Math.ceil(e * rate));
  if (i1 < i0) return null;
  let sum = 0;
  let n = 0;
  for (let i = i0; i <= i1; i++) {
    sum += arr[i];
    n++;
  }
  return n > 0 ? sum / n : null;
}

// ── Small utils ─────────────────────────────────────────────────────────────

function narrativeLabel(role: NarrativeRole): string {
  const map: Record<NarrativeRole, string> = {
    intro: "Intro",
    setup: "Setup",
    action: "Action",
    explanation: "Explanation",
    result: "Result",
    transition: "Transition",
    filler: "Quiet",
  };
  return map[role];
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Segment type re-export convenience (kept local to avoid a wider import). */
export type { NarrativeSegment };
