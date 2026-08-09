/**
 * The two sides the sync engine sits between, as interfaces.
 *
 * `LocalSyncPort` is the durable queue (SQLite, reached over IPC).
 * `RemoteProjectStore` is the cloud (Firestore).
 *
 * Both are ports rather than direct imports for one reason that matters more
 * than tidiness: the engine's hard parts — rebasing a stale operation, deciding
 * that a conflict must stop a push, not resurrecting a deleted project — are
 * exactly the parts that are miserable to exercise against a real database and
 * a real network. Against two in-memory fakes they are ordinary unit tests.
 */
import type { FieldConflict, SyncOp, SyncProgress, SyncStatus } from "./types";

/** A project document as it exists in the cloud, plus its sync bookkeeping. */
export interface RemoteDoc {
  projectId: string;
  /** Null when the document was deleted remotely. */
  doc: Record<string, unknown> | null;
  rev: number;
  lastOpId?: string;
  updatedAt?: number;
}

/** What a compare-and-set write actually did. */
export type CommitStatus =
  /** The remote was where we left it; the patch is now applied. */
  | "applied"
  /** This operation was already on the document — nothing to do. */
  | "skipped"
  /** Somebody else wrote first. The caller must reconcile before retrying. */
  | "stale";

export interface CommitResult {
  status: CommitStatus;
  /** The document as it now stands remotely — the input to a reconcile. */
  remote: RemoteDoc;
}

export interface RemoteProjectStore {
  /**
   * Apply `patch` to `projectId` if and only if the remote is still at
   * `baseRev`, stamping `rev`/`lastWriterDeviceId`/`lastOpId` atomically.
   *
   * MUST be a transaction. A read-then-write would let two devices both see
   * rev 4, both decide they are current, and both write rev 5 — which is the
   * silent overwrite this whole design exists to prevent.
   */
  commit(args: {
    projectId: string;
    opId: string;
    baseRev: number;
    patch: Record<string, unknown>;
    deviceId: string;
  }): Promise<CommitResult>;

  /** Delete the remote document. Idempotent: deleting a missing doc succeeds. */
  remove(projectId: string): Promise<void>;

  /**
   * Live subscription to every project this account owns. Fires once per
   * document on connect (that IS the initial pull) and again on every change.
   */
  subscribeAll(handlers: {
    onDoc: (doc: RemoteDoc) => void;
    onError: (error: Error) => void;
    /** Called when the initial snapshot has been fully delivered. */
    onSynced?: () => void;
  }): () => void;
}

/** The outcome of folding a remote document into the local mirror. */
export interface ApplyRemoteResult {
  /** True when the local row changed as a result. */
  changed: boolean;
  /** Present when the merge could not decide; the record is now `conflict`. */
  conflicts?: FieldConflict[];
  /** The revision the local mirror is now based on. */
  baseRev: number;
  /**
   * The reconciled document. This — not the original patch — is what a stale
   * operation must go on to push. See `supersede`.
   */
  merged?: Record<string, unknown>;
  /** True when the document was ignored because it was deleted here. */
  ignoredTombstone?: boolean;
}

export interface LocalSyncPort {
  /**
   * Operations that are due, for this account only.
   *
   * Skips records in `conflict` (pushing over a disagreement is the one thing
   * that must never happen) and, when `entities` is given, anything outside it —
   * the project engine and the upload workers drain the same table without
   * stealing each other's work.
   */
  claim(ownerUid: string, now: number, limit?: number, entities?: string[]): Promise<SyncOp[]>;
  ack(opId: string, now: number): Promise<void>;
  fail(opId: string, error: { message: string; code?: string }, now: number): Promise<void>;
  /**
   * Replace every queued operation for a project with ONE that carries the
   * reconciled document, composed against `baseRev`.
   *
   * This exists because replaying a stale PATCH is not safe. A patch is a
   * snapshot of intent against an old document, and several fields — most
   * importantly `analysis.detectedMoments` — are arrays, which merge semantics
   * REPLACE wholesale. Rebasing such a patch onto a newer revision silently
   * discards whatever the other device did to that array in the meantime. (This
   * was caught by "simultaneous edits to DIFFERENT things merge with no
   * conflict": the merge was correct, and then the replayed patch undid it.)
   *
   * The merge has already folded every local change into one document, so that
   * document IS the complete local intent reconciled with the remote — and it is
   * what gets pushed.
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
  applyRemote(remote: RemoteDoc, ownerUid: string, now: number): Promise<ApplyRemoteResult>;
  /** Deletions this machine owes the cloud. */
  pendingDeletes(ownerUid: string): Promise<{ entityId: string }[]>;
  markDeleteSynced(entityId: string): Promise<void>;
  /** Aggregate state, for the library indicator. */
  progress(ownerUid: string): Promise<SyncProgress>;
  status(projectId: string): Promise<SyncStatus | null>;
}
