/**
 * Retry scheduling. Pure and injectable, so the policy is asserted by tests
 * rather than observed by waiting.
 *
 * The shape of the problem: a push can fail because the network is gone (retry
 * soon, it will come back), because Firestore is rate-limiting (retry later, and
 * do not stampede), or because the write is genuinely invalid (retrying forever
 * is just noise). The first two are the same code path with different delays;
 * the third is what `PERMANENT_CODES` exists to stop.
 */

/** Base delay for the first retry. */
export const BASE_DELAY_MS = 1_000;
/** Ceiling — an hour-long backoff would look indistinguishable from broken. */
export const MAX_DELAY_MS = 5 * 60_000;
/**
 * Attempts before an operation is parked as `failed` and needs a human.
 * Reaching this does NOT discard the operation: it stays in the outbox, and the
 * retry button re-arms it. Nothing queued is ever dropped on the floor.
 */
export const MAX_ATTEMPTS = 8;

/**
 * Firestore/Storage error codes that will never succeed on retry. Retrying a
 * permission-denied write every 5 minutes for the life of the session buys
 * nothing and hides the real problem from the user.
 */
export const PERMANENT_CODES = new Set([
  "permission-denied",
  "unauthenticated",
  "invalid-argument",
  "not-found",
  "failed-precondition",
  "storage/unauthorized",
  "storage/object-not-found",
  "storage/invalid-argument",
]);

export function isPermanent(code: string | undefined): boolean {
  return !!code && PERMANENT_CODES.has(code);
}

/**
 * Delay before attempt number `attempts` (1 = the first retry).
 *
 * Exponential with FULL JITTER: the delay is a random point in [0, capped], not
 * the cap itself. Every desktop client that lost the same Wi-Fi network retries
 * at a different moment, which is the whole reason jitter exists — a fleet
 * reconnecting in lockstep is how a backend gets a second outage.
 *
 * `random` is injected so tests are deterministic.
 */
export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
  if (attempts <= 0) return 0;
  const exponential = BASE_DELAY_MS * 2 ** (attempts - 1);
  const capped = Math.min(MAX_DELAY_MS, exponential);
  return Math.round(random() * capped);
}

/** When attempt `attempts` may run, given the clock now. */
export function nextAttemptAt(
  attempts: number,
  now: number,
  random: () => number = Math.random
): number {
  return now + backoffDelayMs(attempts, random);
}

export interface RetryDecision {
  /** `failed` parks the op for a human; `queued` re-arms it for another go. */
  state: "queued" | "failed";
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
}

/**
 * What to do with an operation that just failed.
 *
 * Permanent errors and exhausted attempts both park the row as `failed` — with
 * the message retained, because "sync failed" with no reason is not something a
 * user can act on, and the requirement is explicitly to provide retry details.
 */
export function decideRetry(args: {
  attempts: number;
  now: number;
  message: string;
  code?: string;
  random?: () => number;
}): RetryDecision {
  const attempts = args.attempts + 1;
  const permanent = isPermanent(args.code);
  const exhausted = attempts >= MAX_ATTEMPTS;
  if (permanent || exhausted) {
    return {
      state: "failed",
      attempts,
      // Parked: no timer will pick it up. A retry sets this to `now`.
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      lastError: args.message,
    };
  }
  return {
    state: "queued",
    attempts,
    nextAttemptAt: nextAttemptAt(attempts, args.now, args.random),
    lastError: args.message,
  };
}

/** Re-arm a parked operation (the user pressed Retry). */
export function rearm(now: number): Pick<RetryDecision, "state" | "attempts" | "nextAttemptAt"> {
  // Attempts reset so the user gets a full ladder again rather than one try.
  return { state: "queued", attempts: 0, nextAttemptAt: now };
}
