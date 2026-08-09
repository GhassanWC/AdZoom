/**
 * The playhead clock's storage — deliberately plain, framework-free and in its
 * own module (no JSX) so it can be unit-tested directly. The React bindings live
 * in playback-clock.tsx; the rationale for a store rather than React state is
 * documented there.
 */

export interface ClockStore {
  get(): number;
  set(t: number): void;
  subscribe(onChange: () => void): () => void;
}

export function createClockStore(initial = 0): ClockStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(t: number) {
      // Ignore no-op writes: `timeupdate` can fire with an unchanged time when
      // paused, and a redundant notify would re-render every time readout.
      if (Object.is(value, t)) return;
      value = t;
      // Copied before iterating so a listener that unsubscribes during the
      // notify can't mutate the set mid-loop.
      for (const fn of [...listeners]) fn();
    },
    subscribe(onChange: () => void) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}
