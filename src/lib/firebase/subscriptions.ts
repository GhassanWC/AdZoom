"use client";

import { doc, onSnapshot, type Unsubscribe } from "firebase/firestore";
import { getFirebase } from "./client";
import type { Subscription } from "./schema";

/**
 * Real-time listener on `subscriptions/{uid}`. Calls back with the current
 * subscription doc (or `null` while the user is still on free / before the
 * first webhook lands).
 *
 * Returns an unsubscribe — call on unmount.
 */
export function subscribeSubscription(
  uid: string,
  cb: (sub: Subscription | null) => void
): Unsubscribe {
  const { db } = getFirebase();
  const ref = doc(db, "subscriptions", uid);
  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        cb(null);
        return;
      }
      cb(snap.data() as Subscription);
    },
    (err) => {
      console.warn("[subscribeSubscription] listen failed", err);
      cb(null);
    }
  );
}
