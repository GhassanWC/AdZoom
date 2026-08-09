/**
 * Revisions, device identity and operation ids — the three things that make a
 * push idempotent and make "never overwrite newer data" enforceable rather than
 * aspirational.
 *
 * THE RULE
 * --------
 * Every project document carries `rev`, a monotonically increasing integer. A
 * writer composes an operation against the `rev` it last saw (`baseRev`) and the
 * push is a COMPARE-AND-SET: inside a Firestore transaction, re-read the doc,
 * and only write when `remote.rev === baseRev`. Any other value means somebody
 * else wrote in between, and the operation must go through the merge instead of
 * over the top of it.
 *
 * `lastOpId` closes the other hole: a transaction can commit and still fail to
 * report success (the process dies, the socket drops). The retry carries the
 * same `opId`, sees it already stamped on the document, and treats the operation
 * as applied rather than applying it twice.
 */

/** Fields sync adds to every project document. Mirrored in ProjectDoc. */
export interface RevisionFields {
  /** Monotonic write counter. Absent on documents written before sync existed. */
  rev?: number;
  /** Which machine performed the last accepted write. */
  lastWriterDeviceId?: string;
  /** The operation id of the last accepted write — the idempotency marker. */
  lastOpId?: string;
}

/**
 * A document that predates sync has no `rev`. Treating that as 0 lets an old
 * project join the scheme on its first write with no migration pass over
 * Firestore — the first desktop write simply stamps `rev: 1`.
 */
export function revisionOf(doc: RevisionFields | null | undefined): number {
  const rev = doc?.rev;
  return typeof rev === "number" && Number.isFinite(rev) && rev >= 0 ? Math.floor(rev) : 0;
}

export function nextRevision(doc: RevisionFields | null | undefined): number {
  return revisionOf(doc) + 1;
}

/**
 * Has the remote moved past the revision this operation was composed against?
 * True ⇒ do NOT apply the patch directly; merge.
 */
export function isStale(baseRev: number, remote: RevisionFields | null | undefined): boolean {
  return revisionOf(remote) !== baseRev;
}

/**
 * Was this exact operation already accepted?
 *
 * Checked BEFORE the staleness test on purpose: a retry of an op that already
 * landed will always look stale (its own write moved the revision), and reporting
 * that as a conflict would ask the user to resolve their own successful edit.
 */
export function alreadyApplied(
  opId: string,
  remote: RevisionFields | null | undefined
): boolean {
  return !!opId && remote?.lastOpId === opId;
}

/**
 * The verdict for one push attempt, decided purely from the remote document.
 *
 *   apply    — safe to write; the remote is exactly where we left it.
 *   skip     — this op already landed; ack it without writing.
 *   merge    — someone else wrote; reconcile instead of overwriting.
 */
export type PushVerdict = "apply" | "skip" | "merge";

export function verdictFor(args: {
  opId: string;
  baseRev: number;
  remote: RevisionFields | null | undefined;
}): PushVerdict {
  if (alreadyApplied(args.opId, args.remote)) return "skip";
  if (isStale(args.baseRev, args.remote)) return "merge";
  return "apply";
}

/** The revision fields to stamp onto an accepted write. */
export function stampRevision(args: {
  remote: RevisionFields | null | undefined;
  deviceId: string;
  opId: string;
}): Required<Pick<RevisionFields, "rev" | "lastWriterDeviceId" | "lastOpId">> {
  return {
    rev: nextRevision(args.remote),
    lastWriterDeviceId: args.deviceId,
    lastOpId: args.opId,
  };
}

/**
 * A device id: stable for the life of an installation, meaningless to anyone
 * else. Deliberately NOT derived from hardware — a machine fingerprint is
 * personal data we have no use for. Generated once and stored in `app_state`.
 */
export function newDeviceId(random: () => number = Math.random): string {
  return `dev_${randomToken(16, random)}`;
}

/** An operation id. Unique per enqueue, never reused across retries. */
export function newOpId(random: () => number = Math.random): string {
  return `op_${randomToken(20, random)}`;
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomToken(length: number, random: () => number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  }
  return out;
}
