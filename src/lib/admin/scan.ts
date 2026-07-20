import "server-only";

/**
 * The single Firestore read path for every admin list/aggregate page.
 *
 * WHY ONE SCAN INSTEAD OF count() + A SEPARATE SAMPLE
 * ---------------------------------------------------
 * The old routes issued `.count()` aggregations for the metric cards and a
 * *separate* `orderBy(...).limit(1000)` read for the charts and table. Two
 * query plans, two indexes, two failure modes — and when the count's index was
 * missing, `safeCount` swallowed the error and returned 0 while the sample-fed
 * charts and table still rendered rows. Hence "Total exports: 0" above a table
 * full of exports.
 *
 * `scanWindow` fetches the filtered window ONCE. Routes derive the totals, the
 * chart facets and the table page from that one array (see `aggregate.ts`), so
 * the three can never disagree. When the window hits `cap`, the result is
 * flagged `truncated` and the UI says so explicitly rather than quietly
 * presenting a partial count as a total.
 *
 * TIMESTAMP ENCODING IS NOT UNIFORM IN THIS APP
 * ---------------------------------------------
 * Most collections write `serverTimestamp()` (read back as a `Timestamp`), but
 * `analysisJobs` writes `Date.now()` — a plain number — because its
 * orchestrator runs client-side (see src/lib/firebase/analysis-jobs.ts:36).
 * Firestore's cross-type ordering puts every number BEFORE every timestamp, so
 * a `where(field, ">=", Timestamp)` bound silently matches ZERO numeric docs.
 * `TimeEncoding` makes each caller declare which it is, and `comparand()`
 * builds the matching bound. Getting this wrong produces an empty page with no
 * error — the worst possible failure mode.
 */

import { Timestamp, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";

/** How a collection stores its time field. See the note above — this matters. */
export type TimeEncoding = "timestamp" | "number";

/** Default ceiling on a single scan. Tuned for admin-scale data, not for feeds. */
export const DEFAULT_SCAN_CAP = 4000;

export interface ScanOptions {
  /** Base query: a collection or collection-group, plus any equality filters. */
  query: Query;
  /** Field the window is ordered and range-filtered on (e.g. "createdAt"). */
  orderField: string;
  /** How `orderField` is stored. Wrong value ⇒ silently empty results. */
  encoding: TimeEncoding;
  /** Inclusive lower bound, epoch-ms. 0/undefined = unbounded. */
  fromMs?: number;
  /** Inclusive upper bound, epoch-ms. 0/undefined = unbounded. */
  toMs?: number;
  /** Max docs to materialize. */
  cap?: number;
  /** Log label, e.g. "exports". Never include user data here. */
  label: string;
}

export interface ScanResult {
  docs: QueryDocumentSnapshot[];
  /** True when the window hit `cap` — totals are then a floor, not a total. */
  truncated: boolean;
  /** How many docs were actually read. */
  scanned: number;
}

/** Build the correctly-typed range comparand for a field's storage encoding. */
export function comparand(ms: number, encoding: TimeEncoding): Timestamp | number {
  return encoding === "timestamp" ? Timestamp.fromMillis(ms) : ms;
}

/**
 * Read the whole filtered window (up to `cap`), newest first.
 *
 * Throws on a genuine query failure so the route can distinguish "index still
 * building" (→ friendly UI state) from "broken" (→ 500). It does NOT swallow
 * errors the way the old `safeCount` did — silent zeros were the original bug.
 */
export async function scanWindow(opts: ScanOptions): Promise<ScanResult> {
  const { query, orderField, encoding, fromMs, toMs, label } = opts;
  const cap = opts.cap ?? DEFAULT_SCAN_CAP;

  let q = query;
  if (fromMs && fromMs > 0) q = q.where(orderField, ">=", comparand(fromMs, encoding));
  if (toMs && toMs > 0) q = q.where(orderField, "<=", comparand(toMs, encoding));
  q = q.orderBy(orderField, "desc").limit(cap);

  const snap = await q.get();
  const truncated = snap.docs.length >= cap;
  if (truncated) {
    console.warn(
      `[admin/scan] ${label}: window hit the ${cap}-doc cap; totals are a floor, not a total`
    );
  }
  return { docs: snap.docs, truncated, scanned: snap.docs.length };
}

/**
 * True when an error means "the index for this query does not exist yet".
 * Firestore signals it as gRPC FAILED_PRECONDITION (code 9) with an index URL
 * in the message. Routes turn this into a friendly 200 state rather than a 500,
 * because a freshly-deployed index takes minutes to build.
 */
export function isIndexError(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null | undefined;
  if (!e) return false;
  if (e.code === 9) return true;
  return typeof e.message === "string" && /\bindexe?s?\b/i.test(e.message);
}

/** The owning user's uid for a doc at `users/{uid}/<sub>/{id}`. */
export function uidFromSubDoc(ref: FirebaseFirestore.DocumentReference): string {
  return ref.parent.parent?.id ?? "";
}

/**
 * Slice an in-memory row array into a page.
 *
 * Pagination is offset-based over the scanned window rather than
 * cursor-based over Firestore. That is a deliberate trade: it keeps the page,
 * the totals and the charts derived from ONE array (so they always agree) and
 * it enables substring search and multi-field filters that Firestore itself
 * cannot index. The window cap bounds the cost.
 */
export function paginate<T>(
  rows: readonly T[],
  page: number,
  pageSize: number
): { rows: T[]; page: number; pageCount: number; total: number } {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    page: safePage,
    pageCount,
    total,
  };
}
