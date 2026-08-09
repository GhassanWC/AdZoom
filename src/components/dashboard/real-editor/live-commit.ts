/**
 * Local-first control state — the pure half.
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------
 * Every control in the editor used to be fully controlled by PERSISTED state:
 *
 *     <Slider value={moment.intensity} onChange={v => updateMoment(id, {...})} />
 *
 * `updateMoment` serializes the whole analysis document, queues a write, waits
 * for the store subscription to echo it back, re-renders the provider, and only
 * THEN does the knob move. Every keystroke and every pixel of a slider drag paid
 * that round-trip, which is why typing dropped characters and repeated clicks
 * appeared to do nothing.
 *
 * The fix is the standard one: the control owns a local DRAFT that updates
 * synchronously (so the UI is instant), and persistence is scheduled separately
 * (so the document is written at a sane rate). This module is the scheduling +
 * reconciliation logic, kept free of React so it can be unit-tested directly.
 *
 * Two rules make this safe rather than merely fast:
 *
 *  1. RECONCILIATION — while the user is interacting, an incoming external value
 *     must NEVER overwrite the draft. Otherwise the write we just sent echoes
 *     back mid-gesture and yanks the slider (or truncates the text) under them.
 *     See `shouldAdoptExternal`.
 *
 *  2. NO LOST FINAL VALUE — a debounce that can be cancelled by unmount, or that
 *     drops the trailing call, silently loses the user's last edit. The scheduler
 *     below always retains the newest value and always flushes it: on the trailing
 *     timer, on `maxWait`, or explicitly on release/blur/unmount.
 */

/** Injectable timers so tests drive the clock instead of sleeping. */
export interface CommitTimers {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  now: () => number;
}

export const realTimers: CommitTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
  now: () => Date.now(),
};

export interface CommitSchedulerOptions<T> {
  /** Trailing debounce: quiet for this long after the last push → commit. */
  delayMs: number;
  /**
   * Upper bound on how long a CONTINUOUS stream of pushes may go uncommitted.
   * A slider drag never goes quiet, so a pure debounce would freeze the preview
   * for the whole gesture; `maxWaitMs` is what keeps the preview live mid-drag.
   */
  maxWaitMs: number;
  /**
   * Where a committed value goes. Optional so a React caller can construct the
   * scheduler without capturing a render-scoped closure, then supply the live
   * handler from an effect via `setHandlers` — see useLiveValue.
   */
  commit?: (value: T) => void;
  timers?: CommitTimers;
  /** Treated as "no change" — skips redundant writes. Defaults to Object.is. */
  equals?: (a: T, b: T) => boolean;
  /**
   * Called whenever the scheduler goes idle — after a commit, after a commit
   * that was SKIPPED as redundant, and on cancel. Callers use this to track
   * "is a write still outstanding?" without polling.
   */
  onSettled?: () => void;
}

export interface CommitScheduler<T> {
  /**
   * Replace the handlers after construction. Lets a component build the
   * scheduler once and keep `commit` pointing at the current render's closure
   * without reading refs during render.
   */
  setHandlers: (next: {
    commit?: (value: T) => void;
    equals?: (a: T, b: T) => boolean;
    onSettled?: () => void;
  }) => void;
  /** Record a new value; schedules a commit per the debounce/maxWait policy. */
  push: (value: T) => void;
  /** Commit the newest pending value right now (release / blur / unmount). */
  flush: () => void;
  /** Drop any pending value WITHOUT committing (Escape / revert). */
  cancel: () => void;
  /** True when a value has been pushed but not yet committed. */
  pending: () => boolean;
  /** The newest pushed value, committed or not. */
  latest: () => T | undefined;
}

/**
 * Debounce with a maxWait ceiling and a guaranteed trailing commit.
 *
 * `push` during an active window never drops the value — it replaces it — so the
 * last thing the user did is always what gets persisted.
 */
export function createCommitScheduler<T>(
  opts: CommitSchedulerOptions<T>
): CommitScheduler<T> {
  const timers = opts.timers ?? realTimers;
  let commitFn = opts.commit;
  let equals = opts.equals ?? Object.is;
  let onSettled = opts.onSettled;

  let timerId: number | null = null;
  /** When the current uncommitted run of pushes began (for maxWait). */
  let runStartedAt: number | null = null;
  let pendingValue: T | undefined;
  let hasPending = false;
  let lastCommitted: T | undefined;
  let hasCommitted = false;

  const clear = () => {
    if (timerId !== null) {
      timers.clearTimeout(timerId);
      timerId = null;
    }
  };

  const doCommit = () => {
    clear();
    runStartedAt = null;
    if (!hasPending) return;
    // No handler yet (constructed but not wired). KEEP the value pending rather
    // than dropping it — a later flush will persist it. Losing a user's edit to
    // a wiring race is the one failure mode this whole module exists to avoid.
    if (!commitFn) return;
    const value = pendingValue as T;
    hasPending = false;
    pendingValue = undefined;
    // Skip a write that would be a no-op. This is what stops a slider the user
    // nudged back to its original value from writing the document again.
    const redundant = hasCommitted && equals(lastCommitted as T, value);
    if (!redundant) {
      lastCommitted = value;
      hasCommitted = true;
      commitFn(value);
    }
    onSettled?.();
  };

  const arm = () => {
    clear();
    const started = runStartedAt ?? timers.now();
    runStartedAt = started;
    const elapsed = timers.now() - started;
    // Never let a continuous gesture outrun maxWait — the preview must keep up.
    const wait = Math.max(0, Math.min(opts.delayMs, opts.maxWaitMs - elapsed));
    timerId = timers.setTimeout(doCommit, wait);
  };

  return {
    setHandlers(next) {
      if (next.commit) commitFn = next.commit;
      if (next.equals) equals = next.equals;
      if (next.onSettled) onSettled = next.onSettled;
    },
    push(value: T) {
      pendingValue = value;
      hasPending = true;
      arm();
    },
    flush() {
      doCommit();
    },
    cancel() {
      clear();
      runStartedAt = null;
      const had = hasPending;
      hasPending = false;
      pendingValue = undefined;
      if (had) onSettled?.();
    },
    pending() {
      return hasPending;
    },
    latest() {
      return hasPending ? pendingValue : lastCommitted;
    },
  };
}

/**
 * Should an incoming EXTERNAL value replace the local draft?
 *
 * The three "no" cases are the whole point:
 *
 *  • `interacting` — pointer is down on the slider / caret is in the field. An
 *    echo of our own write (or any other update) must not move it. This is what
 *    fixes dropped keystrokes: React would otherwise reset `value` to the
 *    last-persisted text on every render while the user keeps typing.
 *
 *  • `pending` — we have a newer value scheduled that hasn't been written yet.
 *    The external value is by definition older, so adopting it would rubber-band
 *    the control backwards.
 *
 *  • equal — nothing to do; avoids a pointless state update (and re-render).
 */
export function shouldAdoptExternal<T>(state: {
  interacting: boolean;
  pending: boolean;
  external: T;
  draft: T;
  equals?: (a: T, b: T) => boolean;
}): boolean {
  if (state.interacting) return false;
  if (state.pending) return false;
  const equals = state.equals ?? Object.is;
  return !equals(state.external, state.draft);
}

/**
 * Commit cadence per control kind. These are deliberately different: a text
 * field that wrote on a 16ms cadence would hammer the document once per
 * keystroke, and a slider that only wrote on release would leave the preview
 * frozen for the whole drag.
 */
export const COMMIT_PROFILES = {
  /**
   * Continuous drags (sliders, colour pickers). Short debounce so the preview
   * tracks the handle; maxWait keeps it live through an unbroken drag.
   */
  drag: { delayMs: 60, maxWaitMs: 120 },
  /**
   * Typing. Long enough that a normal typing burst is ONE write, short enough
   * that the preview updates while the user pauses to look at it.
   */
  text: { delayMs: 220, maxWaitMs: 600 },
  /**
   * Discrete choices (toggles, tabs, dropdowns, segmented controls). These are
   * single deliberate acts — persist promptly, but still off the click handler
   * so the button's own visual feedback never waits on a write.
   */
  discrete: { delayMs: 0, maxWaitMs: 0 },
} as const;
