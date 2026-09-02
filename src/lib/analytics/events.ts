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

  // ── Editorial Engine (Phase 1) ───────────────────────────────────────
  // COUNTS AND ENUMS ONLY in the metadata (template id, policy mode, intent /
  // mode / target enums, per-type counts, confidence-bucket histograms, gate
  // drop counts). Never a label, a hook line, a reason sentence, or any other
  // user-authored text — pinned by tests/editorial-telemetry.test.ts.
  /** Fired at analyze finalize: what was generated under which template. */
  EDITS_GENERATED: "edits_generated",
  /** Phase 2 wiring: the export-time kept/modified/disabled/deleted diff. */
  EDITS_OUTCOME: "edits_outcome",
  /** Phase 2 wiring: Director chat "fewer/none X" pushback (editType + direction). */
  DIRECTOR_PUSHBACK: "director_pushback",

  // ── Engine options ───────────────────────────────────────────────────
  CAMERA_EDITS_ENABLED: "camera_edits_enabled",
  CUTS_ENABLED: "cuts_enabled",
  SPEED_ENABLED: "speed_enabled",
  CHUNK_SIZE_SELECTED: "chunk_size_selected",

  // ── Captions / transcription ─────────────────────────────────────────
  // SEPARATE lifecycle from AI edits (the ANALYSIS_* events above are the
  // AI-edit started/completed/failed) — captions succeed/fail/block on
  // their own without affecting those.
  CAPTION_TRANSCRIPTION_STARTED: "caption_transcription_started",
  CAPTION_TRANSCRIPTION_COMPLETED: "caption_transcription_completed",
  CAPTION_TRANSCRIPTION_FAILED: "caption_transcription_failed",
  CAPTION_QUOTA_BLOCKED: "caption_quota_blocked",
  CAPTION_DISABLED: "caption_disabled",

  // ── Smart Clips ──────────────────────────────────────────────────────
  // COUNTS ONLY in the metadata (duration, moment/attention/clip counts, a
  // transcript-available boolean). Never the transcript text or any clip title.
  CLIPS_GENERATE_CLICKED: "clips_generate_clicked",
  CLIPS_GENERATION_STARTED: "clips_generation_started",
  CLIPS_GENERATION_COMPLETED: "clips_generation_completed",
  CLIPS_GENERATION_EMPTY: "clips_generation_empty",
  CLIPS_GENERATION_FAILED: "clips_generation_failed",
  CLIPS_GENERATION_FALLBACK_USED: "clips_generation_fallback_used",

  // ── Export ───────────────────────────────────────────────────────────
  EXPORT_STARTED: "export_started",
  EXPORT_COMPLETED: "export_completed",
  EXPORT_FAILED: "export_failed",
  EXPORT_DOWNLOADED: "export_downloaded",
  EXPORT_CANCELLED: "export_cancelled",

  // ── Editframe beta export (browser-side; SEPARATE lifecycle from the
  // cloud/browser EXPORT_* events above — never touches cloud minutes/usage) ─
  EDITFRAME_EXPORT_STARTED: "editframe_export_started",
  EDITFRAME_EXPORT_COMPLETED: "editframe_export_completed",
  EDITFRAME_EXPORT_FAILED: "editframe_export_failed",
  EDITFRAME_EXPORT_CANCELLED: "editframe_export_cancelled",
  EDITFRAME_UNSUPPORTED_BROWSER: "editframe_unsupported_browser",
  EDITFRAME_UNSUPPORTED_EDIT: "editframe_unsupported_edit",

  // ── Billing ──────────────────────────────────────────────────────────
  UPGRADE_CLICKED: "upgrade_clicked",
  CHECKOUT_STARTED: "checkout_started",
  CHECKOUT_COMPLETED: "checkout_completed",
  SUBSCRIPTION_CREATED: "subscription_created",
  SUBSCRIPTION_CANCELLED: "subscription_cancelled",
  PAYMENT_SUCCESS: "payment_success",

  // ── Desktop app distribution ─────────────────────────────────────────
  // The funnel from "saw the website" to "editing in the app": which OS was
  // detected, whether a download was actually started, whether the deep link
  // found an installed app, and whether the app ever launched. Metadata is
  // platform/arch/version only — never a file path or a machine identifier.
  DESKTOP_DOWNLOAD_PAGE_VIEWED: "desktop_download_page_viewed",
  DESKTOP_DOWNLOAD_CLICKED: "desktop_download_clicked",
  /** The website asked the OS to launch Framevo via a framevo:// link. */
  DESKTOP_DEEP_LINK_ATTEMPTED: "desktop_deep_link_attempted",
  /** The page never lost focus, so no handler took the link — app not installed. */
  DESKTOP_DEEP_LINK_FAILED: "desktop_deep_link_failed",
  /** The blocking "editing happens in the app" dialog was shown on the web. */
  DESKTOP_GATE_SHOWN: "desktop_gate_shown",
  /** A visitor on a phone/tablet was told editing needs a computer. */
  DESKTOP_MOBILE_NOTICE_SHOWN: "desktop_mobile_notice_shown",
  /** First launch of a freshly installed build (sent by the app itself). */
  DESKTOP_APP_INSTALLED: "desktop_app_installed",
  /** Any launch of the desktop app, once per session. */
  DESKTOP_APP_OPENED: "desktop_app_opened",
  /** The app received and resolved a framevo:// link. */
  DESKTOP_DEEP_LINK_OPENED: "desktop_deep_link_opened",

  // ── Errors ───────────────────────────────────────────────────────────
  ERROR_OCCURRED: "error_occurred",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** The Firestore collection that stores app-owned analytics events. */
export const ANALYTICS_COLLECTION = "analyticsEvents";

/** Resolved at module load; "production" only in prod builds. */
export const ANALYTICS_ENV: "production" | "development" =
  process.env.NODE_ENV === "production" ? "production" : "development";
