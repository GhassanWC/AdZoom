/**
 * `applyRemote` and conflict resolution, against a REAL SQLite database.
 *
 * `tests/sync-engine.test.ts` proves the engine's control flow against an
 * in-memory mirror. This proves the SQLite implementation of that mirror agrees
 * with it — that the merge really lands in the row, that a conflicted record
 * really stops being claimable, and that a tombstone really outlives its row.
 * The two together are what make the engine tests meaningful.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UID_A,
  projectRow,
  remoteDoc,
  seedProject,
  workspace,
} from "./sync-harness.mts";

const docOf = (row: Record<string, unknown>) =>
  JSON.parse(String(row.doc)) as Record<string, unknown>;

test("a project that exists only in the cloud is mirrored locally", async () => {
  const ws = workspace();
  try {
    const result = await ws.store.applyRemote(
      remoteDoc("cloud-1", { id: "cloud-1", title: "From the web", userId: UID_A }, 3),
      UID_A,
      100
    );
    assert.equal(result.changed, true);

    const row = projectRow(ws, "cloud-1");
    assert.equal(row.title, "From the web");
    assert.equal(row.sync_state, "synced");
    assert.equal(row.base_rev, 3);
    assert.equal(row.cloud_project_id, "cloud-1", "the cloud id is also the local id");
  } finally {
    ws.cleanup();
  }
});

test("a remote change with no local edits fast-forwards", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.store.applyRemote(remoteDoc(id, { id, title: "Demo" }, 1), UID_A, 100);
    await ws.store.applyRemote(remoteDoc(id, { id, title: "Renamed on web" }, 2), UID_A, 200);

    const row = projectRow(ws, id);
    assert.equal(docOf(row).title, "Renamed on web");
    assert.equal(row.sync_state, "synced");
    assert.equal(row.base_rev, 2);
  } finally {
    ws.cleanup();
  }
});

test("a genuine disagreement marks the record conflict and keeps the local view", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.store.applyRemote(remoteDoc(id, { id, title: "Shared" }, 1), UID_A, 100);
    await ws.library.write(id, { title: "Desktop title" }, 150);

    const result = await ws.store.applyRemote(
      remoteDoc(id, { id, title: "Web title" }, 2),
      UID_A,
      200
    );
    assert.equal(result.conflicts?.length, 1);

    const row = projectRow(ws, id);
    assert.equal(row.sync_state, "conflict");
    assert.equal(
      docOf(row).title,
      "Desktop title",
      "the user keeps seeing their own work while they decide"
    );
    assert.ok(String(row.conflicts).includes("title"));
  } finally {
    ws.cleanup();
  }
});

test("a conflicted record is never handed out for pushing", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.store.applyRemote(remoteDoc(id, { id, title: "Shared" }, 1), UID_A, 100);
    await ws.library.write(id, { title: "Desktop title" }, 150);
    await ws.store.applyRemote(remoteDoc(id, { id, title: "Web title" }, 2), UID_A, 200);

    assert.equal(
      (await ws.store.claim(UID_A, 300)).length,
      0,
      "pushing over an unresolved disagreement is the one thing that must not happen"
    );
  } finally {
    ws.cleanup();
  }
});

test("independent edits on each side merge without asking", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    const base = {
      id,
      title: "Shared",
      analysis: {
        status: "complete",
        detectedMoments: [
          { id: "a", startTime: 1, endTime: 2 },
          { id: "b", startTime: 3, endTime: 4 },
        ],
        boringSections: [],
      },
    };
    await ws.store.applyRemote(remoteDoc(id, structuredClone(base), 1), UID_A, 100);

    // Desktop moves moment a.
    await ws.library.write(
      id,
      {
        analysis: {
          detectedMoments: [
            { id: "a", startTime: 5, endTime: 6 },
            { id: "b", startTime: 3, endTime: 4 },
          ],
        },
      },
      150
    );
    // The web trims moment b.
    const remote = structuredClone(base);
    (remote.analysis.detectedMoments as Record<string, unknown>[])[1]!.endTime = 9;
    const result = await ws.store.applyRemote(remoteDoc(id, remote, 2), UID_A, 200);

    assert.equal(result.conflicts, undefined, "different edits are not a conflict");
    const moments = (docOf(projectRow(ws, id)).analysis as Record<string, unknown>)
      .detectedMoments as Record<string, unknown>[];
    const byId = new Map(moments.map((m) => [m.id, m]));
    assert.equal(byId.get("a")!.startTime, 5, "the desktop edit survived");
    assert.equal(byId.get("b")!.endTime, 9, "the web edit survived");
  } finally {
    ws.cleanup();
  }
});

test("resolving a conflict queues the reconciled document", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.store.applyRemote(remoteDoc(id, { id, title: "Shared" }, 1), UID_A, 100);
    await ws.library.write(id, { title: "Desktop title" }, 150);
    await ws.store.applyRemote(remoteDoc(id, { id, title: "Web title" }, 2), UID_A, 200);

    await ws.store.resolveConflict({
      projectId: id,
      choices: { title: "remote" },
      ownerUid: UID_A,
      deviceId: "dev_test",
      now: 300,
    });

    const row = projectRow(ws, id);
    assert.equal(row.sync_state, "pending");
    assert.equal(row.conflicts, null, "the conflict is cleared once answered");
    assert.equal(docOf(row).title, "Web title");

    const ops = await ws.store.claim(UID_A, 400);
    assert.equal(ops.length, 1, "exactly one operation carries the resolution");
    assert.equal((ops[0]!.payload as { title: string }).title, "Web title");
    assert.equal(ops[0]!.baseRev, 2, "composed against the revision we last saw");
  } finally {
    ws.cleanup();
  }
});

test("supersede collapses queued work into one reconciled write", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "One" }, 100);
    await ws.library.write(id, { status: "ready" }, 101);
    assert.equal(await ws.store.pendingCount("project", id), 2);

    await ws.store.supersede({
      projectId: id,
      ownerUid: UID_A,
      baseRev: 7,
      doc: { id, title: "One", status: "ready", rev: 7, lastOpId: "op_old" },
      deviceId: "dev_test",
      now: 200,
    });

    const ops = await ws.store.claim(UID_A, 300);
    assert.equal(ops.length, 1, "two operations became one");
    assert.equal(ops[0]!.baseRev, 7);
    const payload = ops[0]!.payload as Record<string, unknown>;
    assert.equal(payload.title, "One");
    assert.equal(payload.status, "ready");
    assert.equal(
      "rev" in payload,
      false,
      "sync bookkeeping must not travel in the payload — it would write a stale revision back"
    );
    assert.equal("lastOpId" in payload, false);
  } finally {
    ws.cleanup();
  }
});

test("a remote delete removes a clean local mirror", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.store.applyRemote(remoteDoc(id, { id, title: "Demo" }, 1), UID_A, 100);
    await ws.store.applyRemote(remoteDoc(id, null, 0), UID_A, 200);

    assert.equal(projectRow(ws, id), undefined, "the mirror followed the cloud");
  } finally {
    ws.cleanup();
  }
});

test("a remote delete with unsent local edits is a conflict, not a deletion", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.store.applyRemote(remoteDoc(id, { id, title: "Demo" }, 1), UID_A, 100);
    await ws.library.write(id, { title: "Still working on this" }, 150);

    await ws.store.applyRemote(remoteDoc(id, null, 0), UID_A, 200);

    const row = projectRow(ws, id);
    assert.ok(row, "work the user can still see is not silently thrown away");
    assert.equal(row.sync_state, "conflict");
  } finally {
    ws.cleanup();
  }
});

test("a tombstoned project is not resurrected by a late snapshot", async () => {
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

    const result = await ws.store.applyRemote(
      remoteDoc(id, { id, title: "Back from the dead" }, 5),
      UID_A,
      200
    );
    assert.equal(result.ignoredTombstone, true);
    assert.equal(projectRow(ws, id), undefined);
  } finally {
    ws.cleanup();
  }
});

test("aggregate progress counts pending, failed and conflicted separately", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "One" }, 100);
    let progress = await ws.store.progress(UID_A);
    assert.equal(progress.pendingOps, 1);
    assert.equal(progress.failedOps, 0);

    const [op] = await ws.store.claim(UID_A, 100);
    await ws.store.fail(op!.opId, { message: "nope", code: "permission-denied" }, 200);
    progress = await ws.store.progress(UID_A);
    assert.equal(progress.failedOps, 1);

    await ws.store.setProjectSyncState({ projectId: id, state: "conflict", ownerUid: UID_A });
    progress = await ws.store.progress(UID_A);
    assert.equal(progress.conflictedRecords, 1);
  } finally {
    ws.cleanup();
  }
});

test("per-record status carries the reason a retry would need", async () => {
  const ws = workspace();
  try {
    const id = await seedProject(ws);
    await ws.library.write(id, { title: "One" }, 100);
    const [op] = await ws.store.claim(UID_A, 100);
    await ws.store.fail(
      op!.opId,
      { message: "Missing or insufficient permissions", code: "permission-denied" },
      200
    );

    const status = await ws.store.statusFor(id);
    assert.equal(status?.state, "failed");
    assert.equal(status?.lastError, "Missing or insufficient permissions");
    assert.equal(status?.pendingOps, 1, "still owed, so Retry has something to re-arm");
  } finally {
    ws.cleanup();
  }
});
