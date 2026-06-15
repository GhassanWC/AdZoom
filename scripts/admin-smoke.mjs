#!/usr/bin/env node
/**
 * Admin API smoke test — exercises the security gate on every /api/admin/*
 * route against a running server. Read-only (only GET endpoints).
 *
 * Usage:
 *   ADMIN_ID_TOKEN=<firebase id token for ghassanwork29@gmail.com> \
 *   [NONADMIN_ID_TOKEN=<token for some other account>] \
 *   [BASE_URL=http://localhost:3000] \
 *   node scripts/admin-smoke.mjs
 *
 * Asserts, for each endpoint:
 *   • no Authorization header        → 401
 *   • a non-admin token (if provided) → 403
 *   • the admin token                 → 200
 *
 * Get an ID token in the browser console while signed in:
 *   await firebase.auth().currentUser.getIdToken()
 * (or from the app:  await getIdToken()  exposed by useAuth)
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.ADMIN_ID_TOKEN;
const NONADMIN = process.env.NONADMIN_ID_TOKEN;

const ENDPOINTS = [
  "/api/admin/overview",
  "/api/admin/users",
  "/api/admin/projects",
  "/api/admin/analysis",
  "/api/admin/exports",
  "/api/admin/billing",
  "/api/admin/errors",
  "/api/admin/events",
];

if (!ADMIN) {
  console.error("✗ Set ADMIN_ID_TOKEN to a Firebase ID token for the admin account.");
  process.exit(1);
}

let failures = 0;

async function status(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return res.status;
}

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? "✓" : "✗"} ${label} → ${actual} (expected ${expected})`);
  if (!ok) failures += 1;
}

console.log(`\nAdmin API smoke test against ${BASE_URL}\n`);

for (const path of ENDPOINTS) {
  console.log(path);
  check("no token", await status(path, null), 401);
  if (NONADMIN) check("non-admin token", await status(path, NONADMIN), 403);
  check("admin token", await status(path, ADMIN), 200);
}

console.log(
  failures === 0
    ? "\n✓ All admin endpoint security checks passed.\n"
    : `\n✗ ${failures} check(s) failed.\n`
);
process.exit(failures === 0 ? 0 : 1);
