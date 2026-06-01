/**
 * Centralized brand constants. Every user-facing reference to the
 * product name, domain, contact email, or marketing tagline should
 * come from here so a future rename is a one-file change.
 *
 * Long-form prose in marketing pages (about / pricing / docs / legal)
 * can still use the literal "Framevo" inline — refactoring 100+ inline
 * mentions to `{BRAND.name}` would hurt readability for no real gain.
 * The leverage points (page titles, logo wordmark, hero, login, chat
 * header, manifest) DO go through this file so they stay in sync.
 */

export const BRAND = {
  name: "Framevo",
  shortName: "Framevo",
  tagline: "AI-powered screen recording editor",
  /** Long-form marketing tagline used on the hero. */
  longTagline: "AI video editing that follows the action.",
  domain: "framevo.app",
  url: "https://framevo.app",
  /**
   * Public-facing support / contact email. Use this for every mailto
   * link, every help-center reference, every "email us" CTA in legal
   * pages, billing pages, and notification bodies.
   *
   * Technical SMTP / sender identity for transactional email is
   * configured separately (out of scope for this constant).
   */
  supportEmail: "support@framevo.app",
  /** Hex colors used by the brand mark (also used by the PWA manifest). */
  colors: {
    primaryFrom: "#A78BFA",
    primaryTo: "#7C3AED",
    recordingDot: "#EF4444",
    backgroundDark: "#08090C",
    themeColor: "#8B5CF6",
  },
} as const;

/** Page title strings, composed from BRAND.name. */
export const PAGE_TITLE = {
  landing: `${BRAND.name} — ${BRAND.longTagline.replace(/\.$/, "")}`,
  dashboard: `${BRAND.name} — Editor`,
  record: `${BRAND.name} — Record`,
  login: `Sign in — ${BRAND.name}`,
  pricing: `Pricing — ${BRAND.name}`,
  docs: `Docs — ${BRAND.name}`,
  apiReference: `API Reference — ${BRAND.name}`,
} as const;

/** Common UI strings that need the brand name interpolated. */
export const BRAND_STRINGS = {
  signInTo: `Sign in to ${BRAND.name}`,
  askBrand: `Ask ${BRAND.name}`,
  brandAssistantOffline: `${BRAND.name}'s assistant is offline right now — email ${BRAND.supportEmail}.`,
  brandAssistantError: `Sorry — ${BRAND.name}'s assistant hit an error. Try again in a moment, or email ${BRAND.supportEmail}.`,
} as const;
