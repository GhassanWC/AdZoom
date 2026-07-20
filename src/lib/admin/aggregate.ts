/**
 * Pure aggregation over already-fetched admin rows.
 *
 * THE CONSISTENCY RULE
 * --------------------
 * Every number an admin page shows — metric cards, chart segments and the
 * table's own footer — is computed HERE, from the SAME in-memory array that
 * produced the table rows (see `scan.ts`). Nothing in this file talks to
 * Firestore.
 *
 * That is deliberate. The previous implementation mixed two query sources:
 * `.count()` aggregations for the metric cards and a separate capped
 * `orderBy(...).limit(1000)` scan for the charts and table. When the count
 * aggregation's index was missing, `safeCount` returned `null` → the card
 * rendered 0 while the charts and table — served by a different, working
 * index — still showed rows. That is exactly the "Total exports: 0 next to a
 * full table" bug. One source of truth makes that class of bug impossible.
 *
 * Being pure also makes all of this directly unit-testable with no Firestore
 * emulator (see tests/admin-aggregate.test.ts).
 */

import { dayKey } from "./serialize";

/** `{ label, value }` pairs sorted by descending value — the chart input shape. */
export interface Slice {
  label: string;
  value: number;
}

/** A single day bucket in a timeseries. */
export interface DayPoint {
  day: string;
  count: number;
}

/**
 * Count occurrences of a key across rows.
 *
 * `keys` pre-seeds the result so a status with zero rows still renders as an
 * explicit 0 rather than silently vanishing from the chart legend.
 */
export function tally<T>(
  rows: readonly T[],
  keyFn: (row: T) => string | null | undefined,
  keys: readonly string[] = []
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = 0;
  for (const row of rows) {
    const k = keyFn(row);
    if (!k) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** A tally rendered as descending `{label, value}` slices, optionally capped. */
export function toSlices(
  counts: Record<string, number>,
  opts: { topN?: number; dropZero?: boolean } = {}
): Slice[] {
  const { topN, dropZero = false } = opts;
  const slices = Object.entries(counts)
    .filter(([, value]) => (dropZero ? value > 0 : true))
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return topN != null ? slices.slice(0, topN) : slices;
}

/** How many rows satisfy a predicate. */
export function countWhere<T>(rows: readonly T[], pred: (row: T) => boolean): number {
  let n = 0;
  for (const row of rows) if (pred(row)) n += 1;
  return n;
}

/**
 * Mean of a per-row value, ignoring rows where `valueFn` returns null.
 * Returns `null` (not 0) when no row contributed — "no data" and "average of
 * zero" are different facts and the UI renders them differently.
 */
export function averageOf<T>(
  rows: readonly T[],
  valueFn: (row: T) => number | null
): number | null {
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    const v = valueFn(row);
    if (v == null || !Number.isFinite(v)) continue;
    sum += v;
    n += 1;
  }
  return n > 0 ? sum / n : null;
}

/**
 * Median of a per-row value — reported alongside the mean for processing
 * times, where a couple of stuck jobs skew the average badly.
 */
export function medianOf<T>(
  rows: readonly T[],
  valueFn: (row: T) => number | null
): number | null {
  const values: number[] = [];
  for (const row of rows) {
    const v = valueFn(row);
    if (v != null && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * Bucket rows into consecutive UTC day counts.
 *
 * Days with no rows are filled with 0 across the whole `[fromMs, toMs]` span so
 * a sparse week renders as a flat line rather than a misleading spike-to-spike
 * zigzag. When `fromMs` is omitted the span runs from the earliest row present.
 */
export function bucketByDay<T>(
  rows: readonly T[],
  msFn: (row: T) => number,
  opts: { fromMs?: number; toMs?: number } = {}
): DayPoint[] {
  const counts = new Map<string, number>();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const row of rows) {
    const ms = msFn(row);
    if (!ms || !Number.isFinite(ms)) continue;
    counts.set(dayKey(ms), (counts.get(dayKey(ms)) ?? 0) + 1);
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }

  const fromMs = opts.fromMs && opts.fromMs > 0 ? opts.fromMs : min;
  const toMs = opts.toMs && opts.toMs > 0 ? opts.toMs : max;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    // No rows at all and no explicit span — nothing to plot.
    return [...counts.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  const out: DayPoint[] = [];
  const DAY_MS = 86_400_000;
  // Walk from UTC-midnight of `fromMs` so bucket boundaries line up with dayKey.
  const start = Date.UTC(
    new Date(fromMs).getUTCFullYear(),
    new Date(fromMs).getUTCMonth(),
    new Date(fromMs).getUTCDate()
  );
  // Hard cap: a multi-year "all time" range must not build a 10k-point array.
  const MAX_POINTS = 400;
  const span = Math.floor((toMs - start) / DAY_MS) + 1;
  if (span > MAX_POINTS) {
    return [...counts.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }
  for (let t = start; t <= toMs; t += DAY_MS) {
    const key = dayKey(t);
    out.push({ day: key, count: counts.get(key) ?? 0 });
  }
  return out;
}

/**
 * Percentage of `part` out of `whole`, rounded to 1dp. Returns 0 when `whole`
 * is 0 so a fresh install renders "0%" instead of "NaN%".
 */
export function percent(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Number(((part / whole) * 100).toFixed(1));
}

/**
 * Group rows into `{ key, count, sample }` buckets sorted by frequency — used
 * by the Errors page to answer "which failure is happening most, and what does
 * one of them look like?".
 */
export function groupByFrequency<T>(
  rows: readonly T[],
  keyFn: (row: T) => string,
  topN = 10
): { key: string; count: number; sample: T }[] {
  const groups = new Map<string, { count: number; sample: T }>();
  for (const row of rows) {
    const k = keyFn(row);
    const existing = groups.get(k);
    if (existing) existing.count += 1;
    else groups.set(k, { count: 1, sample: row });
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, count: g.count, sample: g.sample }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, topN);
}
