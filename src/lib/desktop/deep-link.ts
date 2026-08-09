/**
 * `framevo://` deep links — the website's "Open Framevo" handoff.
 *
 * ONE module builds them (website) and validates them (Electron main), because
 * the two halves have to agree on an exact grammar for the link to be safe.
 *
 * ── Why validation matters here ────────────────────────────────────────────
 * A custom scheme is an OS-wide entry point: ANY web page, in any browser, can
 * navigate to `framevo://…` and the OS will hand that string to this app. The
 * main process then loads it into the app window. Treating the URL's path as a
 * route to load — which is what a naive handler does — means an arbitrary page
 * decides which screen of a signed-in app opens, with whatever query string it
 * likes attached.
 *
 * So the grammar is a closed allowlist: a fixed set of destinations, an id that
 * must look like an id, and nothing else carried through. Anything unrecognised
 * resolves to the dashboard rather than being passed along.
 *
 * Auth does NOT use this scheme — Google requires a loopback redirect for
 * desktop clients (see desktop/src/main/auth/oauth.ts), so the whole surface
 * here is navigation.
 */

export const DEEP_LINK_SCHEME = "framevo";
/**
 * The authority every website-issued link uses. The app's own internal origin
 * is `framevo://app`, so a distinct host keeps "a link someone clicked" and
 * "the app loading its own assets" from ever being confused for each other.
 */
export const DEEP_LINK_HOST = "open";

export type DeepLinkTarget =
  | { kind: "home" }
  | { kind: "projects" }
  | { kind: "project"; projectId: string }
  | { kind: "exports" }
  | { kind: "settings" }
  | { kind: "billing" };

/** Ids we will route to. Firestore ids and local ids both fit comfortably. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const STATIC_ROUTES: Record<string, DeepLinkTarget> = {
  "/dashboard": { kind: "home" },
  "/dashboard/projects": { kind: "projects" },
  "/dashboard/exports": { kind: "exports" },
  "/dashboard/settings": { kind: "settings" },
  "/dashboard/billing": { kind: "billing" },
};

/** Where a target lives inside the app. */
export function routeForTarget(target: DeepLinkTarget): string {
  switch (target.kind) {
    case "projects":
      return "/dashboard/projects";
    case "project":
      return `/dashboard/projects/${target.projectId}`;
    case "exports":
      return "/dashboard/exports";
    case "settings":
      return "/dashboard/settings";
    case "billing":
      return "/dashboard/billing";
    case "home":
    default:
      return "/dashboard";
  }
}

/** The route an unrecognised or malformed link resolves to. */
export const DEEP_LINK_FALLBACK_ROUTE = "/dashboard";

/**
 * Build a link for the website to navigate to. Returns null for a target that
 * cannot be expressed safely (an id that isn't one), so a caller can't
 * accidentally emit a link this module's own parser would reject.
 */
export function buildDeepLink(target: DeepLinkTarget): string | null {
  if (target.kind === "project" && !ID_PATTERN.test(target.projectId)) return null;
  return `${DEEP_LINK_SCHEME}://${DEEP_LINK_HOST}${routeForTarget(target)}`;
}

/**
 * Validate an incoming link. Returns the resolved target + route, or null when
 * the link is not one of ours or names nothing we recognise — callers then use
 * `DEEP_LINK_FALLBACK_ROUTE` rather than trusting the string.
 *
 * Everything outside the grammar is dropped, including query strings and
 * fragments: no destination here takes a parameter, so carrying one through
 * would only ever be someone else's idea.
 */
export function parseDeepLink(raw: string): { target: DeepLinkTarget; route: string } | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;

  // `framevo://open/dashboard/…` is the canonical form. The app's internal
  // origin (`framevo://app`) is accepted too, so a link the app produced for
  // itself round-trips; anything else is not addressed to this grammar.
  const host = url.hostname.toLowerCase();
  if (host !== DEEP_LINK_HOST && host !== "app") return null;

  // Normalise: strip a trailing slash, reject traversal outright rather than
  // trying to resolve it.
  const path = decodeURIComponent(url.pathname || "").replace(/\/+$/, "") || "/dashboard";
  if (path.includes("..") || path.includes("\\") || !path.startsWith("/")) return null;

  const staticTarget = STATIC_ROUTES[path];
  if (staticTarget) return { target: staticTarget, route: routeForTarget(staticTarget) };

  const projectMatch = /^\/dashboard\/projects\/([^/]+)$/.exec(path);
  if (projectMatch) {
    const projectId = projectMatch[1];
    if (!ID_PATTERN.test(projectId)) return null;
    const target: DeepLinkTarget = { kind: "project", projectId };
    return { target, route: routeForTarget(target) };
  }

  return null;
}

/**
 * The route to load for an incoming link — validated, with the dashboard as the
 * floor. This is what the main process should call: it can never return
 * anything but a route this module authored.
 */
export function resolveDeepLinkRoute(raw: string): string {
  return parseDeepLink(raw)?.route ?? DEEP_LINK_FALLBACK_ROUTE;
}
