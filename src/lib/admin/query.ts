import "server-only";

/**
 * Shared Firestore-query helpers for the admin API routes.
 *
 * All cross-user aggregation runs through the Admin SDK (which bypasses
 * security rules) using collection-group queries over the per-user
 * subcollections (`projects`, `exports`, `analysisJobs`). The collection-group
 * indexes (and field overrides for single-field group orderings) are declared
 * in `firestore.indexes.json`.
 */

import { Timestamp, type Query } from "firebase-admin/firestore";

/** Firestore comparand for a `serverTimestamp()` field (stored as Timestamp). */
export function tsComparand(sinceMs: number): Timestamp {
  return Timestamp.fromMillis(sinceMs);
}

/**
 * Run a `.count()` aggregation, returning the count or `null` on error
 * (e.g. a still-building index). Lets a single metric degrade gracefully
 * instead of failing the whole response.
 */
export async function safeCount(q: Query): Promise<number | null> {
  try {
    const snap = await q.count().get();
    return snap.data().count;
  } catch (err) {
    console.error("[admin/query] count failed", err);
    return null;
  }
}

/**
 * True when an error is a "missing/building index" condition. Firestore's
 * gRPC FAILED_PRECONDITION is code 9; the message also mentions an index.
 * Routes use this to return `{ indexBuilding: true }` (HTTP 200) so the UI
 * can show a friendly "indexes building" state rather than a 500.
 */
export function isIndexError(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null | undefined;
  if (!e) return false;
  if (e.code === 9) return true;
  return typeof e.message === "string" && /\bindex(es)?\b/i.test(e.message);
}

/** The owning user's uid for a doc that lives in `users/{uid}/<sub>/...`. */
export function uidFromSubDoc(
  ref: FirebaseFirestore.DocumentReference
): string {
  return ref.parent.parent?.id ?? "";
}
