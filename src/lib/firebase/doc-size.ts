/**
 * Firestore document-size accounting — pure, no Firebase import.
 *
 * Firestore rejects any write whose RESULTING document exceeds 1 MiB with
 * `3 INVALID_ARGUMENT: … cannot be written because its size … exceeds the
 * maximum allowed size of 1,048,576 bytes`, and the whole write is lost. A
 * merge-write can trip it even when the patch is small, because the limit is
 * on the merged document. This lets a writer predict the merged size and shed
 * optional data BEFORE the write, instead of losing everything after it.
 *
 * Sizes follow https://firebase.google.com/docs/firestore/storage-size:
 * string = UTF-8 bytes + 1, number/timestamp = 8, boolean/null = 1, map =
 * Σ(key + 1 + value), array = Σ values, document = name + fields + 32.
 */

export const FIRESTORE_MAX_DOCUMENT_BYTES = 1_048_576;

const utf8 = (s: string) => new TextEncoder().encode(s).length;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Stored size of one field value. Non-plain objects (Timestamp, serverTimestamp sentinel, Date) count as 8. */
export function firestoreValueSize(v: unknown): number {
  if (v === undefined) return 0;
  if (v === null || typeof v === "boolean") return 1;
  if (typeof v === "number" || typeof v === "bigint") return 8;
  if (typeof v === "string") return utf8(v) + 1;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + firestoreValueSize(x), 0);
  if (isPlainObject(v)) {
    let n = 0;
    for (const [k, x] of Object.entries(v)) if (x !== undefined) n += utf8(k) + 1 + firestoreValueSize(x);
    return n;
  }
  return 8;
}

/** Size of a whole document at `path` ("users/u/projects/p"). */
export function firestoreDocumentSize(path: string, data: Record<string, unknown>): number {
  const name = path.split("/").reduce((n, seg) => n + utf8(seg) + 1, 0) + 16;
  return name + firestoreValueSize(data) + 32;
}

/**
 * What `set(patch, { merge: true })` leaves behind: plain maps deep-merge,
 * everything else (arrays included) replaces. `DELETE` marks a key to remove.
 */
export const DELETE = Symbol("delete");

export function mergeForSize(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === DELETE) delete out[k];
    else if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeForSize(out[k] as Record<string, unknown>, v);
    else out[k] = v;
  }
  return out;
}

export interface FitResult {
  /** The paths (dot-joined) that had to be shed, in order. Empty when it fit. */
  dropped: string[];
  /** Predicted size of the merged document after shedding. */
  size: number;
  fits: boolean;
}

/**
 * Shed optional paths from `patch` (mutating it, setting each to `deleted`)
 * until the merged document fits `budget`. `optional` is in shed order — least
 * valuable first. A shed path is DELETED, not just omitted: omitting it from a
 * merge-write would leave the previous run's (stale, equally large) value.
 */
export function fitMergeWrite(args: {
  path: string;
  existing: Record<string, unknown>;
  patch: Record<string, unknown>;
  optional: string[][];
  /** The sentinel the real write uses for a delete (FieldValue.delete()). */
  deleted: unknown;
  budget?: number;
}): FitResult {
  const budget = args.budget ?? FIRESTORE_MAX_DOCUMENT_BYTES;
  const measure = (p: Record<string, unknown>) =>
    firestoreDocumentSize(args.path, mergeForSize(args.existing, swapSentinel(p, args.deleted)));
  const dropped: string[] = [];
  let size = measure(args.patch);
  for (const path of args.optional) {
    if (size <= budget) break;
    setPath(args.patch, path, args.deleted);
    dropped.push(path.join("."));
    size = measure(args.patch);
  }
  return { dropped, size, fits: size <= budget };
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown) {
  let cur = obj;
  for (const k of path.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

/** Replace the caller's delete sentinel with ours, for measuring only. */
function swapSentinel(v: Record<string, unknown>, deleted: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = x === deleted ? DELETE : isPlainObject(x) ? swapSentinel(x, deleted) : x;
  }
  return out;
}
