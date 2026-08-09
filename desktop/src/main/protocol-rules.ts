/**
 * The pure rules behind the `framevo://` protocol: path resolution, range
 * parsing, MIME mapping and the Content-Security-Policy.
 *
 * Deliberately free of any `electron` import so these can be unit-tested in a
 * plain Node process — they are the security-critical half of the handler
 * (a path that escapes the bundle, or a range parsed wrongly, is a real bug
 * class), and a test that needs a full Electron runtime to run is a test that
 * stops being run.
 */
import { extname, join, normalize, sep } from "node:path";

export const APP_SCHEME = "framevo";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
/** Reserved path prefix for media streaming (never a real app route). */
export const MEDIA_PREFIX = "/__media/";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The single dynamic route, and how a static export can serve it.
 *
 * `/dashboard/projects/[id]` cannot be pre-rendered per project — the library
 * grows at runtime. `next build` therefore emits ONE artifact for the segment,
 * under a reserved placeholder id, and every real project id is rewritten onto
 * it here. The page reads its actual id from `location.pathname`, which is
 * untouched: the rewrite happens on the way to the FILE, never to the URL.
 *
 * This is what makes a packaged deep link (`framevo://app/dashboard/projects/
 * abc123`), a reload, and a restart all land on the right project instead of a
 * 404 — and it covers Next's RSC payload requests for the same route, which is
 * how client-side navigation into the editor resolves.
 */
export const PROJECT_ROUTE_PREFIX = "/dashboard/projects/";
export const PROJECT_ROUTE_PLACEHOLDER = "__project__";

export function rewriteAppPath(pathname: string): string {
  if (!pathname.startsWith(PROJECT_ROUTE_PREFIX)) return pathname;
  const rest = pathname.slice(PROJECT_ROUTE_PREFIX.length);
  if (!rest) return pathname;
  const slash = rest.indexOf("/");
  const segment = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? "" : rest.slice(slash);
  // Already the placeholder (or one of its payload files) — leave it alone.
  if (segment === PROJECT_ROUTE_PLACEHOLDER) return pathname;
  // `/dashboard/projects/abc.txt` is the RSC payload for `/…/abc`; keep the
  // extension so the placeholder's payload is what gets served.
  const dot = segment.lastIndexOf(".");
  const extension = dot > 0 ? segment.slice(dot) : "";
  return `${PROJECT_ROUTE_PREFIX}${PROJECT_ROUTE_PLACEHOLDER}${extension}${tail}`;
}

/**
 * The remote origins the app is allowed to reach: its own API plus Firebase.
 *
 * Shared by `connect-src` AND `media-src`, because a cloud project's video is
 * fetched by BOTH — mediabunny issues ranged `fetch`es against it, and the
 * preview `<video>` streams it directly. Listing it for one and not the other
 * is exactly the bug this function now prevents: `media-src` was
 * `'self' blob: data:`, so every Firebase Storage video was blocked with
 * "Refused to load media … violates the following Content Security Policy
 * directive", and only projects stored locally would play.
 */
function remoteOrigins(apiBase: string, dev: boolean): string[] {
  const api = apiBase ? new URL(apiBase).origin : "";
  return [
    api,
    // Firebase Storage download URLs (`firebasestorage.googleapis.com`) and the
    // bucket host used by resumable/large objects.
    "https://*.googleapis.com",
    "https://firebasestorage.googleapis.com",
    "https://storage.googleapis.com",
    "https://*.google.com",
    "https://*.firebaseio.com",
    "https://*.cloudfunctions.net",
    dev ? "http://localhost:*" : "",
  ].filter(Boolean);
}

/**
 * Content-Security-Policy for the app document.
 *
 * `script-src 'unsafe-inline'` is required because a static Next export inlines
 * its bootstrap (and the theme flash-prevention script) — there is no server to
 * mint a nonce. Everything else is locked down: no remote scripts, no eval in
 * production, and the remote origins are enumerated rather than wildcarded to
 * `https:`. `frame-ancestors 'none'` and `object-src 'none'` close the classic
 * embedding/plugin holes.
 */
export function buildCsp(apiBase: string, dev: boolean): string {
  const remote = remoteOrigins(apiBase, dev);
  const connect = [
    "'self'",
    ...remote,
    "wss://*.firebaseio.com",
    dev ? "ws://localhost:*" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // `blob:` for in-browser renders and recordings; `data:` for tiny generated
  // clips. The remote origins are what make a CLOUD project playable.
  const media = ["'self'", "blob:", "data:", ...remote].join(" ");

  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `media-src ${media}`,
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Resolve a URL path inside `root`, refusing anything that escapes it. */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  const decoded = safeDecode(urlPath.split("?")[0]!.split("#")[0]!);
  if (decoded === null) return null;
  const cleaned = decoded.replace(/^\/+/, "");
  const candidate = normalize(join(root, cleaned));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return null;
  return candidate;
}

/** A malformed escape sequence is a rejected request, not a crash. */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Parse `bytes=start-end`. Returns null when absent/unsatisfiable. */
export function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix range: the LAST n bytes (mp4 moov atoms are often read this way).
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** The renderer-facing URL for a media id. */
export function mediaUrl(mediaId: string): string {
  return `${APP_ORIGIN}${MEDIA_PREFIX}${mediaId}`;
}
