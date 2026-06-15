/**
 * Timestamp normalization for admin API responses.
 *
 * Firestore timestamps in this app are MIXED: some fields are written with
 * `serverTimestamp()` (read back as a Firestore `Timestamp` with `.toMillis()`)
 * and others with `Date.now()` (read back as a plain number). When the Admin
 * SDK reads these and we JSON-serialize for the client, a raw `Timestamp`
 * object would serialize to `{_seconds,_nanoseconds}` and break date math.
 *
 * `tsToMillis()` coerces any of these into epoch-ms (or 0 when absent), so the
 * client always receives a number. Mirrors `materializeExport` in
 * `src/lib/firebase/exports.ts`.
 */

type MillisLike = { toMillis?: () => number } | number | null | undefined;

/** Coerce a Firestore Timestamp / number / nullish into epoch-ms (0 if absent). */
export function tsToMillis(value: MillisLike): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value.toMillis === "function") {
    try {
      return value.toMillis();
    } catch {
      return 0;
    }
  }
  return 0;
}

/** Like `tsToMillis` but returns `undefined` (not 0) when the value is absent. */
export function tsToMillisOpt(value: MillisLike): number | undefined {
  if (value == null) return undefined;
  const ms = tsToMillis(value);
  return ms || undefined;
}

/** UTC `YYYY-MM-DD` bucket key for a given epoch-ms timestamp (for day charts). */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
