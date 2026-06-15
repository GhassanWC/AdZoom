"use client";

/**
 * Central client-side analytics helper.
 *
 *   trackEvent(EVENTS.VIDEO_UPLOAD_COMPLETED, { fileSize, duration }, { projectId });
 *
 * Two layers, both best-effort:
 *   1. Firebase Analytics (GA4) — high-level product funnel in Google's console.
 *   2. Firestore `analyticsEvents` — app-owned events for the admin dashboard.
 *
 * Fails SILENTLY (logs only in development) so a tracking error can never
 * break a user flow. Safe to call without awaiting; returns a promise for
 * callers that want to (rarely needed).
 */

import {
  addDoc,
  collection,
  serverTimestamp,
} from "firebase/firestore";
import { getFirebase, isFirebaseConfigured } from "@/lib/firebase/client";
import { logAnalytics } from "./firebaseAnalytics";
import {
  ANALYTICS_COLLECTION,
  ANALYTICS_ENV,
  type EventName,
} from "./events";

/** Cap serialized metadata so a runaway object can't bloat a Firestore doc. */
const MAX_METADATA_BYTES = 4096;

export interface TrackOptions {
  projectId?: string | null;
  /** Plan at the time of the event ("free" | "creator" | "pro" | …). */
  plan?: string | null;
}

/** Defensive metadata cleanup: drop non-serializable values, cap size. */
function safeMetadata(
  metadata?: Record<string, unknown>
): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const json = JSON.stringify(metadata);
    if (json.length > MAX_METADATA_BYTES) {
      return { _truncated: true, _size: json.length };
    }
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function trackEvent(
  eventName: EventName,
  metadata?: Record<string, unknown>,
  opts?: TrackOptions
): Promise<void> {
  try {
    if (!isFirebaseConfigured()) return;
    const { db, auth } = getFirebase();
    const user = auth.currentUser;
    const meta = safeMetadata(metadata);

    // Layer 1 — GA4 (fire-and-forget; its own try/catch inside).
    void logAnalytics(eventName, {
      ...meta,
      projectId: opts?.projectId ?? undefined,
      plan: opts?.plan ?? undefined,
    });

    // Layer 2 — Firestore (admin-dashboard source of truth).
    await addDoc(collection(db, ANALYTICS_COLLECTION), {
      eventName,
      userId: user?.uid ?? "anonymous",
      userEmail: user?.email ?? null,
      projectId: opts?.projectId ?? null,
      plan: opts?.plan ?? null,
      metadata: meta,
      environment: ANALYTICS_ENV,
      timestamp: serverTimestamp(),
    });
  } catch (err) {
    if (ANALYTICS_ENV !== "production") {
      console.error("[trackEvent] failed", eventName, err);
    }
  }
}
