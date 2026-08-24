/**
 * AI Director — the words people actually type.
 *
 * The revision parser used to recognise four edit types by their exact plural
 * noun and nothing else, so a message like "please reomve focus and cuts and
 * zooms" failed three times over: a transposed letter, an edit type that had no
 * word at all, and a phrasing ("remove X") that only ever meant "fewer X" when
 * it was spelled "remove some X". The user's video has twelve kinds of edit on
 * it; the chat could only hear four of them.
 *
 * This module is the vocabulary layer that fixes that. It does three jobs, all
 * of them pure and deterministic:
 *
 *   1. `normalizeCommand` — repairs typos against a fixed lexicon of the words
 *      the parser cares about. Damerau-Levenshtein, so the single commonest typo
 *      class (a transposition: "reomve", "captoins", "zoosm") costs 1 and is
 *      caught. Words that aren't near-misses are left alone, which is what keeps
 *      "make it more banana flavoured" honestly unrecognised.
 *
 *   2. `findEditTargets` — scans for EVERY Director edit type by every name a
 *      person plausibly uses for it, in ONE left-to-right pass so that "whip cut"
 *      is a transition rather than a transition and a cut.
 *
 *   3. per-target direction — "fewer zooms and more callouts" is two different
 *      instructions in one sentence, so direction is read from the words leading
 *      up to each mention and only falls back to the sentence as a whole.
 *
 * Nothing here decides what to DO. It turns free text into targets and
 * directions; `revision.ts` decides whether that's a change it can make, and
 * `validate.ts` still guards everything downstream. Widening what the chat can
 * HEAR never widens what it can DO.
 */
import type { DirectorEditType } from "./types";

// ════════════════════════════════════════════════════════════════════════════
// 1. Typo repair
// ════════════════════════════════════════════════════════════════════════════

/**
 * Every word the parser looks for, in the spelling it looks for.
 *
 * A word must be in here to be a correction TARGET — the normalizer only ever
 * moves a typo toward a word the parser already understands, so it can't invent
 * a meaning that wasn't in the lexicon to begin with.
 */
const LEXICON: readonly string[] = [
  // verbs of change
  "remove", "delete", "drop", "keep", "make", "change", "switch", "convert",
  "turn", "add", "increase", "reduce", "restore", "disable", "enable", "undo",
  "tighten", "loosen", "shorten", "lengthen", "include", "exclude", "eliminate",
  // quantities
  "fewer", "less", "more", "many", "some", "none", "every", "everything",
  "nothing", "another", "extra", "additional",
  // edit types and their aliases
  "zoom", "zooms", "callout", "callouts", "transition", "transitions",
  "overlay", "overlays", "label", "labels", "caption", "captions",
  "subtitle", "subtitles", "highlight", "highlights", "focus", "spotlight",
  "cursor", "click", "clicks", "speed", "hook", "title", "titles", "text",
  "crop", "reframe", "framing", "cut", "cuts", "trim", "silence", "silences",
  "pause", "pauses", "effect", "effects", "arrow", "arrows", "annotation",
  "annotations", "fade", "fades", "crossfade", "dissolve",
  // shape
  "vertical", "portrait", "horizontal", "landscape", "square", "aspect",
  "ratio", "canvas",
  // length
  "second", "seconds", "minute", "minutes", "duration", "length",
  // pacing
  "faster", "slower", "quicker", "snappier", "punchier", "punchy", "calmer",
  // structure
  "beginning", "start", "opening", "intro", "ending", "outro", "section",
  "sections", "clip", "clips", "context", "demo", "result", "middle", "body",
  // styles
  "professional", "corporate", "business", "formal", "energetic", "bold",
  "minimal", "subtle", "simple", "cinematic", "dramatic", "calm", "relaxed",
  "gentle", "clean",
  // cta
  "cta", "action", "stronger", "better", "without",
];

const LEXICON_SET: ReadonlySet<string> = new Set(LEXICON);

/**
 * Damerau-Levenshtein (optimal string alignment).
 *
 * Plain Levenshtein charges 2 for a transposition, which is exactly the typo
 * people make most ("reomve", "teh", "captoins") — so it would score the most
 * correctable mistake as the least correctable one. `bail` stops the moment the
 * distance can no longer come in under the threshold.
 */
function editDistance(a: string, b: string, bail: number): number {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > bail) return bail + 1;

  // Two rolling rows plus the row before them (needed for transpositions).
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: bl + 1 }, (_, j) => j);
  let cur: number[] = new Array<number>(bl + 1);

  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        prev[j] + 1, // deletion
        cur[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1); // transposition
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > bail) return bail + 1;
    prev2 = prev;
    prev = cur;
    cur = new Array<number>(bl + 1);
  }
  return prev[bl];
}

/**
 * How wrong a word may be before we stop guessing.
 *
 * Short words get NO correction: at four letters almost everything is within one
 * edit of something, and "cut" → "cta" would be a silent rewrite of the user's
 * video. The tolerance only opens up once a word is long enough that a
 * near-match is real evidence rather than a coincidence.
 */
function toleranceFor(len: number): number {
  if (len <= 4) return 0;
  if (len <= 6) return 1;
  return 2;
}

/** Crude stemmer — enough to tell "zoom" and "zooms" apart from "zoom" and "boom". */
function stem(word: string): string {
  return word.replace(/(?:ies|es|ing|ed|s)$/, "");
}

/**
 * Repair typos in a command, leaving everything else exactly as typed.
 *
 * A word is only corrected when the closest lexicon words all MEAN the same
 * thing. "zoosm" is one edit from both "zooms" and "zoom" — a tie on spelling,
 * but not on meaning, and refusing to correct it would fail the user over a
 * distinction the parser doesn't even make. A tie between genuinely different
 * words still blocks: guessing between two meanings is the failure mode this
 * whole module exists to avoid.
 */
export function normalizeCommand(command: string): string {
  return (command ?? "").replace(/[a-z']+/gi, (word) => {
    const lower = word.toLowerCase();
    if (LEXICON_SET.has(lower)) return word;

    const bail = toleranceFor(lower.length);
    if (bail === 0) return word;

    let bestD = bail + 1;
    let best: string[] = [];
    for (const candidate of LEXICON) {
      const d = editDistance(lower, candidate, bail);
      if (d > bail) continue;
      if (d < bestD) {
        bestD = d;
        best = [candidate];
      } else if (d === bestD) {
        best.push(candidate);
      }
    }
    if (!best.length) return word;

    // Ambiguous only when the near-misses disagree about what they mean.
    const stems = new Set(best.map(stem));
    if (stems.size > 1) return word;

    // Among variants of one stem, take the longest — "zoomz" is far more likely
    // to be "zooms" than "zoom", and both parse to the same edit type anyway.
    return best.reduce((a, b) => (b.length > a.length ? b : a));
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Edit targets
// ════════════════════════════════════════════════════════════════════════════

/**
 * What a revision command can be ABOUT.
 *
 * Every member is a real `DirectorEditType`, so a target that parses is always a
 * target the executor already knows how to act on. There is no target here that
 * maps to nothing. "Remove everything" is deliberately NOT a member — it is not
 * a statement about an edit type, and it is recognised by `isResetCommand`.
 */
export type EditTarget = DirectorEditType;

/** "fewer" / "more" / "none" — and `undefined` when the user only named a thing. */
export type EditDirection = "fewer" | "more" | "none";

interface TargetPattern {
  type: EditTarget;
  source: string;
  /**
   * True for words that are also verbs taking the video as their object —
   * "cut it to 30 seconds" is a duration, not an instruction about cuts. These
   * only count as targets when they read as nouns (plural, or after a
   * determiner), which is what stops "crop it to vertical" from being heard as
   * "delete the crop".
   */
  nounOnly?: boolean;
}

/**
 * Ordered specific → general and matched in ONE pass, so a longer name consumes
 * the shorter one inside it: "whip cut" is a transition and does not also leave
 * a stray "cut" behind for the cut rule to find.
 */
const TARGET_PATTERNS: readonly TargetPattern[] = [
  { type: "transition", source: String.raw`(?:whip|smooth|hard|soft|quick)[-\s]?cuts?` },
  { type: "click-highlight", source: String.raw`click[-\s]?(?:highlights?|effects?|rings?|pulses?|indicators?)` },
  { type: "cursor-focus", source: String.raw`(?:cursor|mouse)[-\s]?(?:focus(?:es)?|tracking|follows?|highlights?)` },
  { type: "text-overlay", source: String.raw`text[-\s]?overlays?` },
  { type: "hook-text", source: String.raw`hooks?(?:[-\s]?texts?)?` },
  { type: "branding-cta", source: String.raw`(?:ctas?|calls?[-\s]?to[-\s]?actions?|end[-\s]?cards?|outro[-\s]?cards?)` },
  { type: "smart-crop", source: String.raw`(?:smart[-\s]?crops?|reframing|reframes?|framing)` },
  { type: "captions", source: String.raw`(?:captions?|subtitles?|subs)` },
  { type: "speed-up", source: String.raw`(?:speed[-\s]?ups?|fast[-\s]?forwards?|time[-\s]?lapses?|speed[-\s]?ramps?)` },
  { type: "zoom", source: String.raw`(?:zoom[-\s]?ins?|zoom(?:s|ing|ed)?|punch[-\s]?ins?)` },
  { type: "cursor-focus", source: String.raw`(?:focus(?:es|ing|ed)?|spotlights?)` },
  { type: "click-highlight", source: String.raw`highlights?` },
  { type: "callout", source: String.raw`(?:call[-\s]?outs?|annotations?|arrows?)` },
  { type: "transition", source: String.raw`(?:transitions?|crossfades?|dissolves?)` },
  { type: "transition", source: String.raw`fades?`, nounOnly: true },
  { type: "text-overlay", source: String.raw`(?:labels?|titles?|text)` },
  { type: "smart-crop", source: String.raw`crops?`, nounOnly: true },
  { type: "cut", source: String.raw`(?:jump[-\s]?cuts?|dead[-\s]?air|silences?|pauses?)` },
  { type: "cut", source: String.raw`(?:cuts?|cutting|trims?)`, nounOnly: true },
];

/** One combined scanner. Group N+1 is `TARGET_PATTERNS[N]`. */
const TARGET_SCANNER = new RegExp(
  TARGET_PATTERNS.map((p) => `\\b(${p.source})\\b`).join("|"),
  "gi"
);

/** Words that make a verb-shaped noun read as a noun. */
const DETERMINER =
  /\b(?:the|a|an|all|any|every|some|those|these|more|fewer|less|no|its|my|your|first|last|extra|additional|another|both)\s*$/i;

export interface TargetMention {
  type: EditTarget;
  direction?: EditDirection;
  /** Character offset in the normalized command — used to slice lead-ins. */
  at: number;
}

const NO_MORE = /\bno\s+more\b/i;

/**
 * "Too choppy" is a complaint, and a complaint about an edit type is a request
 * for fewer of them. Reading only the literal quantifiers ("fewer", "less")
 * meant the most natural way to ask — describing what's wrong with the result —
 * was the one phrasing that didn't work.
 */
const FEWER_RE =
  /\b(?:fewer|less|reduce|reducing|reduced|cut\s+down|cut\s+back|tone\s+down|toned\s+down|dial\s+back|dial\s+down|soften|ease\s+up|lighten|minimi[sz]e|trim\s+down|some\s+of|a\s+few\s+less|too\s+(?:many|much|choppy|jarring|abrupt|harsh|jumpy|busy|aggressive|distracting|intense)|choppy|jarring|jumpy|overdone|excessive|distracting)\b/i;

const MORE_RE =
  /\b(?:more|add|adding|increase|increasing|too\s+few|extra|additional|another|boost|punch\s+up|amp\s+up|dial\s+up|maximi[sz]e|include)\b/i;

const NONE_RE =
  /\b(?:remove|removing|removed|delete|deleting|deleted|drop|dropping|dropped|get\s+rid\s+of|rid\s+of|no|not|without|none|zero|kill|take\s+out|taking\s+out|turn\s+off|turning\s+off|switch\s+off|disable|disabling|lose|stop|skip|ditch|clear|strip|scrap|eliminate|eliminating|cancel|off|don'?t\s+want|do\s+not\s+want|hate|dislike)\b/i;

/**
 * Read a direction out of a fragment.
 *
 * Order matters and is not arbitrary: "remove some zooms" is a REDUCTION, not a
 * deletion, so an explicit quantifier has to beat the removal verb it sits
 * beside. "no more zooms" is the one phrase where "more" means the opposite of
 * more, so it is settled before anything else looks at it.
 */
function directionIn(fragment: string): EditDirection | undefined {
  if (!fragment.trim()) return undefined;
  if (NO_MORE.test(fragment)) return "none";
  if (FEWER_RE.test(fragment)) return "fewer";
  if (MORE_RE.test(fragment)) return "more";
  if (NONE_RE.test(fragment)) return "none";
  return undefined;
}

/**
 * Every edit type the command mentions, each with the direction that applies to
 * IT rather than to the sentence.
 *
 * The lead-in for a mention is the text since the previous mention, so
 * "fewer zooms and more callouts" reads as two opposite instructions and
 * "remove focus and cuts and zooms" reads as three copies of one — the
 * conjunction carries the verb forward, which is how people actually write.
 */
export function findEditTargets(command: string): TargetMention[] {
  const text = command ?? "";
  const sentenceDirection = directionIn(text);
  const mentions: TargetMention[] = [];

  TARGET_SCANNER.lastIndex = 0;
  let m: RegExpExecArray | null;
  let cursor = 0;

  while ((m = TARGET_SCANNER.exec(text)) !== null) {
    // Zero-width safety: a pattern that somehow matched nothing would loop.
    if (m[0].length === 0) {
      TARGET_SCANNER.lastIndex += 1;
      continue;
    }

    const groupIndex = m.slice(1).findIndex((g) => g !== undefined);
    if (groupIndex < 0) continue;
    const pattern = TARGET_PATTERNS[groupIndex];

    // A verb-shaped word needs a determiner, or a plural, to be a noun.
    if (pattern.nounOnly) {
      const matched = m[0].toLowerCase();
      const plural = /(?:s|ing)$/.test(matched);
      if (!plural && !DETERMINER.test(text.slice(0, m.index))) {
        cursor = m.index + m[0].length;
        continue;
      }
    }

    const leadIn = text.slice(cursor, m.index);
    mentions.push({
      type: pattern.type,
      direction: directionIn(leadIn) ?? sentenceDirection,
      at: m.index,
    });
    cursor = m.index + m[0].length;
  }

  // De-duplicate: "no zooms, none of the zooms" is one instruction. The FIRST
  // mention wins, because that is where the user stated the direction.
  const seen = new Set<EditTarget>();
  return mentions.filter((t) => (seen.has(t.type) ? false : (seen.add(t.type), true)));
}

/**
 * "Start over" / "remove all the edits" / "just the plain video".
 *
 * Recognised separately from the target scanner because it isn't a statement
 * about one edit type — it's a request to undo the direction entirely, and it
 * has to beat every other reading of the sentence.
 */
export function isResetCommand(command: string): boolean {
  const s = (command ?? "").toLowerCase();
  if (/\b(?:start\s+over|start\s+again|reset|from\s+scratch|revert|original\s+video|plain\s+video|raw\s+video|as\s+it\s+was)\b/.test(s)) {
    return true;
  }
  // "remove everything" / "no effects at all" / "get rid of all the edits"
  return (
    /\b(?:remove|delete|drop|clear|get\s+rid\s+of|no|without|undo|strip)\b/.test(s) &&
    /\b(?:everything|all\s+(?:the\s+|your\s+|these\s+)?(?:edits?|effects?|changes?)|every\s+edit|any\s+edits?|the\s+edits)\b/.test(s)
  );
}
