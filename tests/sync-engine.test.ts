/**
 * The sync engine, end to end, against in-memory stand-ins for SQLite and
 * Firestore.
 *
 * The fakes are deliberately NOT stubs: the local one runs the real
 * `mergeProjectDocs`, and the remote one runs the real `applyPatch` behind a
 * real compare-and-set. So these exercise the actual reconciliation logic — only
 * the storage and the network are simulated, and those are the two things a unit
 * test cannot honestly assert anyway.
 *
 * The scenarios are the ones from the brief: desktop→web, web→desktop,
 * simultaneous edits, offline edits, restart with pending writes, upload
 * failure, retry, deletion, and duplicate-operation prevention.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSyncEngine } from "@/lib/sync/engine";
import { mergeProjectDocs } from "@/lib/sync/merge";
import { createOpLog } from "@/lib/sync/op-log";
import { applyPatch } from "@/lib/platform/patch";
import type {
  ApplyRemoteResult,
  CommitResult,
  LocalSyncPort,
  RemoteDoc,
  RemoteProjectStore,
} from "@/lib/sync/ports";
import type { SyncOp, SyncProgress } from "@/lib/sync/types";

type Doc = Record<string, unknown>;

const UID = "uid-alice";
const DEVICE = "dev_desktop";

// ── the fake cloud ─────────────────────────────────────────────────────────

function fakeRemote() {
  const docs = new Map<string, { doc: Doc; rev: number; lastOpId?: string }>();
  const listeners = new Set<(doc: RemoteDoc) => void>();
  let failNextCommit: { message: string; code?: string } | null = null;
  const commits: string[] = [];

  const snapshot = (projectId: string): RemoteDoc => {
    const entry = docs.get(projectId);
    return {
      projectId,
      doc: entry ? entry.doc : null,
      rev: entry?.rev ?? 0,
      lastOpId: entry?.lastOpId,
      updatedAt: typeof entry?.doc.updatedAt === "number" ? entry.doc.updatedAt : undefined,
    };
  };

  const store: RemoteProjectStore = {
    async commit({ projectId, opId, baseRev, patch, deviceId }): Promise<CommitResult> {
      if (failNextCommit) {
        const err = Object.assign(new Error(failNextCommit.message), {
          code: failNextCommit.code,
        });
        failNextCommit = null;
        throw err;
      }
      commits.push(opId);
      const current = docs.get(projectId) ?? { doc: {}, rev: 0 };

      // Idempotency: this exact operation already landed.
      if (current.lastOpId === opId) return { status: "skipped", remote: snapshot(projectId) };
      // Compare-and-set.
      if (current.rev !== baseRev) return { status: "stale", remote: snapshot(projectId) };

      const next = applyPatch(current.doc, patch, 1_000);
      const entry = {
        doc: { ...next, rev: current.rev + 1, lastWriterDeviceId: deviceId, lastOpId: opId },
        rev: current.rev + 1,
        lastOpId: opId,
      };
      docs.set(projectId, entry);
      const snap = snapshot(projectId);
      for (const fn of [...listeners]) fn(snap);
      return { status: "applied", remote: snap };
    },

    async remove(projectId) {
      docs.delete(projectId);
      for (const fn of [...listeners]) fn({ projectId, doc: null, rev: 0 });
    },

    subscribeAll({ onDoc, onSynced }) {
      listeners.add(onDoc);
      for (const id of docs.keys()) onDoc(snapshot(id));
      onSynced?.();
      return () => listeners.delete(onDoc);
    },
  };

  return {
    store,
    commits,
    /** Simulate the web writing directly. */
    webWrite(projectId: string, patch: Doc) {
      const current = docs.get(projectId) ?? { doc: {}, rev: 0 };
      const next = applyPatch(current.doc, patch, 2_000);
      const entry = {
        doc: { ...next, rev: current.rev + 1, lastWriterDeviceId: "dev_web", lastOpId: `web_${current.rev + 1}` },
        rev: current.rev + 1,
        lastOpId: `web_${current.rev + 1}`,
      };
      docs.set(projectId, entry);
      for (const fn of [...listeners]) fn(snapshot(projectId));
    },
    read: (projectId: string) => docs.get(projectId),
    failNext(error: { message: string; code?: string }) {
      failNextCommit = error;
    },
  };
}

// ── the fake local mirror ──────────────────────────────────────────────────

interface Row {
  doc: Doc;
  baseDoc: Doc | null;
  baseRev: number;
  syncState: string;
  conflicts?: unknown[];
  lastError?: string;
}

function fakeLocal() {
  const rows = new Map<string, Row>();
  const outbox: SyncOp[] = [];
  const tombstoned = new Set<string>();
  const pendingDeletes = new Set<string>();
  let opSeq = 0;

  const pendingFor = (projectId: string) =>
    outbox.filter((o) => o.entityId === projectId && o.state !== "done").length;

  const port: LocalSyncPort = {
    async claim(ownerUid, nowMs, limit = 25, entities) {
      const due = outbox.filter(
        (o) =>
          o.ownerUid === ownerUid &&
          o.state === "queued" &&
          o.nextAttemptAt <= nowMs &&
          (!entities || entities.includes(o.entity)) &&
          // A conflicted record is never pushed until a human resolves it.
          rows.get(o.entityId)?.syncState !== "conflict"
      );
      const batch = due.slice(0, limit);
      for (const op of batch) op.state = "inflight";
      return batch.map((o) => ({ ...o }));
    },

    async ack(opId) {
      const index = outbox.findIndex((o) => o.opId === opId);
      if (index < 0) return;
      const [op] = outbox.splice(index, 1);
      const row = rows.get(op!.entityId);
      if (row && pendingFor(op!.entityId) === 0 && row.syncState !== "conflict") {
        row.syncState = "synced";
      }
    },

    async fail(opId, error) {
      const op = outbox.find((o) => o.opId === opId);
      if (!op) return;
      op.attempts += 1;
      op.state = "failed";
      op.lastError = error.message;
      const row = rows.get(op.entityId);
      if (row && row.syncState !== "conflict") {
        row.syncState = "failed";
        row.lastError = error.message;
      }
    },

    async supersede({ projectId, ownerUid, baseRev, doc, deviceId, now: nowMs }) {
      // Every queued operation for this project is folded into one that carries
      // the reconciled document — mirroring what the SQLite store does.
      for (let i = outbox.length - 1; i >= 0; i -= 1) {
        if (outbox[i]!.entityId === projectId) outbox.splice(i, 1);
      }
      outbox.push({
        opId: `op_${++opSeq}`,
        ownerUid,
        entity: "project",
        entityId: projectId,
        kind: "patch",
        payload: doc,
        baseRev,
        deviceId,
        createdAt: nowMs,
        attempts: 0,
        nextAttemptAt: 0,
        state: "queued",
      });
    },

    async applyRemote(remote, _ownerUid, _nowMs): Promise<ApplyRemoteResult> {
      if (tombstoned.has(remote.projectId)) {
        return { changed: false, ignoredTombstone: true, baseRev: remote.rev };
      }
      const row = rows.get(remote.projectId);

      if (remote.doc === null) {
        // Deleted remotely. Local edits still pending would be lost, so only
        // drop the row when nothing is outstanding for it.
        if (row && pendingFor(remote.projectId) === 0) rows.delete(remote.projectId);
        return { changed: true, baseRev: 0 };
      }

      if (!row) {
        rows.set(remote.projectId, {
          doc: remote.doc,
          baseDoc: remote.doc,
          baseRev: remote.rev,
          syncState: "synced",
        });
        return { changed: true, baseRev: remote.rev };
      }

      const { merged, conflicts, unchanged } = mergeProjectDocs({
        base: row.baseDoc,
        local: row.doc,
        remote: remote.doc,
      });
      row.baseDoc = remote.doc;
      row.baseRev = remote.rev;
      if (conflicts.length) {
        row.syncState = "conflict";
        row.conflicts = conflicts;
      } else {
        row.doc = merged;
        if (pendingFor(remote.projectId) === 0) row.syncState = "synced";
      }
      return {
        changed: !unchanged,
        conflicts: conflicts.length ? conflicts : undefined,
        baseRev: remote.rev,
        merged,
      };
    },

    async pendingDeletes() {
      return [...pendingDeletes].map((entityId) => ({ entityId }));
    },

    async markDeleteSynced(entityId) {
      pendingDeletes.delete(entityId);
    },

    async progress(ownerUid): Promise<SyncProgress> {
      const mine = outbox.filter((o) => o.ownerUid === ownerUid);
      return {
        active: mine.some((o) => o.state === "inflight"),
        pendingOps: mine.filter((o) => o.state !== "failed").length,
        failedOps: mine.filter((o) => o.state === "failed").length,
        conflictedRecords: [...rows.values()].filter((r) => r.syncState === "conflict").length,
        lastPullAt: null,
        online: true,
      };
    },

    async status(projectId) {
      const row = rows.get(projectId);
      if (!row) return null;
      return {
        entity: "project",
        entityId: projectId,
        state: row.syncState as SyncProgress["online"] extends never ? never : never as never,
        pendingOps: pendingFor(projectId),
      } as never;
    },
  };

  return {
    port,
    rows,
    outbox,
    /** The user edits a project on this machine. */
    edit(projectId: string, patch: Doc) {
      const row = rows.get(projectId);
      if (!row) throw new Error(`no local project ${projectId}`);
      row.doc = applyPatch(row.doc, patch, 3_000);
      if (row.syncState !== "conflict") row.syncState = "pending";
      outbox.push({
        opId: `op_${++opSeq}`,
        ownerUid: UID,
        entity: "project",
        entityId: projectId,
        kind: "patch",
        payload: patch,
        baseRev: row.baseRev,
        deviceId: DEVICE,
        createdAt: opSeq,
        attempts: 0,
        nextAttemptAt: 0,
        state: "queued",
      });
      return `op_${opSeq}`;
    },
    seed(projectId: string, doc: Doc, rev = 0) {
      rows.set(projectId, { doc, baseDoc: doc, baseRev: rev, syncState: "synced" });
    },
    deleteLocally(projectId: string) {
      rows.delete(projectId);
      tombstoned.add(projectId);
      pendingDeletes.add(projectId);
    },
  };
}

function harness(overrides: { batchSize?: number } = {}) {
  const localSide = fakeLocal();
  const remoteSide = fakeRemote();
  const errors: Error[] = [];
  const engine = createSyncEngine({
    local: localSide.port,
    remote: remoteSide.store,
    ownerUid: UID,
    now: () => 1_000,
    log: createOpLog(),
    onError: (e) => errors.push(e),
    batchSize: overrides.batchSize ?? 25,
  });
  return { local: localSide, remote: remoteSide, engine, errors };
}

// ── desktop → web ──────────────────────────────────────────────────────────

test("an edit made on the desktop reaches the cloud", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1", title: "Original" });
  h.local.edit("p1", { title: "Edited on desktop" });

  await h.engine.drain();

  assert.equal(h.remote.read("p1")!.doc.title, "Edited on desktop");
  assert.equal(h.local.outbox.length, 0, "the operation was acked and removed");
  assert.equal(h.local.rows.get("p1")!.syncState, "synced");
});

test("several edits arrive in the order they were made", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1" });
  h.local.edit("p1", { title: "First" });
  h.local.edit("p1", { status: "ready" });

  await h.engine.drain();

  const doc = h.remote.read("p1")!.doc;
  assert.equal(doc.title, "First");
  assert.equal(doc.status, "ready");
  assert.equal(h.remote.read("p1")!.rev, 2, "one revision per operation");
});

// ── web → desktop ──────────────────────────────────────────────────────────

test("an edit made on the web reaches the desktop", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1", title: "Original" });
  h.engine.start();

  h.remote.webWrite("p1", { title: "Edited on web" });
  await h.engine.drain();

  assert.equal(h.local.rows.get("p1")!.doc.title, "Edited on web");
  h.engine.stop();
});

test("a project created on the web appears locally", async () => {
  const h = harness();
  h.remote.webWrite("new-project", { id: "new-project", title: "From the website" });
  h.engine.start();
  await h.engine.drain();

  const row = h.local.rows.get("new-project");
  assert.ok(row, "the project was mirrored into the local library");
  assert.equal(row!.doc.title, "From the website");
  assert.equal(row!.syncState, "synced");
  h.engine.stop();
});

// ── simultaneous edits ─────────────────────────────────────────────────────

test("simultaneous edits to DIFFERENT things merge with no conflict", async () => {
  const h = harness();
  const base = {
    id: "p1",
    title: "Demo",
    analysis: {
      status: "complete",
      detectedMoments: [
        { id: "a", startTime: 1, endTime: 2 },
        { id: "b", startTime: 3, endTime: 4 },
      ],
      boringSections: [],
    },
  };
  h.local.seed("p1", structuredClone(base));
  h.remote.webWrite("p1", structuredClone(base)); // rev 1, both sides agree
  h.local.rows.get("p1")!.baseRev = 1;
  h.local.rows.get("p1")!.baseDoc = structuredClone(base);

  // Web trims moment b; desktop moves moment a.
  h.remote.webWrite("p1", {
    analysis: {
      detectedMoments: [
        { id: "a", startTime: 1, endTime: 2 },
        { id: "b", startTime: 3, endTime: 9 },
      ],
    },
  });
  h.local.edit("p1", {
    analysis: {
      detectedMoments: [
        { id: "a", startTime: 5, endTime: 6 },
        { id: "b", startTime: 3, endTime: 4 },
      ],
    },
  });

  h.engine.start();
  await h.engine.drain();
  await h.engine.drain();

  const row = h.local.rows.get("p1")!;
  assert.notEqual(row.syncState, "conflict", "different edits are not a conflict");
  const moments = (row.doc.analysis as Doc).detectedMoments as Doc[];
  const byId = new Map(moments.map((m) => [m.id, m]));
  assert.equal(byId.get("a")!.startTime, 5, "the desktop's edit survived");
  assert.equal(byId.get("b")!.endTime, 9, "the web's edit survived");
  h.engine.stop();
});

test("simultaneous edits to the SAME field stop the push and ask", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1", title: "Original" });
  h.remote.webWrite("p1", { id: "p1", title: "Original" });
  h.local.rows.get("p1")!.baseRev = 1;
  h.local.rows.get("p1")!.baseDoc = { id: "p1", title: "Original" };

  h.remote.webWrite("p1", { title: "Web wins?" });
  h.local.edit("p1", { title: "Desktop wins?" });

  await h.engine.drain();

  const row = h.local.rows.get("p1")!;
  assert.equal(row.syncState, "conflict");
  assert.equal(row.conflicts?.length, 1);
  assert.equal(
    h.remote.read("p1")!.doc.title,
    "Web wins?",
    "the cloud was NOT overwritten by the unresolved local value"
  );

  // And it stays that way: draining again must not push over the disagreement.
  await h.engine.drain();
  assert.equal(h.remote.read("p1")!.doc.title, "Web wins?");
});

test("a stale push reconciles instead of overwriting what landed", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1", title: "Original" });
  h.remote.webWrite("p1", { id: "p1", title: "Original" });
  h.local.rows.get("p1")!.baseRev = 1;
  h.local.rows.get("p1")!.baseDoc = { id: "p1", title: "Original" };

  // The web changes something ELSE while a desktop edit is queued.
  h.remote.webWrite("p1", { status: "ready" });
  h.local.edit("p1", { title: "Desktop title" });

  await h.engine.drain(); // first attempt: stale → reconcile + rebase
  await h.engine.drain(); // second: applies cleanly

  const doc = h.remote.read("p1")!.doc;
  assert.equal(doc.title, "Desktop title", "the desktop edit eventually landed");
  assert.equal(doc.status, "ready", "and did not clobber the web's change");
  assert.equal(h.local.outbox.length, 0);
});

// ── offline / reconnect ────────────────────────────────────────────────────

test("edits made offline queue up and flush on reconnect", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1" });
  h.engine.setOnline(false);

  h.local.edit("p1", { title: "Written on a plane" });
  await h.engine.drain();
  assert.equal(h.remote.read("p1"), undefined, "nothing was sent while offline");
  assert.equal(h.local.outbox.length, 1, "and nothing was lost");

  h.engine.setOnline(true);
  await h.engine.drain();
  assert.equal(h.remote.read("p1")!.doc.title, "Written on a plane");
});

test("going offline does not mark anything failed", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1" });
  h.engine.setOnline(false);
  h.local.edit("p1", { title: "Queued" });
  await h.engine.drain();

  assert.equal(h.local.rows.get("p1")!.syncState, "pending", "offline is not an error");
});

// ── failure + retry ────────────────────────────────────────────────────────

test("a failed push keeps the operation and records why", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1" });
  h.local.edit("p1", { title: "Will fail" });
  h.remote.failNext({ message: "network unreachable", code: "unavailable" });

  await h.engine.drain();

  assert.equal(h.local.outbox.length, 1, "the operation was NOT discarded");
  assert.equal(h.local.outbox[0]!.lastError, "network unreachable");
  assert.equal(h.local.rows.get("p1")!.lastError, "network unreachable");
});

test("a retried operation succeeds without duplicating the edit", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1", count: 0 });
  h.local.edit("p1", { title: "Once" });
  h.remote.failNext({ message: "blip", code: "unavailable" });

  await h.engine.drain(); // fails
  h.local.outbox[0]!.state = "queued"; // the retry timer re-arms it
  await h.engine.drain(); // succeeds

  assert.equal(h.remote.read("p1")!.doc.title, "Once");
  assert.equal(h.remote.read("p1")!.rev, 1, "exactly one revision — not applied twice");
});

// ── duplicate-operation prevention ─────────────────────────────────────────

test("an operation whose ack was lost is not applied twice", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1" });
  const opId = h.local.edit("p1", { title: "Only once" });

  await h.engine.drain();
  assert.equal(h.remote.read("p1")!.rev, 1);

  // The ack never reached us, so the same operation is queued again.
  h.local.outbox.push({
    opId,
    ownerUid: UID,
    entity: "project",
    entityId: "p1",
    kind: "patch",
    payload: { title: "Only once" },
    baseRev: 0,
    deviceId: DEVICE,
    createdAt: 99,
    attempts: 1,
    nextAttemptAt: 0,
    state: "queued",
  });
  await h.engine.drain();

  assert.equal(h.remote.read("p1")!.rev, 1, "the replay was recognised and skipped");
  assert.equal(h.local.outbox.length, 0, "and acked rather than retried forever");
});

test("our own write coming back down the listener is not re-applied", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1", title: "Original" });
  h.engine.start();

  h.local.edit("p1", { title: "Mine" });
  await h.engine.drain();

  const row = h.local.rows.get("p1")!;
  assert.equal(row.syncState, "synced", "the echo did not manufacture a conflict");
  assert.equal(row.doc.title, "Mine");
  h.engine.stop();
});

// ── deletion ───────────────────────────────────────────────────────────────

test("deleting locally removes the cloud copy", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1" });
  h.remote.webWrite("p1", { id: "p1" });
  h.local.deleteLocally("p1");

  await h.engine.drain();

  assert.equal(h.remote.read("p1"), undefined, "the cloud document is gone");
});

test("a deleted project is not resurrected by a late snapshot", async () => {
  const h = harness();
  h.local.seed("p1", { id: "p1", title: "Doomed" });
  h.remote.webWrite("p1", { id: "p1", title: "Doomed" });
  h.local.deleteLocally("p1");
  await h.engine.drain();

  // A snapshot from before the delete arrives afterwards.
  h.remote.webWrite("p1", { id: "p1", title: "Doomed" });
  h.engine.start();
  await h.engine.drain();

  assert.equal(
    h.local.rows.has("p1"),
    false,
    "the tombstone outlived the row and refused the resurrection"
  );
  h.engine.stop();
});

// ── batching ───────────────────────────────────────────────────────────────

test("a backlog larger than one batch drains completely", async () => {
  const h = harness({ batchSize: 2 });
  h.local.seed("p1", { id: "p1" });
  for (let i = 0; i < 5; i += 1) h.local.edit("p1", { [`f${i}`]: i });

  await h.engine.drain();

  assert.equal(h.local.outbox.length, 0, "the loop kept going past the first batch");
  // NOT one revision per operation: the second op in the batch finds the remote
  // has moved, and `supersede` folds every remaining queued op for the project
  // into a single write carrying the reconciled document. Fewer round trips for
  // the same result — so the assertion is about the DATA, not the revision count.
  const doc = h.remote.read("p1")!.doc;
  for (let i = 0; i < 5; i += 1) {
    assert.equal(doc[`f${i}`], i, `edit ${i} reached the cloud`);
  }
});
