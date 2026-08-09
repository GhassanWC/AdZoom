/**
 * The two pure pieces that stop an interaction from re-rendering the whole
 * editor: drag geometry kept in an external store (so a pointermove reaches one
 * pill instead of the timeline shell), and object-identity reuse across project
 * echoes (so `React.memo` on a pill actually skips).
 *
 * Both are asserted here rather than through the UI because both are invisible
 * when they regress — the editor still LOOKS right while doing 10x the work.
 * The end-to-end counterpart is desktop/e2e/editor-perf.spec.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createDragStore,
  draftFor,
  type FrameScheduler,
} from "@/components/dashboard/real-editor/timeline/drag-store";
import {
  jsonEqual,
  reuseIdentity,
  reconcileProjectIdentity,
} from "@/components/dashboard/real-editor/moment-identity";

/** A frame scheduler the test drives by hand, so "per frame" is asserted. */
function manualFrames() {
  let nextHandle = 1;
  const pending = new Map<number, () => void>();
  const frames: FrameScheduler = {
    request(fn) {
      const handle = nextHandle++;
      pending.set(handle, fn);
      return handle;
    },
    cancel(handle) {
      pending.delete(handle);
    },
  };
  /** Run every callback queued for the next frame. */
  const tick = () => {
    const due = [...pending.values()];
    pending.clear();
    for (const fn of due) fn();
  };
  return { frames, tick, queued: () => pending.size };
}

// ── drag store ─────────────────────────────────────────────────────────────

test("a burst of pointermoves inside one frame notifies subscribers ONCE", () => {
  const { frames, tick } = manualFrames();
  const store = createDragStore(frames);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  // A 1000Hz mouse can deliver a dozen moves inside a single 16ms frame. Every
  // one of them used to be a setState, and so a render.
  for (let i = 1; i <= 12; i += 1) {
    store.setDraft({ id: "a", startTime: i, endTime: i + 1 });
  }
  assert.equal(notifications, 0, "nothing published before the frame runs");
  tick();
  assert.equal(notifications, 1, "twelve moves cost exactly one notification");
  assert.deepEqual(
    store.getDraft(),
    { id: "a", startTime: 12, endTime: 13 },
    "and the published value is the LAST one, not the first"
  );
});

test("the live value is readable immediately, before the frame publishes it", () => {
  const { frames } = manualFrames();
  const store = createDragStore(frames);
  store.setDraft({ id: "a", startTime: 3, endTime: 4 });
  // The move handler computes the NEXT position from the current one; if the
  // store lagged a frame behind the writes, the drag would drift.
  assert.deepEqual(store.getDraft(), { id: "a", startTime: 3, endTime: 4 });
});

test("only the dragged pill sees a draft — every other pill reads a stable null", () => {
  const { frames } = manualFrames();
  const store = createDragStore(frames);
  store.setDraft({ id: "b", startTime: 1, endTime: 2 });

  assert.equal(draftFor(store, "a"), null);
  assert.equal(draftFor(store, "c"), null);
  const first = draftFor(store, "b");
  assert.deepEqual(first, { id: "b", startTime: 1, endTime: 2 });
  // Same identity on re-read: useSyncExternalStore compares with Object.is, so a
  // fresh object here would re-render the pill on every frame regardless.
  assert.equal(draftFor(store, "b"), first);
});

test("a redundant write publishes nothing", () => {
  const { frames, tick, queued } = manualFrames();
  const store = createDragStore(frames);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  // null → null: every click that is not a drag ends this way.
  store.setDraft(null);
  assert.equal(queued(), 0, "a null→null write schedules no frame");

  store.setDraft({ id: "a", startTime: 1, endTime: 2 });
  tick();
  assert.equal(notifications, 1);

  // Same geometry again — a pointermove that didn't move far enough to change
  // the snapped result.
  store.setDraft({ id: "a", startTime: 1, endTime: 2 });
  tick();
  assert.equal(notifications, 1, "an unchanged draft does not re-render the pill");
});

test("flush publishes the release in the same task, not a frame later", () => {
  const { frames, tick } = manualFrames();
  const store = createDragStore(frames);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  store.setDraft({ id: "a", startTime: 1, endTime: 2 });
  store.flush();
  assert.equal(notifications, 1, "flush publishes immediately");
  assert.equal(store.getDraft()?.startTime, 1);

  // The frame that was pending must NOT fire a second time.
  tick();
  assert.equal(notifications, 1, "flush cancels the pending frame");
});

test("the snap guide shares the drag's frame budget", () => {
  const { frames, tick } = manualFrames();
  const store = createDragStore(frames);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  // Geometry and guide change together on every move; they must not cost two
  // renders per frame between them.
  store.setDraft({ id: "a", startTime: 1, endTime: 2 });
  store.setSnapGuide(1);
  tick();
  assert.equal(notifications, 1);
  assert.equal(store.getSnapGuide(), 1);
});

// ── identity reuse ─────────────────────────────────────────────────────────

test("jsonEqual compares structurally, including nested regions", () => {
  assert.ok(jsonEqual({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } }));
  assert.ok(!jsonEqual({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 3] } }));
  // Key COUNT differences matter: an added optional field is a real change.
  assert.ok(!jsonEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!jsonEqual([1, 2], { 0: 1, 1: 2 }));
  assert.ok(jsonEqual(null, null));
  assert.ok(!jsonEqual(null, {}));
});

test("an echo that changed nothing returns the PREVIOUS array", () => {
  const prev = [
    { id: "a", startTime: 0, endTime: 1 },
    { id: "b", startTime: 2, endTime: 3 },
  ];
  // What a store subscription hands back: same data, all-new objects.
  const next = JSON.parse(JSON.stringify(prev)) as typeof prev;
  assert.notEqual(next, prev);
  assert.notEqual(next[0], prev[0]);

  const result = reuseIdentity(prev, next);
  assert.equal(result, prev, "no change ⇒ not even a new array");
});

test("one edited moment costs exactly one new identity", () => {
  const prev = [
    { id: "a", startTime: 0, endTime: 1 },
    { id: "b", startTime: 2, endTime: 3 },
    { id: "c", startTime: 4, endTime: 5 },
  ];
  const next = JSON.parse(JSON.stringify(prev)) as typeof prev;
  next[1] = { ...next[1]!, endTime: 3.5 };

  const result = reuseIdentity(prev, next);
  assert.notEqual(result, prev, "a real change must produce a new array");
  assert.equal(result[0], prev[0], "untouched edits keep their identity");
  assert.equal(result[2], prev[2]);
  assert.notEqual(result[1], prev[1], "the edited one is the new object");
  assert.equal(result[1]!.endTime, 3.5);
});

test("reordering keeps every unmoved moment's identity", () => {
  const prev = [
    { id: "a", startTime: 0, endTime: 1 },
    { id: "b", startTime: 2, endTime: 3 },
  ];
  const next = [
    JSON.parse(JSON.stringify(prev[1])) as (typeof prev)[number],
    JSON.parse(JSON.stringify(prev[0])) as (typeof prev)[number],
  ];

  const result = reuseIdentity(prev, next);
  assert.notEqual(result, prev, "order changed ⇒ new array");
  assert.equal(result[0], prev[1], "matched by id, not by position");
  assert.equal(result[1], prev[0]);
});

test("additions and removals are handled without losing the survivors", () => {
  const prev = [
    { id: "a", startTime: 0, endTime: 1 },
    { id: "b", startTime: 2, endTime: 3 },
  ];
  const added = reuseIdentity(prev, [
    ...(JSON.parse(JSON.stringify(prev)) as typeof prev),
    { id: "c", startTime: 4, endTime: 5 },
  ]);
  assert.equal(added.length, 3);
  assert.equal(added[0], prev[0]);
  assert.equal(added[1], prev[1]);

  const removed = reuseIdentity(prev, [
    JSON.parse(JSON.stringify(prev[1])) as (typeof prev)[number],
  ]);
  assert.equal(removed.length, 1);
  assert.equal(removed[0], prev[1]);
});

test("an empty or absent previous list is passed straight through", () => {
  const next = [{ id: "a", startTime: 0, endTime: 1 }];
  assert.equal(reuseIdentity(undefined, next), next);
  assert.equal(reuseIdentity([], next), next);
});

// ── project-level reconciliation ───────────────────────────────────────────

/** Minimal ProjectDoc-shaped fixture — only the fields this function reads. */
function projectWith(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    analysis: {
      status: "complete",
      detectedMoments: [
        { id: "a", startTime: 0, endTime: 1 },
        { id: "b", startTime: 2, endTime: 3 },
      ],
      attentionCurve: [0.1, 0.2, 0.3],
    },
    sourceCrop: { x: 0, y: 0, width: 1, height: 1 },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("an echo that changed nothing leaves every memo-relevant reference alone", () => {
  const previous = projectWith();
  const echo = JSON.parse(JSON.stringify(previous));

  const result = reconcileProjectIdentity(previous, echo);
  assert.equal(
    result.analysis.detectedMoments,
    previous.analysis.detectedMoments,
    "moments array reused"
  );
  assert.equal(
    result.analysis.attentionCurve,
    previous.analysis.attentionCurve,
    "attention curve reused — it is a prop on EVERY pill"
  );
  assert.equal(result.sourceCrop, previous.sourceCrop, "sourceCrop reused");
});

test("editing one moment leaves the other pills' props untouched", () => {
  const previous = projectWith();
  const echo = JSON.parse(JSON.stringify(previous));
  echo.analysis.detectedMoments[1].endTime = 3.5;

  const result = reconcileProjectIdentity(previous, echo);
  assert.equal(
    result.analysis.detectedMoments[0],
    previous.analysis.detectedMoments[0],
    "the untouched edit keeps its identity, so its pill is skipped"
  );
  assert.notEqual(result.analysis.detectedMoments[1], previous.analysis.detectedMoments[1]);
  assert.equal(result.analysis.detectedMoments[1].endTime, 3.5);
  // The shared props must survive an unrelated moment edit, or all 40 pills
  // re-render anyway and the reconciliation above buys nothing.
  assert.equal(result.analysis.attentionCurve, previous.analysis.attentionCurve);
  assert.equal(result.sourceCrop, previous.sourceCrop);
});

test("the first snapshot is passed through untouched", () => {
  const first = projectWith();
  assert.equal(reconcileProjectIdentity(null, first), first);
});

test("a project with no analysis is handled without throwing", () => {
  const previous = projectWith({ analysis: undefined, sourceCrop: undefined });
  const echo = projectWith({ analysis: undefined, sourceCrop: undefined });
  assert.equal(reconcileProjectIdentity(previous, echo), echo);
});
