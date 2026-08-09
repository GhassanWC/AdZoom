/**
 * `applyPatch` — the pure, backend-free implementation of a Firestore-style
 * MERGE write, used by the desktop's local project store (and its tests).
 *
 * The rules mirror `setDoc(ref, patch, { merge: true })` exactly, because the
 * editor writes the SAME patch to both backends:
 *
 *   • Nested plain objects DEEP-MERGE (this is why a sparse `timelineLayers`
 *     map can add a `false` but never take one away — see layers.ts).
 *   • Arrays REPLACE wholesale (they are leaves, not maps) unless the value is
 *     an arrayUnion/arrayRemove sentinel.
 *   • `deleteField()` removes the key; writing `null` keeps it as null.
 *   • `undefined` is IGNORED (never written), matching the SDK's behaviour with
 *     `ignoreUndefinedProperties` and the codebase's `stripUndefined` habit.
 *   • `serverTimestamp()` resolves to `now` (epoch ms) — the local store is the
 *     server, so the write time is simply the moment it lands.
 *
 * Pure and total: never mutates its input, never throws on odd input.
 */
import {
  FIELD_SENTINEL,
  isFieldSentinel,
  type DocPatch,
  type FieldSentinel,
} from "./field-value";

type Doc = Record<string, unknown>;

/** Plain object = a map to deep-merge into. Arrays/Dates/class instances are leaves. */
function isPlainObject(value: unknown): value is Doc {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Structural equality for arrayUnion/arrayRemove membership (values are JSON). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function applySentinel(
  sentinel: FieldSentinel,
  current: unknown,
  now: number
): { remove: true } | { remove: false; value: unknown } {
  switch (sentinel[FIELD_SENTINEL]) {
    case "delete":
      return { remove: true };
    case "serverTimestamp":
      return { remove: false, value: now };
    case "arrayUnion": {
      const base = Array.isArray(current) ? [...current] : [];
      for (const el of sentinel.elements) {
        if (!base.some((existing) => sameValue(existing, el))) base.push(el);
      }
      return { remove: false, value: base };
    }
    case "arrayRemove": {
      const base = Array.isArray(current) ? current : [];
      return {
        remove: false,
        value: base.filter((existing) => !sentinel.elements.some((el) => sameValue(existing, el))),
      };
    }
  }
}

/**
 * Merge `patch` into `doc`, returning a NEW document. `now` is the timestamp
 * `serverTimestamp()` resolves to (injected so tests are deterministic).
 */
export function applyPatch(doc: Doc, patch: DocPatch, now: number = Date.now()): Doc {
  const out: Doc = { ...doc };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;

    if (isFieldSentinel(value)) {
      const result = applySentinel(value, out[key], now);
      if (result.remove) delete out[key];
      else out[key] = result.value;
      continue;
    }

    if (isPlainObject(value)) {
      const current = out[key];
      out[key] = applyPatch(isPlainObject(current) ? current : {}, value, now);
      continue;
    }

    out[key] = value;
  }
  return out;
}

/**
 * Strip sentinels out of a patch for logging/telemetry — the raw patch can
 * contain user text (captions, titles), so callers log the SHAPE, not values.
 */
export function describePatch(patch: DocPatch): string[] {
  const keys: string[] = [];
  const walk = (node: DocPatch, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isPlainObject(value) && !isFieldSentinel(value)) walk(value, path);
      else keys.push(path);
    }
  };
  walk(patch, "");
  return keys;
}
