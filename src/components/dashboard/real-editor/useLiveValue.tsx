"use client";

import * as React from "react";
import {
  COMMIT_PROFILES,
  createCommitScheduler,
  shouldAdoptExternal,
} from "./live-commit";

export interface LiveValueProfile {
  delayMs: number;
  maxWaitMs: number;
}

/**
 * Identifies WHAT the controls below are editing (e.g. the selected edit's id).
 *
 * When this changes, every `useLiveValue` inside flushes its pending draft to
 * the thing it was editing BEFORE adopting the new one. That matters because a
 * selection can change without the user touching the control — the playhead
 * crossing into another edit during playback, or the dialog's Previous/Next
 * review nav — and a debounced draft that is still in flight would otherwise be
 * committed against whatever got selected next. (Verified: without this, typing
 * into one caption and navigating away writes that text onto the OTHER caption.)
 *
 * A remount (`key={id}`) also prevents that, but it destroys focus and the caret
 * mid-word, which is a worse bug than the one it fixes. This keeps the DOM.
 */
const LiveScopeCtx = React.createContext<string>("");

export function LiveValueScope({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return <LiveScopeCtx.Provider value={id}>{children}</LiveScopeCtx.Provider>;
}

export interface LiveValue<T> {
  /** What the control must render. Updates synchronously on `set`. */
  value: T;
  /** Record a user change: instant locally, persisted per the profile. */
  set: (next: T) => void;
  /** Pointer down / focus — freezes external reconciliation for the gesture. */
  begin: () => void;
  /** Pointer up / blur — ends the gesture and persists the final value now. */
  end: () => void;
  /** Persist whatever is pending immediately, without ending the gesture. */
  flush: () => void;
  /** Abandon the local draft and snap back to the persisted value (Escape). */
  reset: () => void;
}

/**
 * Local-first control state.
 *
 * The control renders `value` (local, instant). Changes are persisted through
 * `commit` on the cadence set by `profile` — never on the input event itself, so
 * a keystroke or a slider pixel never waits on a document write.
 *
 * Reconciliation with the persisted value is deliberately conservative: see
 * `shouldAdoptExternal`. The short version is that an update arriving from the
 * store is ignored while the user is actively interacting, which is what stops
 * the write echo from eating keystrokes mid-word.
 *
 * The final value is never lost: the scheduler flushes on `end` and on unmount.
 *
 * IMPLEMENTATION NOTE — `interacting` and `pending` are state rather than refs
 * on purpose. Both are read during render (to decide whether to adopt an
 * external value), and reading a ref during render is exactly the impurity the
 * React Compiler rules forbid. They change at most twice per gesture, so the
 * extra renders are of one small control and cost nothing.
 */
export function useLiveValue<T>(
  external: T,
  commit: (next: T) => void,
  profile: LiveValueProfile = COMMIT_PROFILES.drag,
  equals?: (a: T, b: T) => boolean
): LiveValue<T> {
  const eq = equals ?? Object.is;
  const scope = React.useContext(LiveScopeCtx);

  const [draft, setDraft] = React.useState<T>(external);
  const [interacting, setInteracting] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  // One scheduler for the life of the control, built WITHOUT capturing anything
  // render-scoped (`setPending` from useState is stable). Parents recreate
  // `commit`/`equals` inline on every render, so those are wired in from the
  // effect below — which keeps this hook free of ref reads during render.
  const [scheduler] = React.useState(() =>
    createCommitScheduler<T>({
      delayMs: profile.delayMs,
      maxWaitMs: profile.maxWaitMs,
      onSettled: () => setPending(false),
    })
  );
  React.useEffect(() => {
    scheduler.setHandlers({ commit, equals: eq });
  }, [scheduler, commit, eq]);

  // Reconcile against the persisted value DURING render (React's documented
  // "adjust state when props change" pattern) rather than in an effect, so the
  // control never paints one frame of stale data after an undo/redo.
  const [seenExternal, setSeenExternal] = React.useState<T>(external);
  const [seenScope, setSeenScope] = React.useState(scope);

  if (scope !== seenScope) {
    // The control now points at a DIFFERENT thing. Adopt unconditionally — the
    // usual "don't clobber the user mid-interaction" rule protects the value
    // they are editing, and this is no longer that value. The outgoing draft is
    // not lost: the layout effect below flushes it to its own target.
    setSeenScope(scope);
    setSeenExternal(external);
    setDraft(external);
    setPending(false);
  } else if (!eq(external, seenExternal)) {
    setSeenExternal(external);
    if (
      shouldAdoptExternal({ interacting, pending, external, draft, equals: eq })
    ) {
      setDraft(external);
    }
  }

  const set = React.useCallback(
    (next: T) => {
      setDraft(next);
      setPending(true);
      scheduler.push(next);
    },
    [scheduler]
  );

  const begin = React.useCallback(() => setInteracting(true), []);

  const end = React.useCallback(() => {
    setInteracting(false);
    scheduler.flush();
  }, [scheduler]);

  const flush = React.useCallback(() => scheduler.flush(), [scheduler]);

  const reset = React.useCallback(() => {
    setInteracting(false);
    scheduler.cancel();
    setDraft(external);
  }, [scheduler, external]);

  // Flush on unmount AND whenever the scope changes.
  //
  // A LAYOUT effect, and deliberately so: its cleanup runs during the commit
  // phase, BEFORE the passive effect above installs the new scope's `commit`.
  // So the outgoing draft is written with the handler still bound to the edit it
  // was typed into. A passive effect here would run after the rebind and send it
  // to the wrong one — which is precisely the bug this exists to prevent.
  React.useLayoutEffect(
    () => () => {
      scheduler.flush();
    },
    [scheduler, scope]
  );

  return { value: draft, set, begin, end, flush, reset };
}
