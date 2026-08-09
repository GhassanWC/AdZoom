/**
 * The sync contract — shared verbatim by the desktop main process (SQLite), the
 * renderer (Firestore), and the tests. Pure TypeScript: no Firebase, no
 * Electron, no DOM.
 *
 * WHY A SHARED FILE AT ALL
 * -----------------------
 * The two halves of sync run in different processes and talk over IPC, which is
 * exactly the seam where a data model quietly forks. Naming the states, the
 * operation shape and the conflict report ONCE means the queue writer and the
 * queue drainer cannot disagree about what a "pending" row is.
 */

/**
 * The state of one record with respect to the cloud. Exactly one of these is
 * true at any moment, and it is the single value the UI renders.
 *
 *   synced   — local and remote agree; nothing is outstanding.
 *   pending  — local changes exist that the cloud has not accepted yet.
 *   syncing  — an operation for this record is in flight right now.
 *   conflict — local AND remote both changed the same thing; a human must pick.
 *   failed   — the last attempt errored and backoff has given up for now.
 *              `lastError` explains it and the user can retry.
 *
 * `pending` and `failed` are deliberately distinct: pending is the normal state
 * of an offline edit and must never look like an error.
 */
export type SyncState = "synced" | "pending" | "syncing" | "conflict" | "failed";

/** Which kind of record an operation is about. */
export type SyncEntity = "project" | "media" | "export";

/**
 * What an operation DOES. Kept coarse on purpose — the payload carries the
 * detail, and a small verb set keeps the drainer's switch exhaustive.
 */
export type SyncOpKind = "patch" | "delete" | "upload";

/** Lifecycle of a queued operation. */
export type OutboxState = "queued" | "inflight" | "failed" | "done";

/**
 * One durable unit of intent.
 *
 * `opId` is the IDEMPOTENCY KEY and is minted at enqueue time, not at send time:
 * a retry after a crash — or after an ack that was lost on the wire — carries
 * the same id, so the receiver can recognise it as already-applied instead of
 * applying it twice. `baseRev` is what makes the push a compare-and-set rather
 * than a blind overwrite.
 */
export interface SyncOp {
  opId: string;
  /**
   * The Firebase uid this operation belongs to. Every claim is filtered on it,
   * which is what keeps one account's queued work from ever being pushed into
   * another account after a sign-out/sign-in on the same machine.
   */
  ownerUid: string;
  entity: SyncEntity;
  entityId: string;
  kind: SyncOpKind;
  /** A `DocPatch` for `patch`, upload metadata for `upload`, empty for `delete`. */
  payload: Record<string, unknown>;
  /**
   * The revision this operation was composed against. If the remote has moved
   * past it, the operation does NOT apply blindly — it routes into the merge.
   */
  baseRev: number;
  /** Which machine composed it (diagnostics + last-writer attribution). */
  deviceId: string;
  createdAt: number;
  attempts: number;
  /** Epoch ms before which this op must not be retried (backoff). */
  nextAttemptAt: number;
  state: OutboxState;
  lastError?: string;
}

/**
 * A field the merge could not resolve on its own.
 *
 * `path` is a dotted document path (`title`, `effectsSettings.autoZoom`) or a
 * moment address (`analysis.detectedMoments[<id>]`). The three values are kept
 * so the resolution UI can show precisely what each side did, rather than
 * asking the user to choose between two opaque documents.
 */
export interface FieldConflict {
  path: string;
  base: unknown;
  local: unknown;
  remote: unknown;
  /** A moment-level conflict names the edit so the UI can label it. */
  momentId?: string;
}

/** The outcome of a three-way merge. */
export interface MergeResult {
  /**
   * The document to store. Non-conflicting changes from BOTH sides are already
   * folded in; conflicting paths keep the LOCAL value, so this machine's user
   * never watches their own visible work get replaced by a merge they did not
   * ask for. Safety does not come from that choice — it comes from the state
   * machine: a record with conflicts is marked `conflict` and the engine
   * refuses to PUSH it until a human resolves, so the remote is never
   * overwritten on the strength of a guess either.
   */
  merged: Record<string, unknown>;
  conflicts: FieldConflict[];
  /** True when neither side changed anything — the common case; skip the write. */
  unchanged: boolean;
}

/** How a human resolved one conflict. */
export type ConflictChoice = "local" | "remote";

/** Per-record sync status, as surfaced to the UI. */
export interface SyncStatus {
  entity: SyncEntity;
  entityId: string;
  state: SyncState;
  /** Queued operations not yet accepted by the cloud. */
  pendingOps: number;
  lastSyncedAt?: number;
  lastError?: string;
  /** Unresolved conflicts awaiting a choice. */
  conflicts?: FieldConflict[];
}

/** Aggregate progress, for the library-level indicator. */
export interface SyncProgress {
  /** True while the engine is draining or pulling. */
  active: boolean;
  pendingOps: number;
  failedOps: number;
  conflictedRecords: number;
  /** Null until the first successful pull of this session. */
  lastPullAt: number | null;
  online: boolean;
}
