/**
 * Live geometry of an in-progress pill drag — an EXTERNAL store, deliberately
 * not React state, and deliberately free of JSX so it can be unit-tested directly.
 *
 * WHY THIS EXISTS
 * ---------------
 * The drag draft used to be `React.useState` inside `RealTimeline`, written on
 * every raw `pointermove`:
 *
 *     setDraft({ id, startTime, endTime });   // ~1 per pointer event
 *     setSnapGuide(guide);
 *
 * `RealTimeline` is the timeline SHELL: it renders the unified control bar, the
 * ruler, every lane, the playhead and the scroller. So one pointermove
 * re-rendered all of that, plus — because the pointermove effect listed `draft`
 * in its dependency array — tore down and re-attached the window listeners on
 * every event. Measured over a 40-move drag that was 43 timeline renders, 43
 * control-bar renders, 43 playhead renders and 172 lane renders, to move ONE
 * pill.
 *
 * A drag draft has exactly the shape an external store is for: it changes at
 * pointer rate, and precisely one component (the pill under the pointer) has to
 * re-render when it does. Here the move handler writes into a mutable cell and
 * notifies at most once per frame, so:
 *
 *   • the timeline shell does NOT re-render during a drag — it never subscribes;
 *   • every pill subscribes, but a pill that isn't being dragged reads `null`
 *     every time and so is never re-rendered by a move;
 *   • the dragged pill re-renders at most once per animation frame no matter how
 *     many pointermove events the OS delivers (high-polling-rate mice routinely
 *     deliver several per frame — those extra renders were pure waste).
 */

/** Geometry of the moment being dragged, in seconds. */
export interface MomentDraft {
  id: string;
  startTime: number;
  endTime: number;
}

export interface DragStore {
  /** The live draft, or null when nothing is being dragged. */
  getDraft(): MomentDraft | null;
  /** The snap magnet the drag is currently latched to, in seconds. */
  getSnapGuide(): number | null;
  /**
   * Write the live draft. Notification is coalesced to one per frame; the value
   * itself is readable immediately, so event handlers always see the truth.
   */
  setDraft(next: MomentDraft | null): void;
  setSnapGuide(next: number | null): void;
  /**
   * Publish any coalesced change NOW, cancelling the pending frame. Used on
   * pointerup so the release lands in the same task as the commit rather than a
   * frame later — a drag that ends and immediately writes to the project must
   * not leave a stale draft on screen for a frame.
   */
  flush(): void;
  subscribe(onChange: () => void): () => void;
}

/** Injectable so tests drive frames instead of waiting for a real one. */
export interface FrameScheduler {
  request(fn: () => void): number;
  cancel(handle: number): void;
}

const realFrames: FrameScheduler = {
  request: (fn) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => fn())
      : (setTimeout(fn, 16) as unknown as number),
  cancel: (h) => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(h);
    else clearTimeout(h as unknown as ReturnType<typeof setTimeout>);
  },
};

export function createDragStore(frames: FrameScheduler = realFrames): DragStore {
  let draft: MomentDraft | null = null;
  let snapGuide: number | null = null;
  const listeners = new Set<() => void>();

  let pending = 0;
  let scheduled = false;

  const notify = () => {
    scheduled = false;
    pending = 0;
    // Copied before iterating so a listener that unsubscribes during the notify
    // (a pill unmounting mid-drag) can't mutate the set underneath the loop.
    for (const fn of [...listeners]) fn();
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    pending = frames.request(notify);
  };

  return {
    getDraft: () => draft,
    getSnapGuide: () => snapGuide,
    setDraft(next) {
      // A null→null write happens on every click that isn't a drag; publishing it
      // would re-render every pill for nothing.
      if (draft === next) return;
      if (
        draft &&
        next &&
        draft.id === next.id &&
        draft.startTime === next.startTime &&
        draft.endTime === next.endTime
      ) {
        return;
      }
      draft = next;
      schedule();
    },
    setSnapGuide(next) {
      if (Object.is(snapGuide, next)) return;
      snapGuide = next;
      schedule();
    },
    flush() {
      if (!scheduled) return;
      frames.cancel(pending);
      notify();
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}

/**
 * The draft for ONE moment id, as a stable snapshot.
 *
 * This is the selector every pill uses. It returns the SAME object identity
 * while a drag's geometry is unchanged and `null` for every pill that isn't the
 * one being dragged, which is what lets `useSyncExternalStore` skip 39 of 40
 * pills on every frame of a drag. (Returning a fresh `{...}` here would re-render
 * every pill on every frame and quietly undo the whole point.)
 */
export function draftFor(store: DragStore, id: string): MomentDraft | null {
  const draft = store.getDraft();
  return draft && draft.id === id ? draft : null;
}
