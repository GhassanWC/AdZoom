/**
 * Query-string parsing shared by every admin list route.
 *
 * Pure and Firestore-free so the same parsing is unit-tested directly and the
 * client can import `PAGE_SIZES` / `RANGE_OPTIONS` for its own controls. Every
 * parser is total: hostile or malformed input clamps to a safe default instead
 * of throwing or reaching Firestore as an unbounded query.
 */

import { parseRange, rangeSince, type RangeKey } from "./range";

export const DEFAULT_PAGE_SIZE = 25;
export const PAGE_SIZES = [25, 50, 100] as const;
const MAX_PAGE_SIZE = 200;

/** Normalized list-request parameters. */
export interface ListParams {
  page: number;
  pageSize: number;
  /** Free-text search, lowercased and trimmed. Empty = no search. */
  search: string;
  /** Status/kind filter. Empty = all. */
  status: string;
  range: RangeKey;
  /** Inclusive window bounds in epoch-ms. `fromMs === 0` = unbounded. */
  fromMs: number;
  toMs: number;
}

/** A minimal read-only view of URLSearchParams, so tests need no Next types. */
export interface ParamSource {
  get(key: string): string | null;
}

/** Clamp an arbitrary value to a positive integer, else `fallback`. */
export function parsePositiveInt(value: string | null | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Parse a `YYYY-MM-DD` date input into epoch-ms at UTC midnight.
 * `endOfDay` pushes it to 23:59:59.999 so an inclusive "to" bound covers the
 * whole selected day rather than cutting it off at midnight.
 */
export function parseDateInput(
  value: string | null | undefined,
  endOfDay = false
): number {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 0;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return 0;
  return endOfDay ? ms + 86_400_000 - 1 : ms;
}

/**
 * Parse the standard list params.
 *
 * Explicit `from`/`to` win over the `range` preset — the UI switches to a
 * custom range as soon as either date input is set, and sending both would
 * otherwise silently apply the narrower preset.
 */
export function parseListParams(
  sp: ParamSource,
  opts: { defaultPageSize?: number; now?: number } = {}
): ListParams {
  const now = opts.now ?? Date.now();
  const range = parseRange(sp.get("range"));

  const explicitFrom = parseDateInput(sp.get("from"));
  const explicitTo = parseDateInput(sp.get("to"), true);
  const hasExplicit = explicitFrom > 0 || explicitTo > 0;

  const fromMs = hasExplicit ? explicitFrom : rangeSince(range, now);
  const toMs = hasExplicit ? explicitTo : 0;

  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    parsePositiveInt(sp.get("pageSize"), opts.defaultPageSize ?? DEFAULT_PAGE_SIZE)
  );

  return {
    page: parsePositiveInt(sp.get("page"), 1),
    pageSize,
    search: (sp.get("search") ?? "").trim().toLowerCase(),
    status: (sp.get("status") ?? "").trim(),
    range,
    fromMs,
    toMs,
  };
}

/**
 * Case-insensitive substring match across a row's searchable fields.
 *
 * Done in-memory over the scanned window because Firestore supports only
 * prefix matching on a single indexed field — it cannot match "acme" inside
 * "team-acme@x.com", and it cannot search email OR title in one query. The
 * scan cap is what keeps this affordable.
 */
export function matchesSearch(search: string, ...fields: (string | null | undefined)[]): boolean {
  if (!search) return true;
  for (const f of fields) {
    if (typeof f === "string" && f.toLowerCase().includes(search)) return true;
  }
  return false;
}
