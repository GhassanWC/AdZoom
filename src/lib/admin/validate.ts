/**
 * Defensive field coercion for admin reads.
 *
 * Firestore is schemaless: a doc written by an older build (or a partially
 * failed write) can hold `undefined`, the wrong type, or a `Timestamp` where a
 * number is expected. Before this module, a single malformed doc could throw
 * inside a `.map()` and blank an entire admin page.
 *
 * Every helper is TOTAL — it always returns a value of the declared type and
 * never throws. Pure (no Firestore import) so it is unit-testable.
 */

/** A string, or `fallback` when the value is absent/not a string/empty. */
export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** A string or `null` — for genuinely optional text (email, errorMessage). */
export function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A finite number, or `fallback`. Rejects NaN/Infinity and numeric strings. */
export function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A finite number or `null` — for optional metrics (fileSize, duration). */
export function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Strict boolean — only a real `true` counts (guards against "true"/1). */
export function bool(value: unknown): boolean {
  return value === true;
}

/**
 * `value` when it is one of `allowed`, else `fallback`. Keeps a rogue status
 * string from creating a phantom bucket in a distribution chart.
 */
export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Length of an array-valued field; 0 when the field is missing or not an array. */
export function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * A plain object, or `{}`. Guards `metadata`-style free-form fields that the
 * UI spreads or iterates — an array or string there would render as garbage.
 */
export function plainObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Run `map` over every doc, dropping (and counting) any that throw.
 *
 * This is the last line of defence: the per-field helpers above make a throw
 * unlikely, but a custom mapper can still hit something unexpected. One bad
 * doc costs one row, never the whole page.
 *
 * `label` is used for the log line only — never log doc contents, which can
 * carry user emails, project titles and file paths.
 */
export function mapSafe<TIn, TOut>(
  docs: readonly TIn[],
  map: (doc: TIn, index: number) => TOut,
  label: string
): { rows: TOut[]; skipped: number } {
  const rows: TOut[] = [];
  let skipped = 0;
  for (let i = 0; i < docs.length; i++) {
    try {
      rows.push(map(docs[i], i));
    } catch (err) {
      skipped += 1;
      // Log the failure REASON, never the document — admin logs are not a
      // place for user emails / project titles.
      console.error(
        `[admin/validate] ${label}: skipped malformed doc at index ${i}:`,
        err instanceof Error ? err.message : "unknown error"
      );
    }
  }
  if (skipped > 0) {
    console.warn(`[admin/validate] ${label}: skipped ${skipped}/${docs.length} malformed docs`);
  }
  return { rows, skipped };
}
