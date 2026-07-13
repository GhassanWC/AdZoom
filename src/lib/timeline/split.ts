/**
 * Splitting an edit at a point in time.
 *
 * Pure + framework-neutral, so the timeline UI, the context mutators and the
 * tests all share ONE implementation. Splitting is the one timeline operation
 * that has to understand what an edit *contains*, not just when it runs:
 *
 *   • KEYFRAMES are stored as `t: 0..1` RELATIVE to the moment. Naively copying
 *     them into both halves would silently re-time every camera move — a 4s zoom
 *     split at 2s would replay its whole keyframe path twice, at double speed.
 *     They have to be partitioned by absolute time and re-normalized into each
 *     half's new span.
 *
 *   • CAPTIONS carry real word timings from the ASR. A caption line split by a
 *     cut must keep the words that were actually spoken on each side — moving a
 *     word to the wrong half would put text on screen while a different word is
 *     being said.
 *
 * Everything else (cut/speed/overlay settings) is shared configuration and is
 * copied to both halves verbatim.
 */
import type {
  CaptionWord,
  DetectedMoment,
  MomentKeyframe,
} from "../firebase/schema";

/**
 * Both halves must be at least this long. Below ~0.3s an edit is shorter than
 * the transitions that render it, so it reads as a flicker rather than a shot.
 * Matches MIN_MOMENT_LEN in the timeline constants.
 */
export const MIN_SPLIT_LEN = 0.3;

/** Why a split can't happen. `null` from `splitReason` means it can. */
export type SplitBlockedReason =
  | "outside"
  | "left-too-short"
  | "right-too-short";

/**
 * Can this moment be split at `at` (absolute source seconds)?
 * Returns the reason it can't, or `null` when it can.
 */
export function splitReason(
  m: Pick<DetectedMoment, "startTime" | "endTime">,
  at: number
): SplitBlockedReason | null {
  if (!Number.isFinite(at)) return "outside";
  if (at <= m.startTime || at >= m.endTime) return "outside";
  if (at - m.startTime < MIN_SPLIT_LEN) return "left-too-short";
  if (m.endTime - at < MIN_SPLIT_LEN) return "right-too-short";
  return null;
}

export function canSplit(
  m: Pick<DetectedMoment, "startTime" | "endTime">,
  at: number
): boolean {
  return splitReason(m, at) === null;
}

/** Human-readable explanation for a blocked split. */
export function splitBlockedMessage(reason: SplitBlockedReason): string {
  switch (reason) {
    case "outside":
      return "Move the playhead inside the edit to split it.";
    case "left-too-short":
    case "right-too-short":
      return `Both halves must be at least ${MIN_SPLIT_LEN}s — move the playhead further in.`;
  }
}

function round(v: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

/**
 * Partition keyframes into the two halves, re-normalizing `t` into each half's
 * own 0..1 span.
 *
 * A keyframe sitting exactly on the split point belongs to BOTH halves — it is
 * the shared boundary state, and dropping it from either side would make the
 * camera jump at the cut.
 */
function splitKeyframes(
  keyframes: MomentKeyframe[] | undefined,
  start: number,
  end: number,
  at: number
): { left?: MomentKeyframe[]; right?: MomentKeyframe[] } {
  if (!keyframes?.length) return {};
  const span = end - start;
  if (span <= 0) return {};

  const leftSpan = at - start;
  const rightSpan = end - at;
  const left: MomentKeyframe[] = [];
  const right: MomentKeyframe[] = [];

  for (const k of keyframes) {
    const abs = start + clamp01(k.t) * span;
    if (abs <= at && leftSpan > 0) {
      left.push({ ...k, t: clamp01((abs - start) / leftSpan) });
    }
    if (abs >= at && rightSpan > 0) {
      right.push({ ...k, t: clamp01((abs - at) / rightSpan) });
    }
  }

  return {
    ...(left.length ? { left: left.sort((a, b) => a.t - b.t) } : {}),
    ...(right.length ? { right: right.sort((a, b) => a.t - b.t) } : {}),
  };
}

/**
 * Partition a caption's words at `at`.
 *
 * With real word timings we partition EXACTLY: a word belongs to the half its
 * midpoint falls in, so a word straddling the split isn't torn in two or
 * duplicated. Without word timings (older transcripts, manual captions) we fall
 * back to a proportional split by word count — an approximation, but the caption
 * text stays editable and the alternative (refusing to split, or leaving both
 * halves with the full line) is worse.
 */
function splitCaptionWords(
  words: CaptionWord[] | undefined,
  text: string,
  start: number,
  end: number,
  at: number
): {
  left: { text: string; words?: CaptionWord[] };
  right: { text: string; words?: CaptionWord[] };
} {
  if (words?.length) {
    const l: CaptionWord[] = [];
    const r: CaptionWord[] = [];
    for (const w of words) {
      const mid = (w.start + w.end) / 2;
      (mid < at ? l : r).push(w);
    }
    return {
      left: {
        text: l.map((w) => w.text).join(" ").trim() || text,
        ...(l.length ? { words: l } : {}),
      },
      right: {
        text: r.map((w) => w.text).join(" ").trim() || text,
        ...(r.length ? { words: r } : {}),
      },
    };
  }

  // No word timings — split the tokens proportionally to where the cut lands.
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const span = end - start;
  if (tokens.length < 2 || span <= 0) {
    // A one-word (or empty) caption can't be meaningfully divided — both halves
    // keep the line, and the user edits whichever they don't want.
    return { left: { text }, right: { text } };
  }
  const frac = clamp01((at - start) / span);
  const cut = Math.min(tokens.length - 1, Math.max(1, Math.round(tokens.length * frac)));
  return {
    left: { text: tokens.slice(0, cut).join(" ") },
    right: { text: tokens.slice(cut).join(" ") },
  };
}

export interface SplitResult {
  left: DetectedMoment;
  right: DetectedMoment;
}

/**
 * Split `m` at absolute source time `at` into two independent moments.
 *
 * The LEFT half keeps the original id, so anything referencing this edit (the
 * selection, an AI Director operation back-link, an inspector that's open on it)
 * stays valid. The RIGHT half gets `newId`.
 *
 * Both halves are marked `edited: true` — a split is a user decision, and it
 * must survive a re-analysis in "keep" mode like any other manual edit.
 *
 * Returns `null` when the split point isn't valid (see `splitReason`).
 */
export function splitMoment(
  m: DetectedMoment,
  at: number,
  newId: string
): SplitResult | null {
  if (!canSplit(m, at)) return null;

  const cut = round(at);
  const kf = splitKeyframes(m.keyframes, m.startTime, m.endTime, at);

  const left: DetectedMoment = {
    ...m,
    endTime: cut,
    edited: true,
  };
  const right: DetectedMoment = {
    ...m,
    id: newId,
    startTime: cut,
    edited: true,
  };

  // Keyframes: re-normalized per half, or removed from a half that has none.
  if (m.keyframes?.length) {
    if (kf.left) left.keyframes = kf.left;
    else delete left.keyframes;
    if (kf.right) right.keyframes = kf.right;
    else delete right.keyframes;
  }

  // Captions: partition the real words so each half says what was actually said.
  if (m.effectType === "captions" && m.captions) {
    const parts = splitCaptionWords(
      m.captions.words,
      m.captions.text,
      m.startTime,
      m.endTime,
      at
    );
    left.captions = { ...m.captions, ...parts.left };
    right.captions = { ...m.captions, ...parts.right };
    // `highlightedWords` indexes into `words`, which we just re-partitioned —
    // the old indices now point at the wrong words. Dropping it is the only
    // correct move; keeping it would highlight arbitrary text.
    delete left.captions.highlightedWords;
    delete right.captions.highlightedWords;
  }

  // Everything else (cut / speed / overlay settings, textStyle, focusRegion,
  // director back-link) is shared configuration and is copied verbatim by the
  // spread above — a split zoom is still the same zoom, twice.
  return { left, right };
}

/**
 * Split whichever moments in `moments` contain `at`, restricted to `ids`.
 *
 * Returns the new full list plus the ids of the newly-created right halves (so
 * the caller can select them), or `null` when nothing was splittable — which the
 * caller should treat as "tell the user why", not as a silent no-op.
 */
export function splitMomentsAt(
  moments: DetectedMoment[],
  ids: string[],
  at: number,
  mintId: () => string
): { moments: DetectedMoment[]; newIds: string[] } | null {
  const target = new Set(ids);
  const out: DetectedMoment[] = [];
  const newIds: string[] = [];

  for (const m of moments) {
    if (!target.has(m.id)) {
      out.push(m);
      continue;
    }
    const res = splitMoment(m, at, mintId());
    if (!res) {
      out.push(m);
      continue;
    }
    out.push(res.left, res.right);
    newIds.push(res.right.id);
  }

  if (newIds.length === 0) return null;
  return { moments: out.sort((a, b) => a.startTime - b.startTime), newIds };
}
