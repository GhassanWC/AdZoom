/**
 * The sync engine: pull remote changes into the local mirror, push local changes
 * to the cloud, and never let either one silently win.
 *
 * It runs in the RENDERER, because that is where the authenticated Firebase
 * session lives. It owns no data — the durable queue is in SQLite behind
 * `LocalSyncPort`, and the documents are in Firestore behind
 * `RemoteProjectStore` — so a crash here loses nothing but momentum.
 *
 * THE PUSH LOOP
 * -------------
 * A queued operation carries the patch AND the revision it was composed against.
 * The commit is a compare-and-set, so exactly three things can come back:
 *
 *   applied — the remote was where we left it. Ack.
 *   skipped — this exact operation is already on the document (a retry whose
 *             first attempt committed but whose ack was lost). Ack.
 *   stale   — somebody else wrote first.
 *
 * `stale` is NOT a failure and NOT a conflict. The engine folds the remote
 * document into the local mirror (a three-way merge) and then pushes the
 * RECONCILED DOCUMENT — not the original patch.
 *
 * That distinction is the whole correctness argument. Replaying the patch looks
 * equivalent and is not: a patch is a snapshot of intent against an OLD
 * document, and several fields (`analysis.detectedMoments` above all) are
 * arrays, which merge semantics replace wholesale. Replaying one on top of a
 * newer revision therefore silently deletes whatever the other device did to
 * that array — the exact failure this design exists to prevent. The merge has
 * already folded every local change into one document, so that document is the
 * complete local intent reconciled with the remote, and that is what gets sent.
 *
 * Only when the merge finds a genuine disagreement does the record become
 * `conflict`, and a conflicted record is never pushed again until a human
 * resolves it.
 *
 * OFFLINE
 * -------
 * Offline is not an error state here. The queue simply stops being drained and
 * keeps accepting work; reconnecting resumes it. Nothing is discarded, nothing
 * is retried in a tight loop, and the UI reports `pending`, not `failed`.
 */
import { createOpLog, shouldApplyRemote, type OpLog } from "./op-log";
import type { LocalSyncPort, RemoteDoc, RemoteProjectStore } from "./ports";
import type { SyncProgress } from "./types";

/** Upper bound on consecutive drain passes in one call — see `drain`. */
const MAX_DRAIN_PASSES = 10;

export interface SyncEngineOptions {
  local: LocalSyncPort;
  remote: RemoteProjectStore;
  /** The signed-in account. The engine is inert without one. */
  ownerUid: string;
  now?: () => number;
  /** Injected so tests don't wait for real frames. */
  log?: OpLog;
  /** Called whenever the engine's aggregate state may have changed. */
  onProgress?: (progress: SyncProgress) => void;
  /** Surfaced for diagnostics; the engine itself never throws to its caller. */
  onError?: (error: Error) => void;
  /** Cap on operations per drain pass. */
  batchSize?: number;
}

export interface SyncEngine {
  /** Begin pulling. Safe to call once; returns a stop function. */
  start(): void;
  stop(): void;
  /** Drain the outbox once. Resolves when the pass is done. */
  drain(): Promise<void>;
  /** Tell the engine the network came back (or went away). */
  setOnline(online: boolean): void;
  isOnline(): boolean;
  /** Current aggregate state. */
  progress(): Promise<SyncProgress>;
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { local, remote, ownerUid } = options;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? createOpLog();
  const batchSize = options.batchSize ?? 25;

  let online = true;
  let running = false;
  let unsubscribe: (() => void) | null = null;
  /** Serialises drains: two concurrent passes would claim each other's work. */
  let inFlight: Promise<void> | null = null;
  /** A drain requested while another was running — collapse to one re-run. */
  let rerun = false;

  const report = (error: unknown) => {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  };

  const publishProgress = async () => {
    if (!options.onProgress) return;
    try {
      options.onProgress(await local.progress(ownerUid));
    } catch (err) {
      report(err);
    }
  };

  /** Fold one remote document into the mirror, unless we are its author. */
  const ingest = async (doc: RemoteDoc): Promise<void> => {
    // Our own write coming back. The local copy already contains it by
    // construction; re-applying would at best be wasted work and at worst
    // manufacture a conflict against ourselves.
    if (!shouldApplyRemote({ remoteLastOpId: doc.lastOpId, log })) {
      log.forget(doc.lastOpId!);
      return;
    }
    await local.applyRemote(doc, ownerUid, now());
  };

  const pushOne = async (op: {
    opId: string;
    entity: string;
    entityId: string;
    kind: string;
    payload: Record<string, unknown>;
    baseRev: number;
    deviceId: string;
  }): Promise<void> => {
    if (op.kind === "delete") {
      await remote.remove(op.entityId);
      await local.markDeleteSynced(op.entityId);
      await local.ack(op.opId, now());
      return;
    }

    const result = await remote.commit({
      projectId: op.entityId,
      opId: op.opId,
      baseRev: op.baseRev,
      patch: op.payload,
      deviceId: op.deviceId,
    });

    if (result.status === "applied" || result.status === "skipped") {
      // Remember BEFORE acking: the pull listener can deliver this document back
      // the instant the transaction commits, and it must not be treated as an
      // incoming remote change.
      log.remember(op.opId);
      await local.applyRemote(result.remote, ownerUid, now());
      await local.ack(op.opId, now());
      return;
    }

    // Stale: somebody wrote first. Reconcile, then push the RECONCILED document
    // rather than replaying this patch — see `supersede` for why replaying is
    // unsafe.
    const applied = await local.applyRemote(result.remote, ownerUid, now());
    if (applied.conflicts?.length) {
      // The record is now `conflict`. The operation stays queued but `claim`
      // will not hand it out again until the conflict is resolved — pushing on
      // top of a disagreement is exactly what must not happen.
      return;
    }
    if (!applied.merged) return; // nothing to push; the next pull will settle it
    await local.supersede({
      projectId: op.entityId,
      ownerUid,
      baseRev: applied.baseRev,
      doc: applied.merged,
      deviceId: op.deviceId,
      now: now(),
    });
    // The superseding operation is due immediately, and the remote is known to
    // be exactly where we now claim to be — finish the job in this pass instead
    // of idling until the next tick.
    rerun = true;
  };

  const runDrain = async (): Promise<void> => {
    if (!online) return;

    // Deletions first: pushing an edit to a project the user has deleted is
    // work that will immediately be undone.
    try {
      for (const pending of await local.pendingDeletes(ownerUid)) {
        await remote.remove(pending.entityId);
        await local.markDeleteSynced(pending.entityId);
      }
    } catch (err) {
      report(err);
    }

    let claimed = 0;
    try {
      // Projects only. Media and export uploads live in the same table and are
      // drained by their own workers; claiming them here would strand them.
      const ops = await local.claim(ownerUid, now(), batchSize, ["project"]);
      claimed = ops.length;
      for (const op of ops) {
        try {
          await pushOne(op);
        } catch (err) {
          const error = err as { message?: string; code?: string };
          await local.fail(
            op.opId,
            { message: error?.message ?? "Sync failed", code: error?.code },
            now()
          );
          report(err);
        }
      }
    } catch (err) {
      report(err);
    }

    await publishProgress();

    // A full batch means there is probably more waiting; keep going rather than
    // idling until the next tick with a backlog on disk.
    if (claimed === batchSize) rerun = true;
  };

  const drain = async (): Promise<void> => {
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        // Bounded. Each pass makes progress, but a remote being written
        // continuously by another device could otherwise keep handing back
        // `stale` forever and pin this loop. Stopping early is harmless — the
        // next tick, or the next pulled document, starts another pass.
        let passes = 0;
        do {
          rerun = false;
          await runDrain();
          passes += 1;
        } while (rerun && online && passes < MAX_DRAIN_PASSES);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe = remote.subscribeAll({
        onDoc: (doc) => {
          void ingest(doc)
            .then(publishProgress)
            .catch(report);
        },
        onError: (error) => {
          // A listener error is a connectivity symptom, not a data problem.
          // Stay online:false until something tells us otherwise, so the queue
          // stops being drained rather than failing every operation in it.
          online = false;
          report(error);
          void publishProgress();
        },
        onSynced: () => {
          // The initial pull is in. Anything queued was composed offline or in a
          // previous session; now is exactly the moment to push it.
          void drain();
        },
      });
      void drain();
    },

    stop() {
      running = false;
      unsubscribe?.();
      unsubscribe = null;
    },

    drain,

    setOnline(next) {
      if (online === next) return;
      online = next;
      void publishProgress();
      // Coming back online is the one event that should immediately retry
      // everything that was waiting for it.
      if (next) void drain();
    },

    isOnline: () => online,

    progress: () => local.progress(ownerUid),
  };
}
