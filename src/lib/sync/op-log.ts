/**
 * Duplicate-operation prevention on the RECEIVING side.
 *
 * `revision.ts` stops a duplicate PUSH by checking `lastOpId` on the remote
 * document. This module is the mirror image: it stops a duplicate APPLY when a
 * remote change comes back to the machine that made it.
 *
 * The loop it closes: desktop pushes op X → Firestore accepts and stamps
 * `lastOpId: X` → the pull listener immediately delivers that same document back
 * → without a memory of X, the engine would treat its own write as an incoming
 * remote change, re-run the merge, and (because the local doc has since moved
 * on) potentially manufacture a conflict against itself.
 *
 * A bounded LRU rather than an unbounded set: the window only has to outlive the
 * round trip, and an unbounded one is a slow leak in a process that stays open
 * for days.
 */

/** How many recent operation ids to remember. Comfortably past any round trip. */
export const OP_LOG_CAPACITY = 512;

export interface OpLog {
  /** Record an operation this machine originated. */
  remember(opId: string): void;
  /** Was this operation originated here, recently? */
  isOwn(opId: string | undefined | null): boolean;
  /** Drop an id once its echo has been seen (frees the slot early). */
  forget(opId: string): void;
  /** Wipe — used on sign-out, where nothing from the old session applies. */
  clear(): void;
  size(): number;
}

export function createOpLog(capacity: number = OP_LOG_CAPACITY): OpLog {
  // Insertion order IS the recency order: a Map preserves it, and re-inserting
  // moves an id to the end, which is all an LRU needs.
  const seen = new Map<string, true>();

  return {
    remember(opId) {
      if (!opId) return;
      if (seen.has(opId)) seen.delete(opId);
      seen.set(opId, true);
      while (seen.size > capacity) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
    },
    isOwn(opId) {
      return !!opId && seen.has(opId);
    },
    forget(opId) {
      seen.delete(opId);
    },
    clear() {
      seen.clear();
    },
    size() {
      return seen.size;
    },
  };
}

/**
 * Should an incoming remote document be applied at all?
 *
 * Returns false when the document's last write was one of ours — the local copy
 * already contains it by construction, so applying it again is at best wasted
 * work and at worst a self-conflict.
 */
export function shouldApplyRemote(args: {
  remoteLastOpId?: string;
  log: OpLog;
}): boolean {
  return !args.log.isOwn(args.remoteLastOpId);
}
