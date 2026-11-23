/**
 * Footage understanding for the editing assistant — find moments by what is
 * SAID (word-timed transcript) or what HAPPENS (stored analysis labels, story
 * structure), across the whole source.
 *
 * Everything here is keyed by SOURCE time, the coordinate system that survives
 * edits: cutting clip 2 never moves what was said at 01:14 in the upload. That
 * is what lets analysis be reused across every revision instead of re-run.
 *
 * Pure and deterministic — used by the local command parser in the browser and
 * by the model tool loop on the server, so both find the same moments.
 */

import type { DetectedMoment, ProjectDoc, Transcript, TranscriptSegment } from "@/lib/firebase/schema";

export interface FootageMatch {
  start: number;
  end: number;
  kind: "speech" | "visual" | "story";
  text: string;
  /** 0..1, higher is better. */
  score: number;
}

const STOP = new Set(
  "a an the and or but of to in on at for with is are was were be been it this that these those i you he she we they my your our their me him her us them so just very really".split(" ")
);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/'s$/, "").replace(/(ing|ed|es|s)$/, (m, _g, off, str) => (str.length - m.length >= 3 ? "" : m)))
    .filter((w) => w && !STOP.has(w));
}

function overlapScore(query: string[], text: string[]): number {
  if (query.length === 0 || text.length === 0) return 0;
  const set = new Set(text);
  let hit = 0;
  for (const q of query) if (set.has(q)) hit += 1;
  return hit / query.length;
}

function segmentsOf(t: Transcript | null | undefined): TranscriptSegment[] {
  return t?.status === "complete" && t.segments ? t.segments : [];
}

/** Search speech + visual labels + story structure for `query`. Best first. */
export function findFootage(
  project: Pick<ProjectDoc, "analysis">,
  query: string,
  opts: { kind?: "speech" | "visual" | "any"; limit?: number } = {}
): FootageMatch[] {
  const q = tokens(query);
  const kind = opts.kind ?? "any";
  const out: FootageMatch[] = [];

  if (kind !== "visual") {
    for (const s of segmentsOf(project.analysis?.transcript)) {
      const score = overlapScore(q, tokens(s.text));
      const phrase = s.text.toLowerCase().includes(query.toLowerCase().trim()) ? 0.3 : 0;
      if (score + phrase > 0.34) out.push({ start: s.startTime, end: s.endTime, kind: "speech", text: s.text, score: Math.min(1, score + phrase) });
    }
  }
  if (kind !== "speech") {
    const moments: DetectedMoment[] = project.analysis?.detectedMoments ?? [];
    for (const m of moments) {
      if (m.effectType === "captions") continue;
      const score = overlapScore(q, tokens(`${m.label} ${m.reason}`));
      if (score > 0.34) out.push({ start: m.startTime, end: m.endTime, kind: "visual", text: m.label, score: score * 0.9 });
    }
    for (const n of project.analysis?.narrativeStructure ?? []) {
      const score = overlapScore(q, tokens(`${n.label} ${n.role}`));
      if (score > 0.34) out.push({ start: n.startTime, end: n.endTime, kind: "story", text: `${n.role}: ${n.label}`, score: score * 0.85 });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.start - b.start).slice(0, opts.limit ?? 8);
}

// ── Introductions ───────────────────────────────────────────────────────────

export interface Introduction {
  /** Source time the introduction starts (the first word of the phrase). */
  start: number;
  end: number;
  /** The introduced name when it can be read off the words, e.g. "Sarah Chen". */
  name: string | null;
  /** Role/title if said right after ("…, head of design"). */
  role: string | null;
  text: string;
}

const INTRO_RE =
  /\b(?:[Mm]y name is|[Mm]y name's|[Ii] am|[Ii]['’]m|[Tt]his is|[Cc]all me)\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?)(?:[,.]?\s+(?:and\s+)?(?:i'm|i am)?\s*(?:the\s+|a\s+|an\s+)?([\p{L}' -]{3,40}?))?(?:[.,!?]|$)/u;

/**
 * Where a speaker introduces themselves ("Hi, I'm Sarah Chen, head of design").
 * Needs capitalised names, which Google STT produces with automatic punctuation.
 */
export function findIntroductions(transcript: Transcript | null | undefined): Introduction[] {
  const out: Introduction[] = [];
  for (const s of segmentsOf(transcript)) {
    const m = INTRO_RE.exec(s.text);
    if (!m) continue;
    const name = m[1]?.trim() ?? null;
    // "I'm Going" / "I'm Not" — reject common capitalised non-names.
    if (name && /^(Going|Not|So|Just|Really|Here|Gonna|Sure|Very|The)\b/.test(name)) continue;
    const role = m[2]?.trim().replace(/\s+(and|so|but)$/i, "") || null;
    const startWord = wordNear(transcript, s, m.index);
    out.push({ start: startWord ?? s.startTime, end: s.endTime, name, role, text: s.text });
  }
  return out;
}

/** Best-effort source time of the character offset `charIndex` in a segment. */
function wordNear(t: Transcript | null | undefined, s: TranscriptSegment, charIndex: number): number | null {
  const words = (t?.words ?? []).filter((w) => w.startTime >= s.startTime - 0.05 && w.endTime <= s.endTime + 0.05);
  if (words.length === 0) return null;
  const before = s.text.slice(0, charIndex).trim().split(/\s+/).filter(Boolean).length;
  return words[Math.min(words.length - 1, before)]?.startTime ?? null;
}

// ── Repeated takes ──────────────────────────────────────────────────────────

export interface RepeatedTake {
  /** The earlier, usually discarded attempt. */
  first: { start: number; end: number; text: string };
  /** The later attempt — the one an editor keeps by default. */
  second: { start: number; end: number; text: string };
  similarity: number;
}

function shingles(ws: string[], n = 2): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(" "));
  if (ws.length < n && ws.length) out.add(ws.join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Answers the speaker gave twice. Compares every segment (and adjacent-segment
 * pair, since a take can span a line break) against what follows it within
 * `windowSeconds`. Interviews and talking-head recordings are full of these.
 */
export function findRepeatedTakes(
  transcript: Transcript | null | undefined,
  opts: { windowSeconds?: number; minSimilarity?: number; minWords?: number } = {}
): RepeatedTake[] {
  const segs = segmentsOf(transcript);
  const windowS = opts.windowSeconds ?? 120;
  const minSim = opts.minSimilarity ?? 0.45;
  const minWords = opts.minWords ?? 5;

  // Candidate units: single segments and adjacent pairs.
  const units: { start: number; end: number; text: string; idx: number; span: number }[] = [];
  segs.forEach((s, i) => {
    units.push({ start: s.startTime, end: s.endTime, text: s.text, idx: i, span: 1 });
    const n = segs[i + 1];
    if (n) units.push({ start: s.startTime, end: n.endTime, text: `${s.text} ${n.text}`, idx: i, span: 2 });
  });
  const sh = units.map((u) => shingles(tokens(u.text)));

  const found: RepeatedTake[] = [];
  for (let a = 0; a < units.length; a++) {
    if (tokens(units[a].text).length < minWords) continue;
    for (let b = a + 1; b < units.length; b++) {
      const ua = units[a];
      const ub = units[b];
      if (ub.idx < ua.idx + ua.span) continue; // overlapping units
      if (ub.start - ua.end > windowS) break;
      const sim = jaccard(sh[a], sh[b]);
      if (sim >= minSim) found.push({ first: { start: ua.start, end: ua.end, text: ua.text }, second: { start: ub.start, end: ub.end, text: ub.text }, similarity: Math.round(sim * 100) / 100 });
    }
  }
  // Keep the strongest, non-overlapping pairs.
  found.sort((x, y) => y.similarity - x.similarity);
  const kept: RepeatedTake[] = [];
  for (const f of found) {
    if (kept.some((k) => f.first.start < k.second.end && f.second.end > k.first.start)) continue;
    kept.push(f);
  }
  return kept.sort((x, y) => x.first.start - y.first.start);
}

/**
 * The exact span to remove for a discarded take, snapped to word boundaries so
 * the cut lands in the gap between words — the join then sounds continuous.
 */
export function takeCutRange(
  transcript: Transcript | null | undefined,
  take: { start: number; end: number },
  nextStart: number
): { start: number; end: number } {
  const words = transcript?.words ?? [];
  const inTake = words.filter((w) => w.startTime >= take.start - 0.05 && w.endTime <= take.end + 0.05);
  const first = inTake[0]?.startTime ?? take.start;
  // Remove the false start AND the restart pause after it, ending a short
  // breath before the kept take's first word — never mid-word — so the join
  // sounds like one continuous answer.
  const lastEnd = inTake[inTake.length - 1]?.endTime ?? take.end;
  const BREATH = 0.25;
  const end = Math.max(first + 0.1, lastEnd, nextStart - BREATH);
  const prevWord = [...words].reverse().find((w) => w.endTime <= first + 1e-3);
  const start = prevWord ? Math.max(prevWord.endTime, first - 0.15) : Math.max(0, first - 0.15);
  return { start: Math.round(start * 1000) / 1000, end: Math.round(Math.min(end, nextStart) * 1000) / 1000 };
}
