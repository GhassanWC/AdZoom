/**
 * Editor responsiveness — the pure logic behind the local-first controls and the
 * playhead clock.
 *
 * These lock the two properties that make the editor feel instant WITHOUT losing
 * data: a control never waits on a document write to show what the user did, and
 * the value they finished on is always the value that gets persisted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMMIT_PROFILES,
  createCommitScheduler,
  shouldAdoptExternal,
  type CommitTimers,
} from "@/components/dashboard/real-editor/live-commit";
import { createClockStore } from "@/components/dashboard/real-editor/clock-store";
import {
  activeMomentIdAt,
  canSplitAt,
} from "@/components/dashboard/real-editor/clock-selectors";
import type { DetectedMoment } from "@/lib/firebase/schema";

/** A controllable clock so debounce behaviour is asserted, not slept through. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: CommitTimers = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  /** Advance time, firing due callbacks in chronological order. */
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Infinity;
      for (const [id, t] of pending) {
        if (t.at <= target && t.at < dueAt) {
          dueAt = t.at;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const t = pending.get(dueId)!;
      pending.delete(dueId);
      now = t.at;
      t.fn();
    }
    now = target;
  };
  return { timers, advance };
}

// ── Commit scheduling ──────────────────────────────────────────────────────

test("a burst of keystrokes is ONE write, carrying the last value typed", () => {
  const { timers, advance } = fakeTimers();
  const writes: string[] = [];
  const s = createCommitScheduler<string>({
    ...COMMIT_PROFILES.text,
    commit: (v) => writes.push(v),
    timers,
  });

  for (const v of ["H", "He", "Hel", "Hell", "Hello"]) {
    s.push(v);
    advance(30); // fast typing, well inside the debounce
  }
  assert.deepEqual(writes, [], "must not write mid-burst");

  advance(COMMIT_PROFILES.text.delayMs);
  assert.deepEqual(writes, ["Hello"], "one write, the final text");
});

test("a continuous drag still updates within maxWait, so the preview stays live", () => {
  const { timers, advance } = fakeTimers();
  const writes: number[] = [];
  const s = createCommitScheduler<number>({
    ...COMMIT_PROFILES.drag,
    commit: (v) => writes.push(v),
    timers,
  });

  // An unbroken drag: a push every 10ms for 500ms. A plain debounce would never
  // fire here and the preview would freeze for the whole gesture.
  for (let i = 1; i <= 50; i++) {
    s.push(i);
    advance(10);
  }
  assert.ok(writes.length >= 3, `expected periodic commits, got ${writes.length}`);
  assert.ok(
    writes.length < 50,
    `expected far fewer writes than pushes, got ${writes.length}`
  );
  // Values must be monotonic — never an out-of-order (stale) write.
  for (let i = 1; i < writes.length; i++) {
    assert.ok(writes[i] > writes[i - 1], "writes must not go backwards");
  }
});

test("release flushes the final value even when the debounce has not elapsed", () => {
  const { timers } = fakeTimers();
  const writes: number[] = [];
  const s = createCommitScheduler<number>({
    ...COMMIT_PROFILES.drag,
    commit: (v) => writes.push(v),
    timers,
  });

  s.push(42);
  assert.deepEqual(writes, []);
  s.flush(); // pointerup / blur / unmount
  assert.deepEqual(writes, [42], "the value the user let go on must be persisted");
});

test("a value dragged back to where it started writes nothing", () => {
  const { timers, advance } = fakeTimers();
  const writes: number[] = [];
  const s = createCommitScheduler<number>({
    ...COMMIT_PROFILES.drag,
    commit: (v) => writes.push(v),
    timers,
  });

  s.push(10);
  s.flush();
  s.push(25);
  s.push(10); // wandered and came back
  advance(COMMIT_PROFILES.drag.maxWaitMs + 1);
  assert.deepEqual(writes, [10], "no redundant second write");
});

test("cancel abandons the pending value (Escape must not persist)", () => {
  const { timers, advance } = fakeTimers();
  const writes: number[] = [];
  const s = createCommitScheduler<number>({
    ...COMMIT_PROFILES.drag,
    commit: (v) => writes.push(v),
    timers,
  });

  s.push(99);
  s.cancel();
  advance(1000);
  assert.deepEqual(writes, []);
  assert.equal(s.pending(), false);
});

// ── Reconciliation ─────────────────────────────────────────────────────────

test("an external value NEVER overwrites the draft mid-interaction", () => {
  // This is the dropped-keystroke bug: the write echoes back the older text
  // while the user is still typing, and a naive controlled input resets to it.
  assert.equal(
    shouldAdoptExternal({
      interacting: true,
      pending: false,
      external: "Hell",
      draft: "Hello wor",
    }),
    false
  );
});

test("an external value does not overwrite a draft with a newer pending write", () => {
  assert.equal(
    shouldAdoptExternal({
      interacting: false,
      pending: true,
      external: 10,
      draft: 55,
    }),
    false
  );
});

test("an external change IS adopted once idle — undo/redo must reach the control", () => {
  assert.equal(
    shouldAdoptExternal({
      interacting: false,
      pending: false,
      external: 10,
      draft: 55,
    }),
    true
  );
});

test("an identical external value is not adopted (no pointless re-render)", () => {
  assert.equal(
    shouldAdoptExternal({
      interacting: false,
      pending: false,
      external: 55,
      draft: 55,
    }),
    false
  );
});

// ── Playback clock ─────────────────────────────────────────────────────────

test("the clock notifies subscribers on change and ignores no-op writes", () => {
  const clock = createClockStore(0);
  let notifications = 0;
  const unsub = clock.subscribe(() => notifications++);

  clock.set(1.5);
  assert.equal(clock.get(), 1.5);
  assert.equal(notifications, 1);

  clock.set(1.5); // `timeupdate` can fire with an unchanged time while paused
  assert.equal(notifications, 1, "a repeated time must not re-render anything");

  clock.set(2);
  assert.equal(notifications, 2);

  unsub();
  clock.set(3);
  assert.equal(notifications, 2, "unsubscribed listeners must not be called");
  assert.equal(clock.get(), 3, "the value still advances after unsubscribe");
});

// ── Clock-derived selectors ────────────────────────────────────────────────

const moment = (
  id: string,
  startTime: number,
  endTime: number
): DetectedMoment =>
  ({ id, startTime, endTime, effectType: "zoom", label: id }) as DetectedMoment;

test("the active moment is coarse: it only changes at edit boundaries", () => {
  const moments = [moment("a", 0, 5), moment("b", 10, 20)];
  // Every tick inside the same edit yields the SAME id, which is what stops the
  // provider re-rendering several times a second during playback.
  assert.equal(activeMomentIdAt(moments, null, 0), "a");
  assert.equal(activeMomentIdAt(moments, null, 2.5), "a");
  assert.equal(activeMomentIdAt(moments, null, 5), "a");
  assert.equal(activeMomentIdAt(moments, null, 7), null);
  assert.equal(activeMomentIdAt(moments, null, 12), "b");
});

test("an explicit selection wins while the playhead is still inside it", () => {
  const moments = [moment("a", 0, 10), moment("b", 2, 4)];
  // Overlapping edits: the one the user actually clicked must stay in the
  // inspector rather than being swapped out by range order.
  assert.equal(activeMomentIdAt(moments, "b", 3), "b");
  // Once the playhead leaves the selection, fall back to what contains it.
  assert.equal(activeMomentIdAt(moments, "b", 8), "a");
});

test("canSplitAt is false with no target, and tracks the playhead", () => {
  const moments = [moment("a", 0, 10)];
  assert.equal(canSplitAt(moments, [], 5), false);
  assert.equal(canSplitAt(moments, ["a"], 5), true, "mid-edit splits");
  assert.equal(canSplitAt(moments, ["a"], 0), false, "the very start does not");
  assert.equal(canSplitAt(moments, ["a"], 50), false, "outside the edit does not");
  assert.equal(canSplitAt(moments, ["missing"], 5), false);
});
