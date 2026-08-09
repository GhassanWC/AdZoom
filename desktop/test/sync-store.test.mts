/**
 * The durable outbox, against a REAL SQLite database.
 *
 * Everything here is a property that only holds if the SQL is right: that an
 * edit and its intent to sync are written in one transaction, that a restart
 * finds the queue exactly as it left it, and that one account's queued work can
 * never be drained under another account's credentials.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_ATTEMPTS } from "../../src/lib/sync/backoff.ts";
import { reclaimStale } from "../src/main/sync-store.ts";
import {
  UID_A,
  UID_B,
  projectRow,
  seedProject,
  workspace,
} from "./sync-harness.mts";


// ── the durability rule ────────────────────────────────────────────────────

test("an edit and its sync intent are written together", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "Renamed" }, 100);

    const ops = await ws.store.claim(UID_A, 100);
    assert.equal(ops.length, 1, "exactly one operation per write");
    assert.equal(ops[0]!.entityId, id);
    assert.equal(ops[0]!.kind, "patch");
    assert.deepEqual(ops[0]!.payload, { title: "Renamed" });
    assert.equal(projectRow(ws, id).sync_state, "pending");
  } finally {
    ws.cleanup();
  }
});

test("pending changes survive a restart", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "Offline edit" }, 100);
    await ws.library.write(id, { status: "ready" }, 101);

    ws.restart();

    const ops = await ws.store.claim(UID_A, 200);
    assert.equal(ops.length, 2, "both edits are still queued after a relaunch");
    assert.deepEqual(
      ops.map((o) => o.payload),
      [{ title: "Offline edit" }, { status: "ready" }],
      "and in the order they were made"
    );
    assert.equal(projectRow(ws, id).sync_state, "pending");
  } finally {
    ws.cleanup();
  }
});

test("a write while signed out queues nothing and claims no owner", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    ws.signInAs(null);
    await ws.library.write(id, { title: "Local only" }, 100);

    assert.equal((await ws.store.claim(UID_A, 100)).length, 0);
    assert.equal(projectRow(ws, id).owner_uid, null);
  } finally {
    ws.cleanup();
  }
});

// ── authentication isolation ───────────────────────────────────────────────

test("one account never drains another account's queued work", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "Alice's edit" }, 100);

    // Alice signs out, Bob signs in on the same machine.
    ws.signInAs(UID_B);
    assert.equal(
      (await ws.store.claim(UID_B, 100)).length,
      0,
      "Bob must not see Alice's pending write"
    );

    // And Alice's work is still there, untouched, for when she returns.
    assert.equal((await ws.store.claim(UID_A, 100)).length, 1);
  } finally {
    ws.cleanup();
  }
});

// ── claiming ───────────────────────────────────────────────────────────────

test("a claimed operation is not handed out twice", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "One" }, 100);

    assert.equal((await ws.store.claim(UID_A, 100)).length, 1);
    assert.equal((await ws.store.claim(UID_A, 100)).length, 0, "already inflight");
  } finally {
    ws.cleanup();
  }
});

test("operations stranded inflight by a crash are reclaimed at startup", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "One" }, 100);
    await ws.store.claim(UID_A, 100); // now inflight
    ws.restart(); // the renderer died mid-push

    assert.equal(await reclaimStale(ws.handle.db), 1);
    assert.equal((await ws.store.claim(UID_A, 200)).length, 1, "back in the queue");
  } finally {
    ws.cleanup();
  }
});

// ── settling ───────────────────────────────────────────────────────────────

test("a record is only 'synced' once nothing is outstanding for it", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "One" }, 100);
    await ws.library.write(id, { status: "ready" }, 101);
    const ops = await ws.store.claim(UID_A, 100);

    await ws.store.ack(ops[0]!.opId, 200);
    assert.equal(
      projectRow(ws, id).sync_state,
      "pending",
      "one of two acked is not up to date"
    );

    await ws.store.ack(ops[1]!.opId, 201);
    assert.equal(projectRow(ws, id).sync_state, "synced");
    assert.equal(projectRow(ws, id).last_synced_at, 201);
  } finally {
    ws.cleanup();
  }
});

test("a transient failure stays pending and keeps its reason", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "One" }, 100);
    const [op] = await ws.store.claim(UID_A, 100);

    await ws.store.fail(op!.opId, { message: "network down", code: "unavailable" }, 500);
    const row = projectRow(ws, id);
    assert.equal(row.sync_state, "pending", "a retryable error is not a broken project");
    assert.equal(row.last_error, "network down");
  } finally {
    ws.cleanup();
  }
});

test("a permanent failure parks the record as failed with a usable reason", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "One" }, 100);
    const [op] = await ws.store.claim(UID_A, 100);

    await ws.store.fail(
      op!.opId,
      { message: "Missing or insufficient permissions", code: "permission-denied" },
      500
    );
    const row = projectRow(ws, id);
    assert.equal(row.sync_state, "failed");
    assert.equal(row.last_error, "Missing or insufficient permissions");
    assert.equal(
      (await ws.store.claim(UID_A, 10_000_000)).length,
      0,
      "parked, not retried on a timer"
    );
    assert.equal(await ws.store.pendingCount("project", id), 1, "but NOT discarded");
  } finally {
    ws.cleanup();
  }
});

test("retry re-arms a parked operation", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "One" }, 100);
    const [op] = await ws.store.claim(UID_A, 100);
    await ws.store.fail(op!.opId, { message: "nope", code: "permission-denied" }, 500);

    assert.equal(await ws.store.retry("project", id, 600), 1);
    assert.equal(projectRow(ws, id).sync_state, "pending");
    assert.equal((await ws.store.claim(UID_A, 600)).length, 1, "claimable again");
  } finally {
    ws.cleanup();
  }
});

test("failure keeps retrying up to the ladder, then parks", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "One" }, 100);

    let now = 100;
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const ops = await ws.store.claim(UID_A, now);
      if (ops.length === 0) break;
      await ws.store.fail(ops[0]!.opId, { message: "flaky", code: "unavailable" }, now);
      now += 10 * 60_000; // well past any backoff
    }
    assert.equal(projectRow(ws, id).sync_state, "failed");
  } finally {
    ws.cleanup();
  }
});

// ── conflicts are sticky ───────────────────────────────────────────────────

test("a local edit does not clear an unresolved conflict", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.store.setProjectSyncState({ projectId: id, state: "conflict" });
    await ws.library.write(id, { title: "Kept editing" }, 100);

    assert.equal(
      projectRow(ws, id).sync_state,
      "conflict",
      "editing is allowed, but the record still needs resolving"
    );
  } finally {
    ws.cleanup();
  }
});

test("acking does not silently resolve a conflicted record", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "One" }, 100);
    const [op] = await ws.store.claim(UID_A, 100);
    await ws.store.setProjectSyncState({ projectId: id, state: "conflict" });

    await ws.store.ack(op!.opId, 200);
    assert.equal(projectRow(ws, id).sync_state, "conflict");
  } finally {
    ws.cleanup();
  }
});

// ── tombstones ─────────────────────────────────────────────────────────────

test("a deletion outlives the row it deleted", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.store.addTombstone({
      entity: "project",
      entityId: id,
      ownerUid: UID_A,
      deviceId: "dev_test",
      now: 100,
    });
    await ws.library.remove(id);
    ws.restart();

    assert.equal(await ws.store.isTombstoned("project", id), true);
    const pending = await ws.store.unsyncedTombstones(UID_A);
    assert.equal(pending.length, 1, "the delete is still owed to the cloud after a restart");

    await ws.store.markTombstoneSynced("project", id);
    assert.equal((await ws.store.unsyncedTombstones(UID_A)).length, 0);
    assert.equal(
      await ws.store.isTombstoned("project", id),
      true,
      "and it stays known, so a late pull cannot resurrect the project"
    );
  } finally {
    ws.cleanup();
  }
});

// ── device identity ────────────────────────────────────────────────────────

test("the device id is minted once and survives restarts", async () => {
  const ws = workspace();
  try {
    const first = await ws.store.deviceId();
    assert.ok(first.startsWith("dev_"));
    assert.equal(await ws.store.deviceId(), first, "stable within a session");
    ws.restart();
    assert.equal(await ws.store.deviceId(), first, "and across them");
  } finally {
    ws.cleanup();
  }
});
