/**
 * Structural equality for plain JSON data.
 *
 * Not a general-purpose deep-equal: no Map/Set/Date/RegExp handling, because
 * none of those survive the JSON round-trip that every document in this app
 * takes (Firestore snapshot, SQLite `text(… {mode:"json"})`, IPC structured
 * clone). Keeping it narrow keeps it cheap — it runs over every edit on every
 * project echo and over every field on every merge.
 *
 * Lives in `lib/` rather than beside its first caller because both the editor's
 * render-identity reconciliation and the sync merge need exactly this, and a
 * second copy is how the two quietly start disagreeing about what "changed"
 * means.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i += 1) {
      if (!jsonEqual(aa[i], bb[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
    if (!jsonEqual(ao[key], bo[key])) return false;
  }
  return true;
}

/** Plain object = a map to walk into. Arrays and class instances are leaves. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
