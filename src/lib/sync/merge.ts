/**
 * Three-way merge for project documents. Pure — no Firebase, no SQLite, no
 * React — so every boundary condition is asserted in a unit test rather than
 * discovered by a user losing an edit.
 *
 * THE SHAPE OF THE PROBLEM
 * ------------------------
 * Two writers (this desktop, the website) both started from the same document
 * and both changed it. We hold all three versions:
 *
 *     base   — what the cloud had last time this machine agreed with it
 *     local  — what this machine has now
 *     remote — what the cloud has now
 *
 * A field only *conflicts* when BOTH sides moved it away from `base` AND they
 * disagree about where to. Everything else has an obviously correct answer:
 *
 *     local unchanged   → take remote   (a plain download)
 *     remote unchanged  → take local    (a plain upload)
 *     both made the SAME change → take it, no conflict (this is common — two
 *                                 devices reacting to the same analysis result)
 *
 * WHY MOMENTS ARE MERGED BY ID
 * ----------------------------
 * `analysis.detectedMoments` is the timeline. Treated as an opaque array, ANY
 * edit on either side collides with any other, so trimming one pill on the web
 * while nudging a different pill on the desktop would be a conflict — which is
 * both wrong and, on a 40-edit timeline, constant. Keyed by moment id, those two
 * edits are independent and merge silently; only two edits to the SAME moment
 * ask the user anything.
 *
 * WHAT A CONFLICT DOES TO `merged`
 * --------------------------------
 * Conflicting paths keep the LOCAL value. This machine's user is looking at
 * their own work; yanking it out from under them to show the web's version
 * would be its own kind of data loss. Safety comes from the state machine, not
 * from the value: a record with conflicts is marked `conflict` and the engine
 * REFUSES TO PUSH it until a human resolves, so the remote is never overwritten
 * on the strength of a guess either.
 */
import { isPlainObject, jsonEqual } from "@/lib/json-equal";
import type { ConflictChoice, FieldConflict, MergeResult } from "./types";

type Doc = Record<string, unknown>;

/** Dotted path to the moments array inside a ProjectDoc. */
const MOMENTS_PATH = "analysis.detectedMoments";

/**
 * Document keys that sync owns and must never be merged as user data —
 * otherwise `rev` itself becomes a conflict on literally every concurrent edit.
 */
const SYNC_OWNED_KEYS = new Set(["rev", "lastWriterDeviceId", "lastOpId"]);

/**
 * Keys whose value is decided by the write itself rather than by either user.
 * `updatedAt` moves on every edit, so comparing it would report a conflict for
 * two edits that touched nothing in common.
 */
const DERIVED_KEYS = new Set(["updatedAt"]);

export interface MergeInput {
  base: Doc | null;
  local: Doc;
  remote: Doc;
}

/**
 * Merge `local` and `remote` over their common ancestor `base`.
 *
 * With no ancestor (a document this machine has never seen synced) there is no
 * way to tell "I added this" from "they deleted this", so the safe reading is
 * that everything differing is a conflict. That happens once, on first link.
 */
export function mergeProjectDocs(input: MergeInput): MergeResult {
  const base = input.base ?? {};
  const conflicts: FieldConflict[] = [];
  const merged = mergeMaps({
    base,
    local: input.local,
    remote: input.remote,
    path: "",
    conflicts,
    noAncestor: input.base === null,
  });

  // "Unchanged" means neither side moved: the merge is exactly the remote and
  // exactly the local. Callers use it to skip a pointless write on every pull.
  const unchanged =
    conflicts.length === 0 &&
    jsonEqual(stripVolatile(merged), stripVolatile(input.remote)) &&
    jsonEqual(stripVolatile(merged), stripVolatile(input.local));

  return { merged, conflicts, unchanged };
}

/** Drop keys that move on every write, so equality means "same content". */
function stripVolatile(doc: Doc): Doc {
  const out: Doc = {};
  for (const [key, value] of Object.entries(doc)) {
    if (SYNC_OWNED_KEYS.has(key) || DERIVED_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

interface MergeMapArgs {
  base: Doc;
  local: Doc;
  remote: Doc;
  path: string;
  conflicts: FieldConflict[];
  noAncestor: boolean;
}

function mergeMaps(args: MergeMapArgs): Doc {
  const { base, local, remote, path, conflicts, noAncestor } = args;
  const out: Doc = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : key;

    // Sync bookkeeping is not user data. The caller re-stamps it after merging.
    if (!path && SYNC_OWNED_KEYS.has(key)) continue;

    const baseValue = base[key];
    const localValue = local[key];
    const remoteValue = remote[key];

    const localChanged = !jsonEqual(baseValue, localValue);
    const remoteChanged = !jsonEqual(baseValue, remoteValue);

    // Derived fields follow whichever side actually changed content; when both
    // did, the newer wins. They are never a conflict on their own.
    if (!path && DERIVED_KEYS.has(key)) {
      const a = typeof localValue === "number" ? localValue : 0;
      const b = typeof remoteValue === "number" ? remoteValue : 0;
      const winner = Math.max(a, b);
      if (winner > 0) out[key] = winner;
      continue;
    }

    if (!localChanged && !remoteChanged) {
      if (hasKey(base, key)) out[key] = baseValue;
      continue;
    }
    if (!localChanged) {
      if (hasKey(remote, key)) out[key] = remoteValue;
      continue;
    }
    if (!remoteChanged) {
      if (hasKey(local, key)) out[key] = localValue;
      continue;
    }

    // Both moved. Agreeing is not a conflict.
    if (jsonEqual(localValue, remoteValue)) {
      if (hasKey(local, key)) out[key] = localValue;
      continue;
    }

    // The timeline: merge edit-by-edit instead of all-or-nothing.
    if (childPath === MOMENTS_PATH) {
      out[key] = mergeMoments({
        base: asArray(baseValue),
        local: asArray(localValue),
        remote: asArray(remoteValue),
        conflicts,
        noAncestor,
      });
      continue;
    }

    // Two maps: recurse, so changing different sub-fields of `effectsSettings`
    // on each side is not a conflict.
    if (isPlainObject(localValue) && isPlainObject(remoteValue)) {
      out[key] = mergeMaps({
        base: isPlainObject(baseValue) ? baseValue : {},
        local: localValue,
        remote: remoteValue,
        path: childPath,
        conflicts,
        noAncestor,
      });
      continue;
    }

    // A genuine disagreement about one value.
    conflicts.push({ path: childPath, base: baseValue, local: localValue, remote: remoteValue });
    if (hasKey(local, key)) out[key] = localValue;
  }

  return out;
}

function hasKey(doc: Doc, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(doc, key);
}

function asArray(value: unknown): Doc[] {
  return Array.isArray(value) ? (value.filter(isPlainObject) as Doc[]) : [];
}

interface MergeMomentsArgs {
  base: Doc[];
  local: Doc[];
  remote: Doc[];
  conflicts: FieldConflict[];
  noAncestor: boolean;
}

/**
 * Merge two edited timelines, keyed by moment id.
 *
 * Per moment there are exactly four interesting cases:
 *   • only one side touched it            → take that side
 *   • both deleted it                     → gone
 *   • one deleted, the other edited       → CONFLICT (an edit is not consent to
 *                                           delete, and a delete is not consent
 *                                           to keep someone's changes)
 *   • both edited it differently          → CONFLICT
 *
 * The result is sorted by start time so the timeline stays coherent regardless
 * of which order ids happened to arrive in.
 */
function mergeMoments(args: MergeMomentsArgs): Doc[] {
  const { conflicts } = args;
  const base = indexById(args.base);
  const local = indexById(args.local);
  const remote = indexById(args.remote);

  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  const out: Doc[] = [];

  for (const id of ids) {
    const b = base.get(id);
    const l = local.get(id);
    const r = remote.get(id);

    const localChanged = !jsonEqual(b, l);
    const remoteChanged = !jsonEqual(b, r);

    if (!localChanged && !remoteChanged) {
      if (b) out.push(b);
      continue;
    }
    if (!localChanged) {
      if (r) out.push(r);
      continue;
    }
    if (!remoteChanged) {
      if (l) out.push(l);
      continue;
    }
    if (jsonEqual(l, r)) {
      if (l) out.push(l);
      continue;
    }

    // Both sides moved this edit in different directions — including the
    // delete-vs-edit case, where one of `l`/`r` is undefined.
    conflicts.push({
      path: `${MOMENTS_PATH}[${id}]`,
      momentId: id,
      base: b,
      local: l,
      remote: r,
    });
    // Keep the local view (see the header note); resolution decides for real.
    if (l) out.push(l);
  }

  return sortMoments(out);
}

function indexById(list: Doc[]): Map<string, Doc> {
  const map = new Map<string, Doc>();
  for (const item of list) {
    const id = item.id;
    if (typeof id === "string" && id) map.set(id, item);
  }
  return map;
}

function sortMoments(list: Doc[]): Doc[] {
  return [...list].sort((a, b) => {
    const at = typeof a.startTime === "number" ? a.startTime : 0;
    const bt = typeof b.startTime === "number" ? b.startTime : 0;
    if (at !== bt) return at - bt;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
}

/**
 * Apply a user's conflict decisions to a merged document.
 *
 * `choices` is keyed by `FieldConflict.path`. Anything left unchosen keeps what
 * the merge produced (the local value), so a partially-answered dialog can still
 * be applied without silently reverting the untouched entries.
 */
export function applyConflictChoices(
  merged: Doc,
  conflicts: FieldConflict[],
  choices: Record<string, ConflictChoice>
): Doc {
  let out: Doc = { ...merged };
  for (const conflict of conflicts) {
    const choice = choices[conflict.path];
    if (!choice) continue;
    const value = choice === "local" ? conflict.local : conflict.remote;
    out = conflict.momentId
      ? setMoment(out, conflict.momentId, value)
      : setPath(out, conflict.path.split("."), value);
  }
  return out;
}

/** Immutably set a dotted path, creating intermediate maps as needed. */
function setPath(doc: Doc, path: string[], value: unknown): Doc {
  const [head, ...rest] = path;
  if (!head) return doc;
  const out: Doc = { ...doc };
  if (rest.length === 0) {
    if (value === undefined) delete out[head];
    else out[head] = value;
    return out;
  }
  const child = isPlainObject(out[head]) ? (out[head] as Doc) : {};
  out[head] = setPath(child, rest, value);
  return out;
}

/** Replace (or remove, when `value` is undefined) one moment by id. */
function setMoment(doc: Doc, momentId: string, value: unknown): Doc {
  const analysis = isPlainObject(doc.analysis) ? { ...(doc.analysis as Doc) } : {};
  const moments = asArray(analysis.detectedMoments).filter((m) => m.id !== momentId);
  if (isPlainObject(value)) moments.push(value);
  analysis.detectedMoments = sortMoments(moments);
  return { ...doc, analysis };
}
