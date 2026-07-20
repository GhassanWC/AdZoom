/**
 * Query-param parsing, search matching, pagination and view-state selection —
 * the filter layer every admin page shares.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseListParams,
  parseDateInput,
  parsePositiveInt,
  matchesSearch,
  DEFAULT_PAGE_SIZE,
} from "../src/lib/admin/params.ts";
import { paginate } from "../src/lib/admin/scan.ts";
import {
  adminViewState,
  showRefreshError,
  showEmptyRows,
  showTruncationNotice,
} from "../src/components/admin/page-state.ts";

/** Minimal URLSearchParams stand-in matching the `ParamSource` interface. */
function sp(params: Record<string, string>) {
  return { get: (k: string) => (k in params ? params[k] : null) };
}

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

// ── parsePositiveInt / parseDateInput ───────────────────────────────────────

test("parsePositiveInt: clamps hostile input to the fallback", () => {
  assert.equal(parsePositiveInt("5", 1), 5);
  assert.equal(parsePositiveInt("0", 1), 1);
  assert.equal(parsePositiveInt("-3", 1), 1);
  assert.equal(parsePositiveInt("1.5", 1), 1);
  assert.equal(parsePositiveInt("abc", 1), 1);
  assert.equal(parsePositiveInt(null, 7), 7);
  assert.equal(parsePositiveInt("", 7), 7);
});

test("parseDateInput: YYYY-MM-DD → UTC midnight; endOfDay covers the whole day", () => {
  assert.equal(parseDateInput("2026-06-15"), Date.UTC(2026, 5, 15));
  assert.equal(parseDateInput("2026-06-15", true), Date.UTC(2026, 5, 15, 23, 59, 59, 999));
  // An inclusive "to" bound must not cut the selected day off at midnight.
  assert.ok(parseDateInput("2026-06-15", true) > parseDateInput("2026-06-15"));
});

test("parseDateInput: rejects malformed values instead of producing NaN bounds", () => {
  for (const bad of ["", "15-06-2026", "2026/06/15", "garbage", null, undefined]) {
    assert.equal(parseDateInput(bad), 0, `expected 0 for ${String(bad)}`);
  }
});

// ── parseListParams ─────────────────────────────────────────────────────────

test("parseListParams: sane defaults with no params at all", () => {
  const p = parseListParams(sp({}), { now: NOW });
  assert.equal(p.page, 1);
  assert.equal(p.pageSize, DEFAULT_PAGE_SIZE);
  assert.equal(p.search, "");
  assert.equal(p.status, "");
  assert.equal(p.range, "30d");
  assert.equal(p.fromMs, NOW - 30 * 86_400_000);
  assert.equal(p.toMs, 0, "no upper bound unless one was given");
});

test("parseListParams: search is lowercased and trimmed", () => {
  assert.equal(parseListParams(sp({ search: "  ACME Corp " }), { now: NOW }).search, "acme corp");
});

test("parseListParams: explicit from/to OVERRIDE the range preset", () => {
  const p = parseListParams(sp({ range: "today", from: "2026-06-01", to: "2026-06-10" }), {
    now: NOW,
  });
  assert.equal(p.fromMs, Date.UTC(2026, 5, 1));
  assert.equal(p.toMs, Date.UTC(2026, 5, 10, 23, 59, 59, 999));
});

test("parseListParams: a lone `from` still overrides the preset", () => {
  const p = parseListParams(sp({ range: "7d", from: "2026-06-01" }), { now: NOW });
  assert.equal(p.fromMs, Date.UTC(2026, 5, 1));
  assert.equal(p.toMs, 0);
});

test("parseListParams: range=all removes the lower bound", () => {
  assert.equal(parseListParams(sp({ range: "all" }), { now: NOW }).fromMs, 0);
});

test("parseListParams: pageSize is clamped so a huge value can't be forced", () => {
  assert.equal(parseListParams(sp({ pageSize: "100000" }), { now: NOW }).pageSize, 200);
  assert.equal(parseListParams(sp({ pageSize: "-5" }), { now: NOW }).pageSize, DEFAULT_PAGE_SIZE);
});

// ── search matching ─────────────────────────────────────────────────────────

test("matchesSearch: empty search matches everything", () => {
  assert.equal(matchesSearch("", "anything"), true);
  assert.equal(matchesSearch("", null, undefined), true);
});

test("matchesSearch: SUBSTRING across multiple fields (Firestore can't do this)", () => {
  // The old route did an email PREFIX query, so "acme" could not find this.
  assert.equal(matchesSearch("acme", "team-acme@example.com", null), true);
  assert.equal(matchesSearch("acme", null, "Acme Project"), true, "case-insensitive");
  assert.equal(matchesSearch("zzz", "team-acme@example.com", "Acme Project"), false);
});

test("matchesSearch: tolerates null/undefined fields", () => {
  assert.equal(matchesSearch("x", null, undefined, "box"), true);
  assert.equal(matchesSearch("x", null, undefined), false);
});

// ── pagination ──────────────────────────────────────────────────────────────

test("paginate: slices correctly and reports an exact page count", () => {
  const rows = Array.from({ length: 55 }, (_, i) => i);
  const p1 = paginate(rows, 1, 25);
  assert.deepEqual(p1.rows.slice(0, 2), [0, 1]);
  assert.equal(p1.rows.length, 25);
  assert.equal(p1.pageCount, 3);
  assert.equal(p1.total, 55);

  const p3 = paginate(rows, 3, 25);
  assert.equal(p3.rows.length, 5, "last page is partial");
  assert.deepEqual(p3.rows, [50, 51, 52, 53, 54]);
});

test("paginate: clamps an out-of-range page instead of returning nothing", () => {
  const rows = Array.from({ length: 10 }, (_, i) => i);
  assert.equal(paginate(rows, 99, 25).page, 1);
  assert.equal(paginate(rows, 99, 25).rows.length, 10);
  assert.equal(paginate(rows, 0, 25).page, 1);
  assert.equal(paginate(rows, -5, 25).page, 1);
});

test("paginate: EMPTY collection yields page 1 of 1 with no rows", () => {
  const p = paginate([], 1, 25);
  assert.deepEqual(p.rows, []);
  assert.equal(p.total, 0);
  assert.equal(p.pageCount, 1, "never 0 pages — the UI renders 'Page 1 of 1'");
});

// ── view state ──────────────────────────────────────────────────────────────

const base = { loading: false, hasData: false, error: null as string | null, indexBuilding: false };

test("view state: first load shows skeletons", () => {
  assert.equal(adminViewState({ ...base, loading: true }), "loading");
});

test("view state: REFETCH keeps content on screen (the filter-flash bug)", () => {
  // Five of the old pages tested bare `loading`, so changing a filter replaced
  // the entire page — cards, charts and table — with a spinner.
  assert.equal(adminViewState({ ...base, loading: true, hasData: true }), "content");
});

test("view state: hard error only takes over when there is nothing to show", () => {
  assert.equal(adminViewState({ ...base, error: "boom" }), "error");
  assert.equal(adminViewState({ ...base, error: "boom", hasData: true }), "content");
});

test("view state: a FAILED REFRESH shows an inline banner, not a takeover", () => {
  const state = { ...base, error: "network", hasData: true };
  assert.equal(adminViewState(state), "content");
  assert.equal(showRefreshError(state), true);
});

test("view state: no banner when there is no error or no data", () => {
  assert.equal(showRefreshError({ ...base, hasData: true }), false);
  assert.equal(showRefreshError({ ...base, error: "x" }), false);
});

test("view state: index-building outranks content (payload is empty by definition)", () => {
  assert.equal(adminViewState({ ...base, indexBuilding: true, hasData: true }), "index-building");
});

test("view state: an empty RESULT is not an empty PAGE", () => {
  // Cards and charts still describe the window; only the table is replaced.
  assert.equal(showEmptyRows(0, "content"), true);
  assert.equal(showEmptyRows(5, "content"), false);
  assert.equal(showEmptyRows(0, "loading"), false, "no empty state while loading");
  assert.equal(showEmptyRows(0, "error"), false);
});

test("view state: truncation notice only alongside real content", () => {
  assert.equal(showTruncationNotice(true, "content"), true);
  assert.equal(showTruncationNotice(false, "content"), false);
  assert.equal(showTruncationNotice(undefined, "content"), false);
  assert.equal(showTruncationNotice(true, "loading"), false);
});
