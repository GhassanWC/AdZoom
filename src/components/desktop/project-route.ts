/**
 * The desktop app's one dynamic route, described in the one place both halves
 * can see it.
 *
 * The Electron main process rewrites `/dashboard/projects/<anything>` onto the
 * placeholder artifact (see desktop/src/main/protocol-rules.ts); the renderer
 * has to recover the real id from the URL the user is actually on. Keeping the
 * placeholder name and the parser together is what stops the two sides from
 * disagreeing about what a project URL looks like.
 */
export const PROJECT_ROUTE_PREFIX = "/dashboard/projects/";
export const PROJECT_ROUTE_PLACEHOLDER = "__project__";

/**
 * The project id in a pathname, or null when this isn't a project URL.
 *
 * Returns null for the placeholder itself: that path is a build artifact, never
 * somewhere a user should end up, and treating it as an id would send the
 * editor looking for a project called "__project__".
 */
export function projectIdFromPath(pathname: string | null | undefined): string | null {
  if (!pathname || !pathname.startsWith(PROJECT_ROUTE_PREFIX)) return null;
  const rest = pathname.slice(PROJECT_ROUTE_PREFIX.length);
  const segment = rest.split("/")[0] ?? "";
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    /* a malformed escape is simply not an id */
  }
  decoded = decoded.trim();
  if (!decoded || decoded === PROJECT_ROUTE_PLACEHOLDER) return null;
  return decoded;
}

/** The route for a project id. */
export function projectHref(projectId: string): string {
  return `${PROJECT_ROUTE_PREFIX}${encodeURIComponent(projectId)}`;
}
