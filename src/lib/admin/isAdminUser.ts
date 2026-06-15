/**
 * Client-safe admin check — used ONLY to hide/show UI (nav links, the admin
 * route guard's first pass). It is NOT a security boundary: the real gate is
 * `requireAdmin()` on every `/api/admin/*` route (see `auth.ts`).
 *
 * Reads `NEXT_PUBLIC_ADMIN_EMAILS` so it works in the browser bundle. This
 * value is intentionally non-secret — knowing which email is admin grants
 * nothing without that account's Firebase credentials.
 */

const DEFAULT_ADMIN_EMAIL = "ghassanwork29@gmail.com";

const CLIENT_ADMIN_EMAILS: readonly string[] = (
  process.env.NEXT_PUBLIC_ADMIN_EMAILS ?? DEFAULT_ADMIN_EMAIL
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

type EmailBearer = { email?: string | null };

/**
 * Accepts a Firebase `User`-like object (`{ email }`), a raw email string, or
 * null/undefined. Returns true when the email is on the client allow-list.
 */
export function isAdminUser(
  input: EmailBearer | string | null | undefined
): boolean {
  const email = typeof input === "string" ? input : input?.email ?? null;
  if (!email) return false;
  return CLIENT_ADMIN_EMAILS.includes(email.toLowerCase());
}
