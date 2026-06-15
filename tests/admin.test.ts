/**
 * Unit tests for the admin dashboard's pure logic — the security check and the
 * timestamp/range helpers that every API route depends on.
 *
 * Run with:  npm test   (node --test, native TS strip; no test deps)
 *
 * Only modules WITHOUT `@/` path aliases or `server-only` imports are exercised
 * here, so Node's type-stripping can load them via relative paths.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isAdminEmail } from "../src/lib/admin/constants.ts";
import { isAdminUser } from "../src/lib/admin/isAdminUser.ts";
import { tsToMillis, tsToMillisOpt, dayKey } from "../src/lib/admin/serialize.ts";
import { parseRange, rangeSince } from "../src/lib/admin/range.ts";

const ADMIN = "ghassanwork29@gmail.com";

test("isAdminEmail: only the allow-listed email passes (case-insensitive)", () => {
  assert.equal(isAdminEmail(ADMIN), true);
  assert.equal(isAdminEmail(ADMIN.toUpperCase()), true);
  assert.equal(isAdminEmail("someone@else.com"), false);
  assert.equal(isAdminEmail(null), false);
  assert.equal(isAdminEmail(undefined), false);
  assert.equal(isAdminEmail(""), false);
});

test("isAdminUser: accepts user object, raw string, or nullish", () => {
  assert.equal(isAdminUser({ email: ADMIN }), true);
  assert.equal(isAdminUser({ email: "nope@x.com" }), false);
  assert.equal(isAdminUser(ADMIN), true);
  assert.equal(isAdminUser("nope@x.com"), false);
  assert.equal(isAdminUser(null), false);
  assert.equal(isAdminUser(undefined), false);
  assert.equal(isAdminUser({ email: null }), false);
});

test("tsToMillis: coerces Timestamp / number / nullish to epoch-ms", () => {
  assert.equal(tsToMillis(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(tsToMillis({ toMillis: () => 12345 }), 12345);
  assert.equal(tsToMillis(null), 0);
  assert.equal(tsToMillis(undefined), 0);
  assert.equal(tsToMillis(Number.NaN), 0);
});

test("tsToMillisOpt: returns undefined (not 0) when absent", () => {
  assert.equal(tsToMillisOpt(null), undefined);
  assert.equal(tsToMillisOpt(undefined), undefined);
  assert.equal(tsToMillisOpt(0), undefined);
  assert.equal(tsToMillisOpt(999), 999);
});

test("dayKey: epoch-ms → UTC YYYY-MM-DD", () => {
  assert.equal(dayKey(Date.UTC(2026, 5, 15, 13, 0, 0)), "2026-06-15");
});

test("parseRange: valid values pass; anything else defaults to 30d", () => {
  for (const v of ["today", "7d", "30d", "all"] as const) {
    assert.equal(parseRange(v), v);
  }
  assert.equal(parseRange("garbage"), "30d");
  assert.equal(parseRange(null), "30d");
  assert.equal(parseRange(undefined), "30d");
});

test("rangeSince: all=0, today=UTC midnight, windows subtract correctly", () => {
  const now = Date.UTC(2026, 5, 15, 13, 30, 0);
  assert.equal(rangeSince("all", now), 0);
  assert.equal(rangeSince("today", now), Date.UTC(2026, 5, 15, 0, 0, 0));
  assert.equal(rangeSince("7d", now), now - 7 * 86_400_000);
  assert.equal(rangeSince("30d", now), now - 30 * 86_400_000);
});
