/**
 * Recursively strip `undefined` values out of plain objects and arrays.
 *
 * Firestore rejects writes that contain `undefined` *anywhere* in the
 * document. Spreading existing moments (or any doc previously read from
 * Firestore) preserves their explicit-`undefined` optional fields, which
 * is how routes that add new optional fields (e.g. `whyEffectType`) blow
 * up with `Cannot use "undefined" as a Firestore value (found in field
 * "...")`. Run this on any payload before `ref.set(...)`.
 *
 * Idempotent on primitives. Preserves `null` (Firestore accepts `null`).
 */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}
