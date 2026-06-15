/**
 * Admin allow-list (server-side source of truth).
 *
 * Only these emails may access the admin dashboard and its APIs. Configurable
 * via the `ADMIN_EMAILS` env var (comma-separated); defaults to the single
 * owner account so the feature works out of the box.
 *
 * This is a SERVER module — the value is read from `process.env.ADMIN_EMAILS`
 * which is not exposed to the browser. The client-side mirror lives in
 * `isAdminUser.ts` (reads `NEXT_PUBLIC_ADMIN_EMAILS`, used only to hide UI).
 */

const DEFAULT_ADMIN_EMAIL = "ghassanwork29@gmail.com";

export const ADMIN_EMAILS: readonly string[] = (
  process.env.ADMIN_EMAILS ?? DEFAULT_ADMIN_EMAIL
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/** True when `email` is on the admin allow-list (case-insensitive). */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}
