import "server-only";

/**
 * Server-side analytics writer (Firebase Admin SDK).
 *
 * Use this for events that originate on the server — where there is no signed-
 * in client to call `trackEvent`, e.g. the analysis route, the Lemon Squeezy
 * billing webhook, checkout. Writes bypass Firestore rules (Admin SDK), so the
 * caller is responsible for passing a trusted `userId`.
 *
 * Always invoke fire-and-forget (`void recordEvent(...)`) — it has its own
 * try/catch and never throws into the request handler, and you don't want
 * analytics latency on a user-facing response.
 */

import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import { ANALYTICS_COLLECTION, ANALYTICS_ENV, type EventName } from "./events";

export interface RecordEventFields {
  userId: string;
  userEmail?: string | null;
  projectId?: string | null;
  plan?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordEvent(
  eventName: EventName,
  fields: RecordEventFields
): Promise<void> {
  try {
    const { db } = getAdmin();
    await db.collection(ANALYTICS_COLLECTION).add({
      eventName,
      userId: fields.userId,
      userEmail: fields.userEmail ?? null,
      projectId: fields.projectId ?? null,
      plan: fields.plan ?? null,
      metadata: fields.metadata ?? {},
      environment: ANALYTICS_ENV,
      timestamp: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // Never let analytics failures affect the request.
    console.error("[recordEvent] failed", eventName, err);
  }
}
