"use client";

/**
 * Lazy, browser-only Firebase Analytics (GA4) initialization.
 *
 * `getAnalytics()` touches `window`/`document` and `isSupported()` must run in
 * the browser, so everything here is guarded and lazy:
 *   - `typeof window === "undefined"` → no-op (SSR safe)
 *   - missing measurementId / unsupported env → `isSupported()` false → no-op
 *   - any init error is swallowed (analytics must never break the app)
 *
 * IMPORTANT: never import `firebase/analytics` at the top level of a layout,
 * provider, or server component. Only this module (and `trackEvent`, which
 * imports this) should touch it, and only lazily.
 */

import {
  isSupported,
  getAnalytics,
  logEvent,
  type Analytics,
} from "firebase/analytics";
import { getFirebase, isFirebaseConfigured } from "@/lib/firebase/client";
import { ANALYTICS_ENV } from "./events";

let _analytics: Analytics | null = null;
let _initPromise: Promise<Analytics | null> | null = null;

async function init(): Promise<Analytics | null> {
  if (typeof window === "undefined") return null;
  if (!isFirebaseConfigured()) return null;
  try {
    const supported = await isSupported();
    if (!supported) return null;
    _analytics = getAnalytics(getFirebase().app);
    return _analytics;
  } catch (err) {
    if (ANALYTICS_ENV !== "production") {
      console.error("[analytics] init failed", err);
    }
    return null;
  }
}

/** Resolve the GA4 Analytics instance, or null if unavailable. Cached. */
export function getFirebaseAnalytics(): Promise<Analytics | null> {
  if (_analytics) return Promise.resolve(_analytics);
  if (!_initPromise) _initPromise = init();
  return _initPromise;
}

/** Log a GA4 event. No-ops (never throws) when analytics is unavailable. */
export async function logAnalytics(
  name: string,
  params?: Record<string, unknown>
): Promise<void> {
  try {
    const analytics = await getFirebaseAnalytics();
    if (analytics) {
      logEvent(analytics, name, params as { [key: string]: unknown });
    }
  } catch (err) {
    if (ANALYTICS_ENV !== "production") {
      console.error("[analytics] logEvent failed", name, err);
    }
  }
}
