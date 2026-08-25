/**
 * Pure buffer-health rules for the editor preview's smart rebuffering.
 *
 * On the web the preview streams the recording from cloud storage. When the
 * connection can't keep up, the browser's default behaviour is the worst
 * possible UX: it stalls (`waiting`), resumes the instant it has a few frames,
 * and immediately stalls again — playback reads as "freezes, continues, then
 * stops and so on". Every cut-skip seek also lands in cold, unbuffered
 * territory, so a timeline full of cuts turns into a stall per cut.
 *
 * The fix (RealVideoPlayer's `useSmartBuffering`) is what every streaming
 * player does: when playback underruns, HOLD it (paused, spinner showing)
 * until a real buffer builds, then resume once — one honest buffering moment
 * instead of a play/stall thrash. This module is the decision logic, kept
 * pure so the thresholds are testable without a media element.
 */

/** Structural TimeRanges so tests can pass plain arrays. */
export interface BufferedRangesLike {
  length: number;
  start(index: number): number;
  end(index: number): number;
}

/**
 * Buffer we require before RESUMING from a hold, in seconds of MEDIA time at
 * 1× (scaled by playbackRate — a 2× speed section drains the buffer twice as
 * fast, so it needs twice the runway).
 */
export const REBUFFER_GOAL_S = 2.5;

/**
 * Buffer level that TRIGGERS a hold. Deliberately far below the resume goal
 * (hysteresis): a genuine underrun arrives with ~0s ahead, while a transient
 * `waiting` fired mid-seek into buffered data has plenty — holding there would
 * pause playback that was about to continue fine.
 */
export const HOLD_LOW_WATER_S = 0.9;

/** After this long holding, give up on the goal and resume with what we have. */
export const HOLD_MAX_MS = 12_000;

/** ...but only if there is at least SOMETHING to play, or we'd stall instantly. */
export const FORCE_RESUME_MIN_S = 0.35;

/**
 * Main-video headroom below which the decorative blur-background video (a
 * SECOND decoder + network stream of the same file) is starved: while the main
 * stream is fighting for bandwidth, a blurred letterbox backdrop does not get
 * to compete with it. It freezes on its last frame — at 40px of blur nobody
 * can tell — and resumes syncing once the main buffer is healthy again.
 */
export const BG_MIN_HEADROOM_S = 4;

/** Treat ranges separated by less than this as contiguous (keyframe rounding). */
const RANGE_JOIN_EPSILON_S = 0.1;

/** Tolerance for "t is inside this range" (currentTime sits at a range edge). */
const RANGE_EDGE_EPSILON_S = 0.05;

/**
 * Seconds of contiguous buffered media ahead of `t`. Walks the range containing
 * `t` and chains through any ranges that follow within {@link RANGE_JOIN_EPSILON_S}
 * (browsers routinely split one continuous load into near-touching ranges).
 * Returns 0 when `t` is not inside any buffered range.
 */
export function bufferedAheadSeconds(
  ranges: BufferedRangesLike | null | undefined,
  t: number
): number {
  if (!ranges || !Number.isFinite(t)) return 0;
  // Collect + sort — TimeRanges are documented as ordered, but a copy is cheap
  // and makes the chaining below independent of that guarantee.
  const list: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < ranges.length; i++) {
    const s = ranges.start(i);
    const e = ranges.end(i);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) list.push({ start: s, end: e });
  }
  list.sort((a, b) => a.start - b.start);

  let end: number | null = null;
  for (const r of list) {
    if (end === null) {
      if (t >= r.start - RANGE_EDGE_EPSILON_S && t < r.end) end = r.end;
    } else if (r.start <= end + RANGE_JOIN_EPSILON_S) {
      end = Math.max(end, r.end);
    } else {
      break;
    }
  }
  return end === null ? 0 : Math.max(0, end - t);
}

/**
 * Buffer (seconds ahead) required to resume from a hold: the base goal scaled
 * by playback rate, but never more than what remains of the video — near the
 * end, "everything that's left" is the only possible goal.
 */
export function resumeGoalSeconds(rate: number, remaining: number): number {
  const r = Number.isFinite(rate) && rate > 0 ? Math.max(1, rate) : 1;
  const goal = REBUFFER_GOAL_S * r;
  if (!Number.isFinite(remaining)) return goal;
  return Math.min(goal, Math.max(0, remaining - RANGE_EDGE_EPSILON_S));
}

/**
 * Should an underrun (a `waiting` event, or landing after a seek) start a hold?
 * Only when the buffer is genuinely thin — see {@link HOLD_LOW_WATER_S} — and
 * there is meaningfully more video left than we have buffered.
 */
export function shouldHold(aheadS: number, remaining: number): boolean {
  const need = Number.isFinite(remaining)
    ? Math.min(HOLD_LOW_WATER_S, Math.max(0, remaining - RANGE_EDGE_EPSILON_S))
    : HOLD_LOW_WATER_S;
  return need > 0 && aheadS < need;
}

/** Enough buffered to end the hold and resume playback. */
export function canResume(aheadS: number, goalS: number): boolean {
  return aheadS >= goalS;
}

/**
 * Held long past reason with SOME data available — resume anyway rather than
 * pinning a spinner on a connection that trickles but never reaches the goal.
 */
export function shouldForceResume(heldMs: number, aheadS: number): boolean {
  return heldMs >= HOLD_MAX_MS && aheadS >= FORCE_RESUME_MIN_S;
}

/**
 * ONE rule for "the preview needs the connection to itself right now" —
 * consulted by every secondary consumer of the same source URL (the blur
 * Canvas-Fit background's second decoder, the timeline-thumbnail extractor)
 * before it costs the player a range request. During a rebuffer hold, or while
 * playing on a thin buffer, those consumers wait; once the runway is healthy
 * (or playback is paused — no deadline), they proceed. On a local/desktop
 * source the buffer is effectively the whole file, so this never throttles.
 */
export function previewNeedsBandwidth(opts: {
  paused: boolean;
  ended: boolean;
  holding: boolean;
  aheadS: number;
}): boolean {
  if (opts.holding) return true;
  if (opts.paused || opts.ended) return false;
  return opts.aheadS < BG_MIN_HEADROOM_S;
}
