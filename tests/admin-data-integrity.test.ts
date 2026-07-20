/**
 * Malformed-document tolerance, failed-query classification, pricing, error
 * grouping, and the admin AUTHORIZATION guarantee.
 *
 * The theme: a single bad Firestore document, a missing index, or a route that
 * forgets its auth gate must not be able to take down (or open up) the admin.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  str,
  strOrNull,
  num,
  numOrNull,
  bool,
  oneOf,
  arrayLength,
  plainObject,
  mapSafe,
} from "../src/lib/admin/validate.ts";
import { isIndexError, comparand } from "../src/lib/admin/scan.ts";
import { errorSignature, errorLabel } from "../src/lib/admin/errors.ts";
import { isAdminEmail } from "../src/lib/admin/constants.ts";

// ── Field coercion: never throw, never invent ───────────────────────────────

test("str/strOrNull: wrong types fall back rather than propagating garbage", () => {
  assert.equal(str("ok"), "ok");
  assert.equal(str("", "fallback"), "fallback");
  assert.equal(str(undefined, "fallback"), "fallback");
  assert.equal(str(42, "fallback"), "fallback");
  assert.equal(str({ a: 1 }, "fallback"), "fallback");
  assert.equal(strOrNull(""), null);
  assert.equal(strOrNull(123), null);
  assert.equal(strOrNull("x"), "x");
});

test("num/numOrNull: rejects NaN, Infinity and numeric STRINGS", () => {
  assert.equal(num(5), 5);
  assert.equal(num(0), 0);
  assert.equal(num(Number.NaN, -1), -1);
  assert.equal(num(Number.POSITIVE_INFINITY, -1), -1);
  // "42" is a string; coercing it silently would mask a schema drift.
  assert.equal(num("42", -1), -1);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(0), 0, "zero is a real measurement, not absence");
});

test("bool: only a real `true` counts", () => {
  assert.equal(bool(true), true);
  assert.equal(bool("true"), false);
  assert.equal(bool(1), false);
  assert.equal(bool(undefined), false);
});

test("oneOf: an unknown status can't create a phantom chart bucket", () => {
  const allowed = ["ready", "failed"] as const;
  assert.equal(oneOf("ready", allowed, "failed"), "ready");
  assert.equal(oneOf("bogus", allowed, "failed"), "failed");
  assert.equal(oneOf(undefined, allowed, "failed"), "failed");
  assert.equal(oneOf(7, allowed, "failed"), "failed");
});

test("arrayLength: a non-array field yields 0, not a string's length", () => {
  assert.equal(arrayLength([1, 2, 3]), 3);
  assert.equal(arrayLength([]), 0);
  // The trap: "abcde".length would silently report 5 detected moments.
  assert.equal(arrayLength("abcde"), 0);
  assert.equal(arrayLength(undefined), 0);
  assert.equal(arrayLength({ length: 9 }), 0);
});

test("plainObject: arrays and scalars are not free-form metadata", () => {
  assert.deepEqual(plainObject({ a: 1 }), { a: 1 });
  assert.deepEqual(plainObject([1, 2]), {});
  assert.deepEqual(plainObject("x"), {});
  assert.deepEqual(plainObject(null), {});
});

// ── One bad doc costs one row, never the page ───────────────────────────────

test("mapSafe: a throwing document is skipped, the rest still render", () => {
  const docs = [1, 2, 3, 4];
  const { rows, skipped } = mapSafe(
    docs,
    (n) => {
      if (n === 3) throw new Error("corrupt document");
      return n * 10;
    },
    "test"
  );
  assert.deepEqual(rows, [10, 20, 40]);
  assert.equal(skipped, 1);
});

test("mapSafe: an entirely corrupt collection degrades to empty, not a crash", () => {
  const { rows, skipped } = mapSafe(
    [1, 2],
    () => {
      throw new Error("boom");
    },
    "test"
  );
  assert.deepEqual(rows, []);
  assert.equal(skipped, 2);
});

test("mapSafe: empty input is a no-op", () => {
  const { rows, skipped } = mapSafe([], (x) => x, "test");
  assert.deepEqual(rows, []);
  assert.equal(skipped, 0);
});

// ── Failed queries ──────────────────────────────────────────────────────────

test("isIndexError: recognises FAILED_PRECONDITION and index-mentioning messages", () => {
  assert.equal(isIndexError({ code: 9 }), true);
  assert.equal(isIndexError({ message: "The query requires an index. Create it here: ..." }), true);
  assert.equal(isIndexError({ message: "missing indexes for collection group" }), true);
});

test("isIndexError: does NOT swallow unrelated failures as 'index building'", () => {
  assert.equal(isIndexError({ code: 7, message: "PERMISSION_DENIED" }), false);
  assert.equal(isIndexError(new Error("network unreachable")), false);
  assert.equal(isIndexError(null), false);
  assert.equal(isIndexError(undefined), false);
});

test("comparand: encoding decides the type — the silent-empty-page trap", () => {
  // analysisJobs stores startedAt as a plain number (Date.now()). Firestore
  // orders every number before every Timestamp, so a Timestamp bound on a
  // numeric field matches ZERO documents with no error at all.
  assert.equal(comparand(1_700_000_000_000, "number"), 1_700_000_000_000);
  const ts = comparand(1_700_000_000_000, "timestamp");
  assert.notEqual(typeof ts, "number");
  assert.equal((ts as { toMillis(): number }).toMillis(), 1_700_000_000_000);
});

// ── Error grouping ──────────────────────────────────────────────────────────

test("errorSignature: normalizes ids, times and numbers so duplicates collapse", () => {
  const a = errorSignature("Render failed for job 8f2a11ee-1111-2222-3333-444455556666 at 00:03:12 (source 41283 bytes)");
  const b = errorSignature("Render failed for job b71c22ff-9999-8888-7777-666655554444 at 00:07:45 (source 99210 bytes)");
  assert.equal(a, b, "two instances of the same failure must group together");
  assert.match(a, /<id>/);
  assert.match(a, /<time>/);
  assert.match(a, /<n>/);
});

test("errorSignature: normalizes URLs and storage paths", () => {
  const a = errorSignature("Download failed: https://storage.example.com/aaa/bbb.mp4");
  const b = errorSignature("Download failed: https://storage.example.com/ccc/ddd.mp4");
  assert.equal(a, b);
  assert.match(a, /<url>/);
});

test("errorSignature: DIFFERENT failures stay in different groups", () => {
  assert.notEqual(errorSignature("Out of memory"), errorSignature("Codec unsupported"));
});

test("errorSignature: handles absent/blank messages without throwing", () => {
  assert.equal(errorSignature(null), "unknown error");
  assert.equal(errorSignature(undefined), "unknown error");
  assert.equal(errorSignature(""), "unknown error");
  assert.equal(errorSignature("   "), "unknown error");
});

test("errorLabel: prefers a structured error code over a prose signature", () => {
  assert.equal(errorLabel("AUDIO_MISSING", "some long message"), "AUDIO_MISSING");
  assert.equal(errorLabel(null, "Out of memory"), "out of memory");
  assert.equal(errorLabel("  ", "Out of memory"), "out of memory");
});

// ── Authorization ───────────────────────────────────────────────────────────

test("isAdminEmail: only the allow-listed address passes", () => {
  assert.equal(isAdminEmail("ghassanwork29@gmail.com"), true);
  assert.equal(isAdminEmail("GHASSANWORK29@GMAIL.COM"), true, "case-insensitive");
  assert.equal(isAdminEmail("attacker@evil.com"), false);
  assert.equal(isAdminEmail(null), false);
  assert.equal(isAdminEmail(""), false);
});

/**
 * STRUCTURAL AUTH GUARANTEE.
 *
 * Every `/api/admin/*` route must be gated. A unit test can only check the
 * routes it knows about, so instead this walks the directory and asserts the
 * property for whatever is there — a new route added later without a gate fails
 * this test rather than shipping an open endpoint.
 */
test("every /api/admin route is gated by requireAdmin (directly or via adminRoute)", () => {
  const adminApiDir = path.resolve(process.cwd(), "src/app/api/admin");

  const routeFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "route.ts") routeFiles.push(full);
    }
  };
  walk(adminApiDir);

  assert.ok(routeFiles.length >= 8, `expected the admin API routes, found ${routeFiles.length}`);

  for (const file of routeFiles) {
    const src = readFileSync(file, "utf8");
    const rel = path.relative(process.cwd(), file);
    const gated = src.includes("adminRoute(") || src.includes("requireAdmin(");
    assert.ok(gated, `${rel} has NO admin gate — it must use adminRoute() or requireAdmin()`);

    // A route that gates manually must do so before touching Firestore.
    if (!src.includes("adminRoute(") && src.includes("getAdmin()")) {
      assert.ok(
        src.indexOf("requireAdmin(") < src.indexOf("getAdmin()"),
        `${rel} calls getAdmin() before requireAdmin() — data access must never precede the gate`
      );
    }
  }
});
