/**
 * Backend-agnostic document patch sentinels.
 *
 * The editor persists every change as a MERGE patch. On the web that patch goes
 * to Firestore, which needs its own `FieldValue` sentinels (`arrayUnion`,
 * `deleteField`, …); on the desktop the same patch is applied to a local SQLite
 * row by `applyPatch` in the main process. Both need to express "append to this
 * array", "remove this key", "stamp the write time" — so the sentinels live HERE
 * as plain, JSON-serializable markers and each backend translates them:
 *
 *   web     → `toFirestorePatch` maps them onto real Firestore FieldValues.
 *   desktop → the patch travels over IPC as JSON and `applyPatch` (pure, in
 *             ./patch.ts) applies the same semantics to the stored document.
 *
 * Keeping ONE sentinel vocabulary is what makes "the desktop stores the same
 * ProjectDoc the web does" true by construction — there is no second write
 * dialect to keep in sync, and a patch is inspectable/testable without a
 * Firestore emulator.
 */

/** Marker key — deliberately obscure so it can't collide with real doc fields. */
export const FIELD_SENTINEL = "__framevoFieldValue" as const;

export type FieldSentinel =
  | { readonly [FIELD_SENTINEL]: "arrayUnion"; readonly elements: readonly unknown[] }
  | { readonly [FIELD_SENTINEL]: "arrayRemove"; readonly elements: readonly unknown[] }
  | { readonly [FIELD_SENTINEL]: "delete" }
  | { readonly [FIELD_SENTINEL]: "serverTimestamp" };

/** Append `elements` to an array field, skipping values already present. */
export function arrayUnion(...elements: unknown[]): FieldSentinel {
  return { [FIELD_SENTINEL]: "arrayUnion", elements };
}

/** Remove every occurrence of `elements` from an array field. */
export function arrayRemove(...elements: unknown[]): FieldSentinel {
  return { [FIELD_SENTINEL]: "arrayRemove", elements };
}

/** Delete the field entirely (NOT the same as writing `null`/`undefined`). */
export function deleteField(): FieldSentinel {
  return { [FIELD_SENTINEL]: "delete" };
}

/** Stamp the field with the backend's write time. */
export function serverTimestamp(): FieldSentinel {
  return { [FIELD_SENTINEL]: "serverTimestamp" };
}

export function isFieldSentinel(value: unknown): value is FieldSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    FIELD_SENTINEL in (value as Record<string, unknown>)
  );
}

/** A merge patch: nested plain objects whose leaves may be sentinels. */
export type DocPatch = { [key: string]: unknown };
