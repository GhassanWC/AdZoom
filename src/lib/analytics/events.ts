/**
 * Canonical product-analytics event names.
 *
 * Using a typed const map (rather than bare strings at call sites) prevents
 * typos that would silently fragment the analytics data. Both the client
 * `trackEvent` and the server `recordEvent` accept an `EventName`.
 *
 * This is the "core" set instrumented today. Adding a new event is a one-line
 * addition here plus the `trackEvent(...)` call — the helper, Firestore rules,
 * and admin Events page handle arbitrary names automatically.
 */

export const EVENTS = {
  // ── Auth / user ──────────────────────────────────────────────────────
  SIGN_IN: "sign_in",
  SIGN_OUT: "sign_out",
  USER_CREATED: "user_created",

  // ── Project / video ──────────────────────────────────────────────────
  VIDEO_UPLOADED: "video_uploaded",
  PROJECT_CREATED: "project_created",
  PROJECT_DELETED: "project_deleted",
  RECORDING_STARTED: "recording_started",
  RECORDING_SAVED: "recording_saved",

  // ── Analysis ─────────────────────────────────────────────────────────
  ANALYSIS_STARTED: "analysis_started",
  ANALYSIS_COMPLETED: "analysis_completed",
  ANALYSIS_FAILED: "analysis_failed",
  ANALYSIS_CANCELLED: "analysis_cancelled",

  // ── Export ───────────────────────────────────────────────────────────
  EXPORT_REQUESTED: "export_requested",
  EXPORT_COMPLETED: "export_completed",
  EXPORT_FAILED: "export_failed",

  // ── Billing ──────────────────────────────────────────────────────────
  CHECKOUT_STARTED: "checkout_started",
  SUBSCRIPTION_ACTIVATED: "subscription_activated",
  SUBSCRIPTION_CANCELLED: "subscription_cancelled",
  PAYMENT_SUCCESS: "payment_success",

  // ── Errors ───────────────────────────────────────────────────────────
  ERROR_OCCURRED: "error_occurred",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** The Firestore collection that stores app-owned analytics events. */
export const ANALYTICS_COLLECTION = "analyticsEvents";

/** Resolved at module load; "production" only in prod builds. */
export const ANALYTICS_ENV: "production" | "development" =
  process.env.NODE_ENV === "production" ? "production" : "development";
