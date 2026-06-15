/**
 * Canonical product-analytics event names — the SINGLE vocabulary used for
 * both Google Analytics 4 (via `logFramevoEvent` / `trackEvent`) and the
 * internal admin dashboard (Firestore `analyticsEvents`).
 *
 * Names follow GA4 conventions: `login` and `sign_up` are GA4 *recommended*
 * events (they unlock built-in reports), the rest are custom events. Using a
 * typed const map prevents typos that would silently fragment the data.
 *
 * Adding an event = one line here + the `trackEvent`/`logFramevoEvent` call.
 */

export const EVENTS = {
  // ── Page / marketing (GA4-only via logFramevoEvent) ──────────────────
  PAGE_VIEW: "page_view",
  LANDING_CTA_CLICK: "landing_cta_click",
  PRICING_VIEWED: "pricing_viewed",
  DEMO_CLICKED: "demo_clicked",

  // ── Auth / user ──────────────────────────────────────────────────────
  SIGN_UP: "sign_up", // GA4 recommended event
  LOGIN: "login", // GA4 recommended event
  SIGN_OUT: "sign_out",

  // ── Project / video ──────────────────────────────────────────────────
  PROJECT_CREATED: "project_created",
  PROJECT_DELETED: "project_deleted",
  VIDEO_UPLOAD_STARTED: "video_upload_started",
  VIDEO_UPLOAD_COMPLETED: "video_upload_completed",
  RECORDING_STARTED: "recording_started",
  RECORDING_COMPLETED: "recording_completed",

  // ── Analysis ─────────────────────────────────────────────────────────
  ANALYSIS_STARTED: "analysis_started",
  ANALYSIS_COMPLETED: "analysis_completed",
  ANALYSIS_FAILED: "analysis_failed",
  ANALYSIS_CANCELLED: "analysis_cancelled",
  CHUNKED_ANALYSIS_STARTED: "chunked_analysis_started",
  CHUNKED_ANALYSIS_COMPLETED: "chunked_analysis_completed",

  // ── Engine options ───────────────────────────────────────────────────
  CAMERA_EDITS_ENABLED: "camera_edits_enabled",
  CUTS_ENABLED: "cuts_enabled",
  SPEED_ENABLED: "speed_enabled",
  CHUNK_SIZE_SELECTED: "chunk_size_selected",

  // ── Export ───────────────────────────────────────────────────────────
  EXPORT_STARTED: "export_started",
  EXPORT_COMPLETED: "export_completed",
  EXPORT_FAILED: "export_failed",
  EXPORT_DOWNLOADED: "export_downloaded",
  EXPORT_CANCELLED: "export_cancelled",

  // ── Billing ──────────────────────────────────────────────────────────
  UPGRADE_CLICKED: "upgrade_clicked",
  CHECKOUT_STARTED: "checkout_started",
  CHECKOUT_COMPLETED: "checkout_completed",
  SUBSCRIPTION_CREATED: "subscription_created",
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
