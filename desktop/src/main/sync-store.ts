/**
 * The durable half of sync: the outbox, the tombstones and the per-record state,
 * all in SQLite and all in the main process.
 *
 * The network half lives in the renderer (it holds the authenticated Firebase
 * session); this module never touches Firestore. The split is deliberate — one
 * Firebase client, one auth session, and the queue survives the renderer being
 * reloaded, crashed or closed.
 *
 * THE DURABILITY RULE
 * -------------------
 * An operation is enqueued in the SAME SQLite transaction as the document change
 * it describes (see `library.write`). There is no instant at which an edit is on
 * disk but the intent to sync it is not, which is what makes "pending changes
 * survive restart" a property of the schema rather than a hope about timing.
 *
 * An operation leaves the outbox ONLY when Firestore has acknowledged it.
 * Everything else — a crash, a lost ack, a dead network — leaves the row in
 * place to be retried, and the `opId` makes that retry safe.
 */
import { and, asc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { decideRetry, rearm } from "@/lib/sync/backoff";
import type {
  ConflictChoice,
  FieldConflict,
  SyncEntity,
  SyncOp,
  SyncOpKind,
  SyncProgress,
  SyncState,
  SyncStatus,
} from "@/lib/sync/types";
import { newDeviceId, newOpId } from "@/lib/sync/revision";
import { applyConflictChoices, mergeProjectDocs } from "@/lib/sync/merge";
import type { ApplyRemoteResult, RemoteDoc } from "@/lib/sync/ports";
import type { LocalDb } from "./db/client";
import { appState, projects, syncOutbox, tombstones } from "./db/schema";

/** How many operations one drain pass claims. Bounded so a huge backlog still
 *  makes visible progress rather than one enormous stall. */
export const CLAIM_BATCH = 25;

const DEVICE_ID_KEY = "sync.deviceId";

export interface EnqueueInput {
  ownerUid: string;
  entity: SyncEntity;
  entityId: string;
  kind: SyncOpKind;
  payload: Record<string, unknown>;
  baseRev: number;
  opId: string;
  deviceId: string;
  now: number;
}

export interface SyncStore {
  /** This installation's stable id, minted on first use. */
  deviceId(): Promise<string>;
  enqueue(input: EnqueueInput): Promise<void>;
  /**
   * Take up to `limit` due operations for `ownerUid` and mark them inflight.
   * Filtering by uid here is the authentication isolation boundary.
   */
  claim(ownerUid: string, now: number, limit?: number, entities?: string[]): Promise<SyncOp[]>;
  /**
   * Replace every queued operation for a project with ONE carrying the
   * reconciled document. See `LocalSyncPort.supersede` for why a stale patch
   * must not simply be replayed.
   */
  supersede(args: {
    projectId: string;
    ownerUid: string;
    baseRev: number;
    doc: Record<string, unknown>;
    deviceId: string;
    now: number;
  }): Promise<void>;
  /** Fold a remote document into the local mirror (three-way merge). */
  applyRemote(
    remote: RemoteDoc,
    ownerUid: string,
    now: number
  ): Promise<ApplyRemoteResult>;
  /** Apply a human's conflict decisions and queue the result. */
  resolveConflict(args: {
    projectId: string;
    choices: Record<string, ConflictChoice>;
    ownerUid: string;
    deviceId: string;
    now: number;
  }): Promise<void>;
  progress(ownerUid: string): Promise<SyncProgress>;
  statusFor(projectId: string): Promise<SyncStatus | null>;
  /** The operation landed. Remove it and settle the record's state. */
  ack(opId: string, now: number): Promise<void>;
  /** The operation failed. Reschedule or park it, keeping the reason. */
  fail(opId: string, error: { message: string; code?: string }, now: number): Promise<void>;
  /** Re-arm every parked operation for a record (the user pressed Retry). */
  retry(entity: SyncEntity, entityId: string, now: number): Promise<number>;
  /** Anything still queued or inflight for this record? */
  pendingCount(entity: SyncEntity, entityId: string): Promise<number>;
  setProjectSyncState(input: {
    projectId: string;
    state: SyncState;
    lastError?: string | null;
    conflicts?: FieldConflict[] | null;
    lastSyncedAt?: number;
    baseDoc?: Record<string, unknown>;
    baseRev?: number;
    remoteUpdatedAt?: number;
    ownerUid?: string;
  }): Promise<void>;
  /** Record a deletion so it survives the row it deleted. */
  addTombstone(input: {
    entity: SyncEntity;
    entityId: string;
    ownerUid: string | null;
    deviceId: string;
    now: number;
  }): Promise<void>;
  unsyncedTombstones(ownerUid: string): Promise<
    { entity: string; entityId: string; deletedAt: number }[]
  >;
  markTombstoneSynced(entity: SyncEntity, entityId: string): Promise<void>;
  /** Was this entity deleted locally? Stops a pull resurrecting it. */
  isTombstoned(entity: SyncEntity, entityId: string): Promise<boolean>;
}

export function createSyncStore(db: LocalDb): SyncStore {
  return {
    async deviceId() {
      const rows = await db
        .select()
        .from(appState)
        .where(eq(appState.key, DEVICE_ID_KEY))
        .limit(1);
      const existing = rows[0]?.value;
      if (existing) return existing;
      const id = newDeviceId();
      await db.insert(appState).values({ key: DEVICE_ID_KEY, value: id, updatedAt: Date.now() });
      return id;
    },

    async enqueue(input) {
      await db.insert(syncOutbox).values({
        opId: input.opId,
        ownerUid: input.ownerUid,
        entity: input.entity,
        entityId: input.entityId,
        kind: input.kind,
        payload: input.payload,
        baseRev: input.baseRev,
        deviceId: input.deviceId,
        createdAt: input.now,
        attempts: 0,
        nextAttemptAt: 0,
        state: "queued",
      });
    },

    async claim(ownerUid, now, limit = CLAIM_BATCH, entities) {
      // `inflight` rows are NOT re-claimed: a renderer reload leaves them
      // stranded, which `reclaimStale` (below) recovers on startup rather than
      // this hot path guessing whether a peer is still working on them.
      const filters = [
        eq(syncOutbox.ownerUid, ownerUid),
        eq(syncOutbox.state, "queued"),
        lte(syncOutbox.nextAttemptAt, now),
      ];
      if (entities?.length) filters.push(inArray(syncOutbox.entity, entities));

      const candidates = await db
        .select()
        .from(syncOutbox)
        .where(and(...filters))
        // FIFO per record: a patch composed against rev N must not be sent
        // after one composed against rev N+1.
        .orderBy(asc(syncOutbox.createdAt))
        .limit(limit * 2);

      // A conflicted record is NEVER pushed. Filtered here rather than in SQL
      // because the join is only meaningful for project rows, and the outbox
      // also carries media/export work that has no project state.
      const conflicted = new Set(
        (
          await db
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.syncState, "conflict"))
        ).map((r) => r.id)
      );
      const due = candidates
        .filter((r) => !(r.entity === "project" && conflicted.has(r.entityId)))
        .slice(0, limit);

      if (due.length === 0) return [];
      const ids = due.map((r) => r.opId);
      await db
        .update(syncOutbox)
        .set({ state: "inflight" })
        .where(inArray(syncOutbox.opId, ids));

      return due.map(
        (r): SyncOp => ({
          opId: r.opId,
          ownerUid: r.ownerUid,
          entity: r.entity as SyncEntity,
          entityId: r.entityId,
          kind: r.kind as SyncOpKind,
          payload: r.payload,
          baseRev: r.baseRev,
          deviceId: r.deviceId,
          createdAt: r.createdAt,
          attempts: r.attempts,
          nextAttemptAt: r.nextAttemptAt,
          state: "inflight",
          lastError: r.lastError ?? undefined,
        })
      );
    },

    async ack(opId, now) {
      const rows = await db.select().from(syncOutbox).where(eq(syncOutbox.opId, opId)).limit(1);
      const row = rows[0];
      await db.delete(syncOutbox).where(eq(syncOutbox.opId, opId));
      if (!row || row.entity !== "project") return;

      // The record is only `synced` once NOTHING else is outstanding for it —
      // a drain that acks op 1 of 3 must not claim the project is up to date.
      const remaining = await countPending(db, "project", row.entityId);
      if (remaining === 0) {
        await db
          .update(projects)
          .set({ syncState: "synced", lastSyncedAt: now, lastError: null })
          .where(and(eq(projects.id, row.entityId), ne(projects.syncState, "conflict")));
      }
    },

    async fail(opId, error, now) {
      const rows = await db.select().from(syncOutbox).where(eq(syncOutbox.opId, opId)).limit(1);
      const row = rows[0];
      if (!row) return;

      const decision = decideRetry({
        attempts: row.attempts,
        now,
        message: error.message,
        code: error.code,
      });
      await db
        .update(syncOutbox)
        .set({
          state: decision.state,
          attempts: decision.attempts,
          nextAttemptAt: decision.nextAttemptAt,
          lastError: decision.lastError,
        })
        .where(eq(syncOutbox.opId, opId));

      if (row.entity !== "project") return;
      // A parked operation is a visible failure; a rescheduled one is still just
      // "pending" as far as the user is concerned, and must not look broken.
      await db
        .update(projects)
        .set({
          syncState: decision.state === "failed" ? "failed" : "pending",
          lastError: decision.lastError,
        })
        .where(and(eq(projects.id, row.entityId), ne(projects.syncState, "conflict")));
    },

    async retry(entity, entityId, now) {
      const armed = rearm(now);
      const rows = await db
        .select({ opId: syncOutbox.opId })
        .from(syncOutbox)
        .where(and(eq(syncOutbox.entity, entity), eq(syncOutbox.entityId, entityId)));
      if (rows.length === 0) return 0;
      await db
        .update(syncOutbox)
        .set({
          state: armed.state,
          attempts: armed.attempts,
          nextAttemptAt: armed.nextAttemptAt,
        })
        .where(and(eq(syncOutbox.entity, entity), eq(syncOutbox.entityId, entityId)));
      if (entity === "project") {
        await db
          .update(projects)
          .set({ syncState: "pending", lastError: null })
          .where(eq(projects.id, entityId));
      }
      return rows.length;
    },

    pendingCount(entity, entityId) {
      return countPending(db, entity, entityId);
    },

    async supersede({ projectId, ownerUid, baseRev, doc, deviceId, now }) {
      // The reconciled document already contains every queued local change, so
      // the operations it replaces are redundant, not lost.
      await db
        .delete(syncOutbox)
        .where(and(eq(syncOutbox.entity, "project"), eq(syncOutbox.entityId, projectId)));
      await db.insert(syncOutbox).values({
        opId: newOpId(),
        ownerUid,
        entity: "project",
        entityId: projectId,
        kind: "patch",
        payload: stripSyncKeys(doc),
        baseRev,
        deviceId,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
        state: "queued",
      });
      await db
        .update(projects)
        .set({ baseRev })
        .where(eq(projects.id, projectId));
    },

    async applyRemote(remote, ownerUid, now) {
      // A project deleted here must not come back because a snapshot from
      // before the delete arrived afterwards.
      const tombstoned = await db
        .select({ id: tombstones.id })
        .from(tombstones)
        .where(and(eq(tombstones.entity, "project"), eq(tombstones.entityId, remote.projectId)))
        .limit(1);
      if (tombstoned.length > 0) {
        return { changed: false, ignoredTombstone: true, baseRev: remote.rev };
      }

      const row = await findMirrorRow(db, remote.projectId);

      // ── Deleted remotely ───────────────────────────────────────────────
      if (remote.doc === null) {
        if (!row) return { changed: false, baseRev: 0 };
        const pending = await countPending(db, "project", row.id);
        if (pending > 0) {
          // Deleted on one side, edited on the other. That is a real
          // disagreement, and dropping the row would discard work the user can
          // still see on their screen.
          await db
            .update(projects)
            .set({
              syncState: "conflict",
              conflicts: [
                {
                  path: "<document>",
                  base: null,
                  local: "edited here",
                  remote: "deleted on the web",
                },
              ],
            })
            .where(eq(projects.id, row.id));
          return { changed: true, baseRev: 0, conflicts: [] as FieldConflict[] };
        }
        await db.delete(projects).where(eq(projects.id, row.id));
        return { changed: true, baseRev: 0 };
      }

      // ── New to this machine ────────────────────────────────────────────
      if (!row) {
        const doc = remote.doc;
        const title = typeof doc.title === "string" && doc.title.trim() ? doc.title : "Untitled";
        await db.insert(projects).values({
          // The cloud id IS the local id for a mirrored project — one identity
          // across both stores is what keeps deep links and exports coherent.
          id: remote.projectId,
          title,
          mediaId: null,
          doc,
          createdAt: numberOr(doc.createdAt, now),
          updatedAt: numberOr(doc.updatedAt, now),
          revision: 0,
          cloudProjectId: remote.projectId,
          ownerUid,
          syncState: "synced",
          baseDoc: doc,
          baseRev: remote.rev,
          remoteUpdatedAt: remote.updatedAt ?? null,
          lastSyncedAt: now,
        });
        return { changed: true, baseRev: remote.rev, merged: doc };
      }

      // ── Reconcile ──────────────────────────────────────────────────────
      const { merged, conflicts, unchanged } = mergeProjectDocs({
        base: row.baseDoc ?? null,
        local: row.doc,
        remote: remote.doc,
      });

      const patch: Record<string, unknown> = {
        baseDoc: remote.doc,
        baseRev: remote.rev,
        remoteUpdatedAt: remote.updatedAt ?? null,
        ownerUid,
      };

      if (conflicts.length > 0) {
        patch.syncState = "conflict";
        patch.conflicts = conflicts;
        // The merged document (local values at the contested paths) is still
        // stored, so the user keeps seeing their own work while they decide.
        patch.doc = withIdentity(merged, row.id, remote.doc);
        await db.update(projects).set(patch).where(eq(projects.id, row.id));
        return { changed: true, conflicts, baseRev: remote.rev, merged };
      }

      patch.doc = withIdentity(merged, row.id, remote.doc);
      patch.updatedAt = numberOr(merged.updatedAt, now);
      const pending = await countPending(db, "project", row.id);
      if (pending === 0) {
        patch.syncState = "synced";
        patch.lastSyncedAt = now;
        patch.lastError = null;
      }
      patch.conflicts = null;
      await db.update(projects).set(patch).where(eq(projects.id, row.id));
      return { changed: !unchanged, baseRev: remote.rev, merged };
    },

    async resolveConflict({ projectId, choices, ownerUid, deviceId, now }) {
      const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      const row = rows[0];
      if (!row) return;
      const conflicts = (row.conflicts ?? []) as FieldConflict[];
      const resolved = applyConflictChoices(row.doc, conflicts, choices);

      await db
        .update(projects)
        .set({
          doc: withIdentity(resolved, row.id, row.doc),
          conflicts: null,
          syncState: "pending",
          lastError: null,
          revision: row.revision + 1,
        })
        .where(eq(projects.id, projectId));

      // The resolution is a normal local change: queue the whole reconciled
      // document against the base we last saw, and let the engine push it.
      await this.supersede({
        projectId,
        ownerUid,
        baseRev: row.baseRev,
        doc: resolved,
        deviceId,
        now,
      });
    },

    async progress(ownerUid) {
      const ops = await db
        .select({ state: syncOutbox.state })
        .from(syncOutbox)
        .where(eq(syncOutbox.ownerUid, ownerUid));
      const conflicted = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.ownerUid, ownerUid), eq(projects.syncState, "conflict")));
      return {
        active: ops.some((o) => o.state === "inflight"),
        pendingOps: ops.filter((o) => o.state !== "failed").length,
        failedOps: ops.filter((o) => o.state === "failed").length,
        conflictedRecords: conflicted.length,
        lastPullAt: null,
        online: true,
      };
    },

    async statusFor(projectId) {
      const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        entity: "project",
        entityId: projectId,
        state: row.syncState as SyncState,
        pendingOps: await countPending(db, "project", projectId),
        lastSyncedAt: row.lastSyncedAt ?? undefined,
        lastError: row.lastError ?? undefined,
        conflicts: (row.conflicts ?? undefined) as FieldConflict[] | undefined,
      };
    },

    async setProjectSyncState(input) {
      const patch: Record<string, unknown> = { syncState: input.state };
      if (input.lastError !== undefined) patch.lastError = input.lastError;
      if (input.conflicts !== undefined) patch.conflicts = input.conflicts;
      if (input.lastSyncedAt !== undefined) patch.lastSyncedAt = input.lastSyncedAt;
      if (input.baseDoc !== undefined) patch.baseDoc = input.baseDoc;
      if (input.baseRev !== undefined) patch.baseRev = input.baseRev;
      if (input.remoteUpdatedAt !== undefined) patch.remoteUpdatedAt = input.remoteUpdatedAt;
      if (input.ownerUid !== undefined) patch.ownerUid = input.ownerUid;
      await db.update(projects).set(patch).where(eq(projects.id, input.projectId));
    },

    async addTombstone(input) {
      await db.insert(tombstones).values({
        entity: input.entity,
        entityId: input.entityId,
        ownerUid: input.ownerUid,
        deletedAt: input.now,
        deviceId: input.deviceId,
        synced: false,
      });
    },

    async unsyncedTombstones(ownerUid) {
      const rows = await db
        .select()
        .from(tombstones)
        .where(and(eq(tombstones.ownerUid, ownerUid), eq(tombstones.synced, false)));
      return rows.map((r) => ({
        entity: r.entity,
        entityId: r.entityId,
        deletedAt: r.deletedAt,
      }));
    },

    async markTombstoneSynced(entity, entityId) {
      await db
        .update(tombstones)
        .set({ synced: true })
        .where(and(eq(tombstones.entity, entity), eq(tombstones.entityId, entityId)));
    },

    async isTombstoned(entity, entityId) {
      const rows = await db
        .select({ id: tombstones.id })
        .from(tombstones)
        .where(and(eq(tombstones.entity, entity), eq(tombstones.entityId, entityId)))
        .limit(1);
      return rows.length > 0;
    },
  };
}

async function countPending(db: LocalDb, entity: string, entityId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(syncOutbox)
    .where(and(eq(syncOutbox.entity, entity), eq(syncOutbox.entityId, entityId)));
  return Number(rows[0]?.n ?? 0);
}

/**
 * Return operations stranded `inflight` by a crash to the queue.
 *
 * Called once at startup, never during a drain: `inflight` means "a renderer is
 * working on this right now", and reclaiming it mid-flight is how the same
 * operation gets sent twice. At startup there is no renderer, so anything still
 * inflight is by definition abandoned. (Sending it twice would in fact be
 * harmless — that is what `opId` is for — but the queue should not create work
 * it knows is redundant.)
 */
export async function reclaimStale(db: LocalDb): Promise<number> {
  const rows = await db
    .select({ opId: syncOutbox.opId })
    .from(syncOutbox)
    .where(eq(syncOutbox.state, "inflight"));
  if (rows.length === 0) return 0;
  await db
    .update(syncOutbox)
    .set({ state: "queued", nextAttemptAt: 0 })
    .where(eq(syncOutbox.state, "inflight"));
  return rows.length;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** The local row mirroring a cloud project, by either identity. */
async function findMirrorRow(db: LocalDb, cloudProjectId: string) {
  const byLink = await db
    .select()
    .from(projects)
    .where(eq(projects.cloudProjectId, cloudProjectId))
    .limit(1);
  if (byLink[0]) return byLink[0];
  // A mirrored project uses the cloud id as its own, so this is the common path
  // after the first sync; the link lookup above covers projects that started
  // life locally and were promoted.
  const byId = await db.select().from(projects).where(eq(projects.id, cloudProjectId)).limit(1);
  return byId[0] ?? null;
}

/**
 * Sync bookkeeping never travels in a patch payload.
 *
 * `rev` / `lastOpId` / `lastWriterDeviceId` are stamped by the commit itself. If
 * a superseding payload carried the values it was merged FROM, it would write a
 * stale revision back over the one the transaction just set — turning every
 * subsequent compare-and-set into a false conflict.
 */
function stripSyncKeys(doc: Record<string, unknown>): Record<string, unknown> {
  const { rev, lastOpId, lastWriterDeviceId, ...rest } = doc;
  void rev;
  void lastOpId;
  void lastWriterDeviceId;
  return rest;
}

/**
 * A merged document must keep the row's own identity.
 *
 * `id` and `userId` are structural: a merge that adopted the remote's `userId`
 * would repoint the row at another owner, and one that adopted a different `id`
 * would break every link into it.
 */
function withIdentity(
  merged: Record<string, unknown>,
  id: string,
  remote: Record<string, unknown>
): Record<string, unknown> {
  return { ...merged, id, userId: remote.userId ?? merged.userId };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
