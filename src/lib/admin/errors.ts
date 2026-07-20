/**
 * Error-message normalization for the admin Errors page.
 *
 * Grouping raw `errorMessage` strings by frequency is useless because almost
 * every message embeds something unique — a job id, a Storage path, a byte
 * count, a timestamp. Twenty instances of the same bug appear as twenty
 * distinct one-off errors.
 *
 * `errorSignature` strips the variable parts so the same failure collapses to
 * one bucket, e.g.
 *
 *   "Render failed for job 8f2a-11ee at 00:03:12 (source 41283 bytes)"
 *   "Render failed for job b71c-22ff at 00:07:45 (source 99210 bytes)"
 *     → "render failed for job <id> at <time> (source <n> bytes)"
 *
 * Pure and dependency-free so it is directly unit-testable.
 */

/** Max characters kept in a signature — long stack-ish messages get truncated. */
const MAX_SIGNATURE_LEN = 120;

/**
 * Collapse a raw error message into a stable grouping key.
 *
 * Order matters: the more specific patterns (URLs, paths, uuids, hex) run
 * before the generic number rule, otherwise the digits inside a uuid would be
 * replaced first and the uuid pattern would never match.
 */
export function errorSignature(message: string | null | undefined): string {
  if (!message || typeof message !== "string") return "unknown error";

  let s = message.toLowerCase().trim();

  // URLs and gs:// / file paths → <url> / <path>
  s = s.replace(/\b(?:https?|gs):\/\/\S+/g, "<url>");
  s = s.replace(/\b(?:users|projects|exports)\/\S+/g, "<path>");
  // UUIDs and Firestore-style ids (long alphanumeric runs)
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>");
  s = s.replace(/\b[0-9a-f]{16,}\b/g, "<id>");
  s = s.replace(/\b[a-z0-9]{20,}\b/g, "<id>");
  // Clock times before bare numbers, so 00:03:12 doesn't become <n>:<n>:<n>
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, "<time>");
  // Quoted literals carry per-instance detail (filenames, titles)
  s = s.replace(/"[^"]*"/g, '"<v>"').replace(/'[^']*'/g, "'<v>'");
  // Any remaining number (byte counts, indices, codes)
  s = s.replace(/\b\d[\d.,]*\b/g, "<n>");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  if (s.length > MAX_SIGNATURE_LEN) s = `${s.slice(0, MAX_SIGNATURE_LEN)}…`;
  return s || "unknown error";
}

/**
 * A short human label for an error group. Prefers a structured code when the
 * source provides one (cloud export jobs write `errorCode`), because a code is
 * far more actionable than a prose signature.
 */
export function errorLabel(
  errorCode: string | null | undefined,
  message: string | null | undefined
): string {
  if (errorCode && typeof errorCode === "string" && errorCode.trim()) return errorCode.trim();
  return errorSignature(message);
}
