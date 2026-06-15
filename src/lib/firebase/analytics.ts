"use client";

/**
 * Public Firebase Analytics (GA4) helper for Framevo.
 *
 * `logFramevoEvent` sends an event to Google Analytics 4 ONLY (no Firestore
 * write) — use it for events that can fire for logged-out visitors (page
 * views, landing/marketing CTAs) or any high-volume event you don't want in
 * the admin dashboard's `analyticsEvents` collection.
 *
 * For authenticated PRODUCT events that should ALSO power the internal admin
 * dashboard, use `trackEvent` from `@/lib/analytics/trackEvent` instead — it
 * dual-writes to GA4 + Firestore.
 *
 * Both paths go through the same lazy, browser-only, SSR-safe GA4
 * initialization in `@/lib/analytics/firebaseAnalytics` and never throw.
 */

import { logAnalytics } from "@/lib/analytics/firebaseAnalytics";
import { EVENTS, type EventName } from "@/lib/analytics/events";

/** Fire a GA4-only event. Safe to call anywhere on the client; no-ops on SSR. */
export function logFramevoEvent(
  name: EventName,
  params?: Record<string, unknown>
): void {
  void logAnalytics(name, params);
}

/** Re-export so callers can `import { logAnalytics } from "@/lib/firebase/analytics"`. */
export { logAnalytics };

/**
 * Events worth marking as conversions ("key events") in the GA4 UI.
 * The first three are the recommended set; the rest are useful funnel steps.
 */
export const CONVERSION_EVENTS: EventName[] = [
  EVENTS.SIGN_UP,
  EVENTS.CHECKOUT_COMPLETED,
  EVENTS.EXPORT_COMPLETED,
];
