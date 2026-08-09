"use client";

import * as React from "react";
import type { ClockStore } from "./clock-store";

/**
 * The playhead clock, kept OUT of the main editor context.
 *
 * WHY THIS EXISTS
 * ---------------
 * `currentTime` used to be `React.useState` inside `EditorRealProvider`, i.e. in
 * the same context object as the project, every mutator and every piece of UI
 * state. The video's `timeupdate` fires several times a second during playback,
 * and `seek()` fires on every pointermove while scrubbing — so each tick
 * re-rendered the provider, produced a brand-new context value, and re-rendered
 * all ~30 consumers: the whole timeline with every pill, the inspector with
 * every control, the export panel, the preview. Dragging anything meant
 * re-rendering the entire editor at pointer-event rate, which is what made
 * clicks, keystrokes and drags feel stuck.
 *
 * A clock is a textbook case for an EXTERNAL store rather than React state: the
 * value changes constantly, but almost nothing needs to re-render when it does.
 * Here the tick writes into a mutable cell and notifies subscribers, so:
 *
 *   • the provider does NOT re-render on a tick (it never reads the raw value);
 *   • only components that actually display time re-render, and only those;
 *   • components that need time inside an event handler (drag/snap math) read
 *     `useClockRef()` and re-render NEVER.
 *
 * The playhead itself still bypasses all of this and reads `video.currentTime`
 * in a rAF loop — see Playhead.tsx. This store is for the other consumers.
 */

// The store itself lives in clock-store.ts (no JSX, so it is directly testable);
// re-exported here so callers have one import site.
export { createClockStore, type ClockStore } from "./clock-store";

const ClockCtx = React.createContext<ClockStore | null>(null);

export function PlaybackClockProvider({
  store,
  children,
}: {
  store: ClockStore;
  children: React.ReactNode;
}) {
  return <ClockCtx.Provider value={store}>{children}</ClockCtx.Provider>;
}

function useClockStore(): ClockStore {
  const store = React.useContext(ClockCtx);
  if (!store) {
    throw new Error("Playback clock used outside EditorRealProvider");
  }
  return store;
}

/**
 * Subscribe to the raw playhead time. Re-renders the calling component on every
 * tick — use it only for a component that literally renders the time, and keep
 * that component small. Prefer `useClockSelector` when a coarser value will do.
 */
export function usePlaybackTime(): number {
  const store = useClockStore();
  return React.useSyncExternalStore(store.subscribe, store.get, () => 0);
}

/**
 * Subscribe to a DERIVED value of the clock, re-rendering only when that derived
 * value changes. This is how a component that highlights "the chapter under the
 * playhead" re-renders a handful of times per video instead of several times a
 * second.
 *
 * The selector must return a primitive (compared with `Object.is`); returning a
 * fresh object every call would defeat the comparison and re-render every tick.
 */
export function useClockSelector<T extends string | number | boolean | null>(
  selector: (t: number) => T
): T {
  const store = useClockStore();
  // `getSnapshot` is deliberately rebuilt each render rather than held in a ref:
  // useSyncExternalStore re-reads it on every render and compares the RESULT, so
  // a fresh closure is free, and the selector always sees this render's inputs
  // (the segment list, the duration) without a stale-closure hazard.
  return React.useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(0)
  );
}

/**
 * A live, non-reactive handle on the clock — `ref.current` is always the current
 * time and reading it NEVER re-renders. This is what drag/snap math and command
 * handlers should use: they need the time at the instant of an event, not a
 * subscription to it.
 */
export function useClockRef(): React.RefObject<number> {
  const store = useClockStore();
  const ref = React.useRef(store.get());
  // Kept current by the subscription alone — no write during render. The effect
  // runs before any user interaction can read it, and every tick after that
  // updates it, so `ref.current` is always the live time at event time.
  React.useEffect(() => {
    ref.current = store.get();
    return store.subscribe(() => {
      ref.current = store.get();
    });
  }, [store]);
  return ref;
}

/** The setter, for the one component that owns the `<video>` element. */
export function useSetPlaybackTime(): (t: number) => void {
  const store = useClockStore();
  return React.useMemo(() => (t: number) => store.set(t), [store]);
}
