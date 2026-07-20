/**
 * Admin aggregation logic — including the CONSISTENCY INVARIANTS that the
 * dashboard rebuild exists to guarantee.
 *
 * The bug being locked down: "Total exports: 0" rendered above a table full of
 * exports, with the format/resolution charts populated. The cards were fed by
 * `.count()` aggregations that silently returned 0 on a missing index, while
 * the charts and table came from a different query. The invariant tests below
 * assert the property that makes that impossible — every number derives from
 * one array.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  tally,
  toSlices,
  countWhere,
  averageOf,
  medianOf,
  bucketByDay,
  percent,
  groupByFrequency,
} from "../src/lib/admin/aggregate.ts";

interface Row {
  status: string;
  format: string;
  bytes: number | null;
  createdAt: number;
}

const STATUSES = ["queued", "processing", "ready", "cancelled", "failed"] as const;

const rows: Row[] = [
  { status: "ready", format: "mp4", bytes: 100, createdAt: Date.UTC(2026, 5, 1, 10) },
  { status: "ready", format: "mp4", bytes: 200, createdAt: Date.UTC(2026, 5, 1, 12) },
  { status: "ready", format: "webm", bytes: null, createdAt: Date.UTC(2026, 5, 2, 9) },
  { status: "failed", format: "mp4", bytes: null, createdAt: Date.UTC(2026, 5, 3, 9) },
  { status: "processing", format: "webm", bytes: 50, createdAt: Date.UTC(2026, 5, 3, 11) },
];

// ── The consistency contract ────────────────────────────────────────────────

test("INVARIANT: status tally sums to the window total", () => {
  const byStatus = tally(rows, (r) => r.status, STATUSES);
  const sum = Object.values(byStatus).reduce((a, b) => a + b, 0);
  assert.equal(sum, rows.length, "chart segments must sum to the card total");
});

test("INVARIANT: filtering by a status yields exactly that status's tally", () => {
  const byStatus = tally(rows, (r) => r.status, STATUSES);
  for (const s of STATUSES) {
    const filtered = rows.filter((r) => r.status === s);
    assert.equal(
      filtered.length,
      byStatus[s],
      `table row count for status=${s} must equal the card/chart value`
    );
  }
});

test("INVARIANT: a format chart sums to the same total as the status chart", () => {
  const byStatus = tally(rows, (r) => r.status, STATUSES);
  const byFormat = tally(rows, (r) => r.format);
  const statusSum = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const formatSum = Object.values(byFormat).reduce((a, b) => a + b, 0);
  assert.equal(statusSum, formatSum, "two facets of one array must agree");
});

// ── tally / toSlices ────────────────────────────────────────────────────────

test("tally: pre-seeded keys render as explicit zeros, not missing buckets", () => {
  const byStatus = tally(rows, (r) => r.status, STATUSES);
  assert.equal(byStatus.queued, 0, "a zero-count status must still be present");
  assert.ok("cancelled" in byStatus);
  assert.equal(byStatus.ready, 3);
});

test("tally: skips null/undefined/empty keys rather than creating a phantom bucket", () => {
  const withMissing = [{ k: "a" }, { k: "" }, { k: null }, { k: undefined }, { k: "a" }];
  const t = tally(withMissing, (r) => r.k as string | null | undefined);
  assert.deepEqual(t, { a: 2 });
});

test("tally: on an EMPTY collection returns only the seeded zeros", () => {
  const t = tally([] as Row[], (r) => r.status, STATUSES);
  assert.deepEqual(t, { queued: 0, processing: 0, ready: 0, cancelled: 0, failed: 0 });
  assert.equal(Object.values(t).reduce((a, b) => a + b, 0), 0);
});

test("toSlices: sorts by descending value, then by label for ties", () => {
  const slices = toSlices({ b: 2, a: 2, c: 5 });
  assert.deepEqual(slices, [
    { label: "c", value: 5 },
    { label: "a", value: 2 },
    { label: "b", value: 2 },
  ]);
});

test("toSlices: dropZero and topN", () => {
  assert.deepEqual(toSlices({ a: 1, b: 0 }, { dropZero: true }), [{ label: "a", value: 1 }]);
  assert.equal(toSlices({ a: 3, b: 2, c: 1 }, { topN: 2 }).length, 2);
});

// ── numeric aggregates ──────────────────────────────────────────────────────

test("countWhere counts matching rows", () => {
  assert.equal(countWhere(rows, (r) => r.status === "ready"), 3);
  assert.equal(countWhere(rows, (r) => r.bytes != null), 3);
  assert.equal(countWhere([] as Row[], () => true), 0);
});

test("averageOf: ignores nulls and returns NULL (not 0) with no data", () => {
  assert.equal(averageOf(rows, (r) => r.bytes), (100 + 200 + 50) / 3);
  // The distinction that matters: "no measurements" must not render as "0s".
  assert.equal(averageOf(rows, () => null), null);
  assert.equal(averageOf([] as Row[], (r) => r.bytes), null);
});

test("averageOf: rejects NaN and Infinity rather than poisoning the mean", () => {
  const dirty = [{ v: 10 }, { v: Number.NaN }, { v: Number.POSITIVE_INFINITY }, { v: 20 }];
  assert.equal(averageOf(dirty, (r) => r.v), 15);
});

test("medianOf: odd and even counts, and null when empty", () => {
  assert.equal(medianOf([{ v: 3 }, { v: 1 }, { v: 2 }], (r) => r.v), 2);
  assert.equal(medianOf([{ v: 4 }, { v: 1 }, { v: 2 }, { v: 3 }], (r) => r.v), 2.5);
  assert.equal(medianOf([] as { v: number }[], (r) => r.v), null);
});

test("medianOf resists the outlier that skews a mean — why both are reported", () => {
  const withOutlier = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 1000 }];
  assert.equal(medianOf(withOutlier, (r) => r.v), 2.5);
  assert.equal(averageOf(withOutlier, (r) => r.v), 251.5);
});

test("percent: guards divide-by-zero instead of rendering NaN%", () => {
  assert.equal(percent(1, 4), 25);
  assert.equal(percent(0, 0), 0);
  assert.equal(percent(5, 0), 0);
  assert.equal(percent(1, 3), 33.3);
});

// ── day bucketing ───────────────────────────────────────────────────────────

test("bucketByDay: groups by UTC day and fills gaps with zeros", () => {
  const points = bucketByDay(rows, (r) => r.createdAt, {
    fromMs: Date.UTC(2026, 5, 1),
    toMs: Date.UTC(2026, 5, 3, 23, 59),
  });
  assert.deepEqual(points, [
    { day: "2026-06-01", count: 2 },
    { day: "2026-06-02", count: 1 },
    { day: "2026-06-03", count: 2 },
  ]);
});

test("INVARIANT: day buckets sum to the same total as the status tally", () => {
  const points = bucketByDay(rows, (r) => r.createdAt, {
    fromMs: Date.UTC(2026, 5, 1),
    toMs: Date.UTC(2026, 5, 3, 23, 59),
  });
  const chartSum = points.reduce((a, p) => a + p.count, 0);
  assert.equal(chartSum, rows.length, "the chart header total must equal the sum of its bars");
});

test("bucketByDay: a gap day renders as an explicit zero, not a missing point", () => {
  const sparse = [
    { at: Date.UTC(2026, 5, 1, 5) },
    { at: Date.UTC(2026, 5, 4, 5) },
  ];
  const points = bucketByDay(sparse, (r) => r.at, {
    fromMs: Date.UTC(2026, 5, 1),
    toMs: Date.UTC(2026, 5, 4, 23),
  });
  assert.equal(points.length, 4);
  assert.deepEqual(points.map((p) => p.count), [1, 0, 0, 1]);
});

test("bucketByDay: empty input produces no points (and does not throw)", () => {
  assert.deepEqual(bucketByDay([] as Row[], (r) => r.createdAt), []);
});

test("bucketByDay: ignores zero/NaN timestamps from malformed docs", () => {
  const dirty = [{ at: 0 }, { at: Number.NaN }, { at: Date.UTC(2026, 5, 1, 5) }];
  const points = bucketByDay(dirty, (r) => r.at, {
    fromMs: Date.UTC(2026, 5, 1),
    toMs: Date.UTC(2026, 5, 1, 23),
  });
  assert.deepEqual(points, [{ day: "2026-06-01", count: 1 }]);
});

test("bucketByDay: a multi-year span degrades to sparse points instead of a huge array", () => {
  const points = bucketByDay(rows, (r) => r.createdAt, {
    fromMs: Date.UTC(2020, 0, 1),
    toMs: Date.UTC(2026, 11, 31),
  });
  assert.ok(points.length <= 400, "must not build one point per day across years");
  assert.equal(points.reduce((a, p) => a + p.count, 0), rows.length);
});

// ── error grouping ──────────────────────────────────────────────────────────

test("groupByFrequency: ranks by count and keeps a sample of each group", () => {
  const errs = [
    { sig: "timeout", id: 1 },
    { sig: "timeout", id: 2 },
    { sig: "oom", id: 3 },
  ];
  const groups = groupByFrequency(errs, (e) => e.sig);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].key, "timeout");
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].sample.id, 1, "sample is the first occurrence");
  assert.equal(groups[1].key, "oom");
});

test("groupByFrequency: respects topN and handles an empty feed", () => {
  const errs = [{ s: "a" }, { s: "b" }, { s: "b" }, { s: "c" }, { s: "c" }, { s: "c" }];
  assert.equal(groupByFrequency(errs, (e) => e.s, 2).length, 2);
  assert.deepEqual(groupByFrequency([] as { s: string }[], (e) => e.s), []);
});
