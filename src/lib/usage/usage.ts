import "server-only";

import { getAdmin } from "@/lib/firebase/admin";
import type { MonthlyUsage } from "@/lib/firebase/schema";

/**
 * Per-month, per-user export counters. Stored at
 * `users/{uid}/usage/{YYYY-MM}`. Server-only writes — Firestore rules forbid
 * client writes to this subcollection so a malicious client can't zero out
 * their count.
 *
 * The month bucket is derived from `Date.now()` at increment time using the
 * UTC calendar. There's no anniversary alignment with the subscription's
 * renewal date; this is the standard "calendar month" model that's easiest
 * for users to reason about ("you've used 3 of 5 exports this month").
 */

/** "YYYY-MM" key for the doc id, in UTC. */
export function currentMonthKey(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Atomically read + increment the current month's export counter and return
 * the new value. Used by `/api/billing/export-permit` so the counter is
 * advanced BEFORE the client renders — preventing double-spend on rapid
 * clicks.
 *
 * Caller should check `canExport()` / `getRemainingExports()` first to give
 * the user a clean error. This helper assumes the caller has already
 * verified the user is under their limit (it doesn't read the plan).
 */
export async function incrementExportUsage(uid: string): Promise<MonthlyUsage> {
  const { db } = getAdmin();
  const ref = db.doc(`users/${uid}/usage/${currentMonthKey()}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists
      ? (snap.data() as MonthlyUsage)
      : ({ exportCount: 0, updatedAt: 0 } as MonthlyUsage);
    const now = Date.now();
    const next: MonthlyUsage = {
      exportCount: (prev.exportCount ?? 0) + 1,
      lastExportAt: now,
      updatedAt: now,
    };
    tx.set(ref, next, { merge: true });
    return next;
  });
}

/**
 * Read the user's current month's usage doc. Returns a zero-value default
 * if the doc doesn't exist yet (a new user, or the first export of a new
 * month). Always safe to call — no writes.
 */
export async function getMonthlyUsage(uid: string): Promise<MonthlyUsage> {
  const { db } = getAdmin();
  const snap = await db.doc(`users/${uid}/usage/${currentMonthKey()}`).get();
  if (!snap.exists) {
    return { exportCount: 0, updatedAt: 0 };
  }
  const data = snap.data() as MonthlyUsage;
  return {
    exportCount: data.exportCount ?? 0,
    lastExportAt: data.lastExportAt,
    updatedAt: data.updatedAt ?? 0,
  };
}
