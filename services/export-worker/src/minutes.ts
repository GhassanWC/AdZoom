/**
 * Worker-side settlement of the double-entry cloud-minute ledger on
 * `users/{uid}/usage/{YYYY-MM}`. The API RESERVED the estimate at enqueue; the
 * worker SETTLES (success) or RELEASES (failure/cancel) exactly once when the
 * job reaches a terminal state. Both are transactional + clamped at 0 so a
 * double-call or a races-with-the-API can't drive the ledger negative.
 */
import { FieldValue, type Firestore } from "firebase-admin/firestore";

interface UsageLedger {
  cloudMinutesReserved?: number;
  cloudMinutesConsumed?: number;
}

/** Success: move `minutes` from reserved → consumed. */
export async function settleMinutes(
  db: Firestore,
  uid: string,
  monthKey: string,
  minutes: number
): Promise<void> {
  if (!(minutes > 0) || !monthKey) return;
  const ref = db.doc(`users/${uid}/usage/${monthKey}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const u = (snap.data() as UsageLedger | undefined) ?? {};
    const reserved = Math.max(0, (u.cloudMinutesReserved ?? 0) - minutes);
    const consumed = Math.max(0, u.cloudMinutesConsumed ?? 0) + minutes;
    tx.set(
      ref,
      {
        cloudMinutesReserved: reserved,
        cloudMinutesConsumed: consumed,
        lastCloudExportAt: Date.now(),
        updatedAt: Date.now(),
      },
      { merge: true }
    );
  });
}

/** Failure/cancel: release the reservation without consuming. */
export async function releaseMinutes(
  db: Firestore,
  uid: string,
  monthKey: string,
  minutes: number
): Promise<void> {
  if (!(minutes > 0) || !monthKey) return;
  const ref = db.doc(`users/${uid}/usage/${monthKey}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const u = (snap.data() as UsageLedger | undefined) ?? {};
    tx.set(
      ref,
      {
        cloudMinutesReserved: Math.max(0, (u.cloudMinutesReserved ?? 0) - minutes),
        updatedAt: Date.now(),
      },
      { merge: true }
    );
  });
}

export { FieldValue };
