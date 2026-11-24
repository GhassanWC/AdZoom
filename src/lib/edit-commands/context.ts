/**
 * What the editing assistant knows when it handles a request: the brief, the
 * current selection, the playhead, the clips, the editable elements, and what
 * the last request changed. Built fresh from the LIVE timeline for every
 * request, so a manual edit made while the assistant was idle is never missed.
 *
 * Also resolves the references people actually use — "it", "that title", "the
 * selected clip", "the shot before this one" — to concrete ids. The same
 * resolver serves the local parser and (via the digest) the model.
 */

import type { DetectedMoment, ProjectDoc } from "@/lib/firebase/schema";
import { buildTimelineMap } from "@/lib/timeline/crop-speed";
import { visibleMoments, type LayerVisibility } from "@/lib/timeline/layers";
import { deriveClips, clipAtSource, outputAtSource, clipsFromSequence, type Clip } from "./clips";
import { outputDurationOf, outputTimeForSource } from "@/lib/timeline/evaluate";
import { describe, textOf } from "./apply";

export interface AssistantSelection {
  clipId?: string | null;
  elementId?: string | null;
}

export interface AssistantInput {
  project: Pick<ProjectDoc, "analysis" | "duration" | "directorBrief" | "selectedVideoType"> & Partial<Pick<ProjectDoc, "sequence" | "assets">>;
  moments: DetectedMoment[];
  layers: LayerVisibility;
  sourceDuration: number;
  playhead: number;
  selection: AssistantSelection;
  /** Element ids the previous assistant request touched, newest first. */
  recentElementIds: string[];
  /**
   * Footage steps already run for THIS request (transcribed, clicks searched,
   * pauses measured). A rule that needed one must not ask for it again — if the
   * data is still empty after preparing, the footage genuinely has none.
   */
  prepared?: import("./parse").FootageNeed[];
  /** Clicks known for this footage (see ClickMark). */
  clicks?: import("./types").ClickMark[];
}

export interface DigestElement {
  id: string;
  type: string;
  name: string;
  text?: string;
  start: number;
  end: number;
  enabled: boolean;
  /** "item:<id>" when start/end are seconds into that sequence item (a zoom/effect on a freeze); "sequence" for output seconds; absent = source seconds. */
  anchor?: string;
}

/** Compact, model-friendly snapshot of the editable state. */
export interface AssistantDigest {
  sourceDuration: number;
  outputDuration: number;
  playhead: { source: number; output: number; clipId: string | null };
  selection: { clip: Clip | null; element: DigestElement | null };
  brief: string | null;
  clips: Clip[];
  /** Graphics, titles, zooms, speed, cuts. Captions are summarized, not listed. */
  elements: DigestElement[];
  captions: { count: number; firstStart: number | null; lastEnd: number | null };
  transcript: { available: boolean; segments: number };
  recentlyChanged: DigestElement[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function digestElement(m: DetectedMoment): DigestElement {
  const text = textOf(m);
  return {
    id: m.id,
    type: m.preset?.id ?? m.effectType,
    name: describe(m),
    ...(text ? { text } : {}),
    start: r2(m.startTime),
    end: r2(m.endTime),
    enabled: m.enabled !== false,
    ...(m.anchor && m.anchor.kind !== "source" ? { anchor: m.anchor.kind === "item" ? `item:${m.anchor.itemId}` : "sequence" } : {}),
  };
}

export function buildAssistantDigest(input: AssistantInput): AssistantDigest {
  const visible = visibleMoments(input.moments, input.layers);
  const map = buildTimelineMap(visible, input.sourceDuration);
  const seqRev = input.project.sequence ? { sequence: input.project.sequence, moments: input.moments, assets: input.project.assets ?? [], sourceDuration: input.sourceDuration } : null;
  const clips = seqRev ? clipsFromSequence(seqRev) : deriveClips(visible, input.sourceDuration, map);
  const byId = new Map(input.moments.map((m) => [m.id, m]));
  const captions = input.moments.filter((m) => m.effectType === "captions");
  const selEl = input.selection.elementId ? byId.get(input.selection.elementId) : undefined;
  const transcript = input.project.analysis?.transcript;
  return {
    sourceDuration: r2(input.sourceDuration),
    outputDuration: r2(seqRev ? outputDurationOf(seqRev) : map.outputDuration),
    playhead: {
      source: r2(input.playhead),
      output: r2(seqRev ? outputTimeForSource(seqRev, "source", input.playhead) ?? 0 : outputAtSource(map, input.playhead)),
      clipId: (seqRev ? clips.find((c) => c.assetId === "source" && input.playhead >= c.sourceStart && input.playhead < c.sourceEnd) : clipAtSource(clips, input.playhead))?.id ?? null,
    },
    selection: {
      clip: clips.find((c) => c.id === input.selection.clipId) ?? null,
      element: selEl ? digestElement(selEl) : null,
    },
    brief: input.project.directorBrief?.prompt?.trim() || null,
    clips,
    elements: input.moments.filter((m) => m.effectType !== "captions").slice(0, 200).map(digestElement),
    captions: {
      count: captions.length,
      firstStart: captions.length ? r2(Math.min(...captions.map((c) => c.startTime))) : null,
      lastEnd: captions.length ? r2(Math.max(...captions.map((c) => c.endTime))) : null,
    },
    transcript: {
      available: transcript?.status === "complete" && (transcript.segments?.length ?? 0) > 0,
      segments: transcript?.segments?.length ?? 0,
    },
    recentlyChanged: input.recentElementIds.map((id) => byId.get(id)).filter((m): m is DetectedMoment => !!m).map(digestElement),
  };
}

// ── Reference resolution ────────────────────────────────────────────────────

const GRAPHIC_WORDS = /\b(title|lower[ -]?third|graphic|text|caption|name ?(bar|tag)|label|overlay|banner|it|that|this one)\b/i;

/**
 * Resolve an element reference. Order: an explicit kind word narrows the
 * search ("the title" → text graphics); then the element the last request
 * changed, then the selected element, then — if exactly one of that kind
 * exists — that one. Returns null when it's genuinely ambiguous.
 */
export function resolveElementRef(phrase: string, input: AssistantInput): DetectedMoment | null {
  const p = phrase.toLowerCase();
  const byId = new Map(input.moments.map((m) => [m.id, m]));
  const wantsGraphic = /title|lower[ -]?third|graphic|name ?(bar|tag)|banner|overlay|text|label|price|line|accent/.test(p);
  // "move" alone is a verb for any element ("move the title"); only "camera
  // move" / "push-in" / "pull-out" name the camera.
  const wantsZoom = /\bzoom|\bpush[- ]?in|\bcamera|\bpull[- ]?out/.test(p);
  const matches = (m: DetectedMoment) =>
    wantsGraphic
      ? ["text-overlay", "hook-text", "callout", "branding-cta", "graphic"].includes(m.effectType)
      : wantsZoom
        ? m.effectType === "zoom" || m.effectType === "cursor-focus"
        : true;

  // Ordinals name a specific one: "the second zoom", "the last title".
  const ord = /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)\b/.exec(p);
  if (ord && (wantsGraphic || wantsZoom)) {
    const all = input.moments.filter(matches).sort((a, b) => a.startTime - b.startTime);
    const idx: Record<string, number> = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4 };
    return (ord[1] === "last" || ord[1] === "final" ? all[all.length - 1] : all[idx[ord[1]]]) ?? null;
  }

  for (const id of input.recentElementIds) {
    const m = byId.get(id);
    if (m && matches(m) && m.effectType !== "cut") return m;
  }
  const sel = input.selection.elementId ? byId.get(input.selection.elementId) : undefined;
  if (sel && matches(sel)) return sel;
  if (wantsGraphic || wantsZoom) {
    const all = input.moments.filter(matches);
    if (all.length === 1) return all[0];
    // Several: the one paired in time with what was just worked on ("keep the
    // price visible" on a move, then "remove the line" means that dish's label),
    // else the one under the playhead.
    for (const id of input.recentElementIds) {
      const r = byId.get(id);
      if (!r) continue;
      const paired = all.filter((m) => m.id !== r.id && m.startTime < r.endTime && m.endTime > r.startTime);
      if (paired.length === 1) return paired[0];
    }
    const here = all.filter((m) => input.playhead >= m.startTime && input.playhead < m.endTime);
    if (here.length === 1) return here[0];
  }
  return null;
}

export function mentionsElement(phrase: string): boolean {
  return GRAPHIC_WORDS.test(phrase);
}

/**
 * Resolve a clip reference: "the selected clip", "this clip/shot", "clip 3",
 * "the first/last clip", "the shot before/after this one". Relative references
 * count from the selected clip, else the clip under the playhead.
 */
export function resolveClipRef(phrase: string, input: AssistantInput): Clip | null {
  const visible = visibleMoments(input.moments, input.layers);
  const clips = deriveClips(visible, input.sourceDuration);
  if (clips.length === 0) return null;
  const p = phrase.toLowerCase();
  const anchor =
    clips.find((c) => c.id === input.selection.clipId) ?? clipAtSource(clips, input.playhead) ?? null;

  const num = /\b(?:clip|shot)\s*#?(\d+)\b/.exec(p);
  if (num) return clips[Number(num[1]) - 1] ?? null;
  if (/\b(first|opening)\s+(clip|shot)\b/.test(p) || /\bof the video\b/.test(p) && /\bfirst\b|\bstart\b|\bbeginning\b/.test(p)) return clips[0];
  if (/\b(last|final|closing)\s+(clip|shot)\b/.test(p)) return clips[clips.length - 1];
  if (/\b(before|previous|prior)\b/.test(p)) return anchor ? clips[anchor.index - 2] ?? null : null;
  if (/\b(after|next|following)\b/.test(p)) return anchor ? clips[anchor.index] ?? null : null;
  return anchor;
}
