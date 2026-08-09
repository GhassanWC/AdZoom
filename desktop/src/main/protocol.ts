/**
 * The `framevo://` protocol — how the renderer gets its code AND its video,
 * without a local HTTP server and without `file://`.
 *
 *   framevo://app/…            → the statically exported Next.js app
 *   framevo://app/__media/<id> → the user's video, streamed with Range support
 *
 * Both live on the SAME origin (`framevo://app`) deliberately: the video is
 * then same-origin for the <video> element, for canvas readback (no tainted
 * canvas, so the on-device CV pass and thumbnails work exactly as on the web)
 * and for mediabunny's ranged fetches. A second origin would have re-created
 * every CORS problem the web version already solved.
 *
 * Range support is not optional: seeking in the timeline, mediabunny's decode
 * stack and thumbnail extraction all issue partial requests.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { extname, join } from "node:path";
import { net, protocol } from "electron";
import { logger } from "./logger";

import {
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  MEDIA_PREFIX,
  buildCsp,
  mediaUrl,
  mimeFor,
  parseRange,
  resolveStaticPath,
  rewriteAppPath,
} from "./protocol-rules";

// Re-exported so callers (main, tests) have ONE import site for the protocol.
export {
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  MEDIA_PREFIX,
  PROJECT_ROUTE_PLACEHOLDER,
  PROJECT_ROUTE_PREFIX,
  buildCsp,
  mediaUrl,
  mimeFor,
  parseRange,
  resolveStaticPath,
  rewriteAppPath,
} from "./protocol-rules";

/** Must run BEFORE `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}




async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (s.isFile()) return p;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}


export interface ProtocolOptions {
  /** Directory holding the exported Next app (production), or null in dev. */
  staticRoot: string | null;
  /** Dev server origin to proxy to, or null in production. */
  devServerUrl: string | null;
  /** mediaId → absolute path, or null when unknown/invalid. */
  resolveMedia(mediaId: string): Promise<string | null>;
  csp: string;
}

/** Install the handler. Call AFTER `app.whenReady()`. */
export function installProtocolHandler(options: ProtocolOptions): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== APP_HOST) {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname.startsWith(MEDIA_PREFIX)) {
      return serveMedia(request, url.pathname.slice(MEDIA_PREFIX.length), options);
    }

    // The one dynamic route folds onto its single pre-rendered artifact. Only
    // the file we look up changes; the URL the renderer sees is untouched, so
    // the editor still reads the real project id from `location.pathname`.
    const pathname = rewriteAppPath(url.pathname);

    // Development: the renderer is served by `next dev` so hot reload works.
    // `next dev` resolves the dynamic route on its own, so the request goes
    // through unrewritten — the rewrite exists only for the static export.
    if (options.devServerUrl) {
      const target = new URL(url.pathname + url.search, options.devServerUrl);
      const forwarded = new Headers(request.headers);
      // Nothing downstream benefits from a compressed body — `net.fetch` decodes
      // it here — and asking for one only creates the chance to mislabel it.
      forwarded.delete("accept-encoding");

      const response = await net.fetch(target.toString(), {
        method: request.method,
        headers: forwarded,
      });

      const headers = new Headers(response.headers);
      /**
       * Drop the upstream's FRAMING headers. This is the difference between a
       * working dev run and a window frozen on the splash screen.
       *
       * `next dev` answers with `content-encoding: gzip` and a chunked body.
       * `net.fetch` has already decoded that body, and this handler re-frames
       * whatever it returns — so passing those headers along tells the renderer
       * to gunzip bytes that are already plain, and to stop reading at a length
       * that no longer applies. Chromium gives up mid-document with
       * ERR_UNEXPECTED, which lands exactly where it hurts most: the HTML shell
       * has arrived, but the streamed hydration payload that follows it has not.
       * React never mounts, and the server-rendered "Restoring your session…"
       * stays on screen forever with no error anywhere to explain it.
       */
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      headers.set("content-security-policy", options.csp);
      return new Response(response.body, { status: response.status, headers });
    }

    return serveStatic(pathname, options);
  });
}

async function serveStatic(pathname: string, options: ProtocolOptions): Promise<Response> {
  const root = options.staticRoot;
  if (!root) return new Response("App bundle missing", { status: 500 });

  const base = resolveStaticPath(root, pathname);
  if (!base) {
    logger.warn("blocked path traversal attempt", { pathname });
    return new Response("Forbidden", { status: 403 });
  }

  // Next's static export writes `/route` as `route.html` (and `/` as
  // `index.html`); try the exact file first so assets aren't slowed down.
  const candidates = pathname.endsWith("/")
    ? [join(base, "index.html")]
    : [base, `${base}.html`, join(base, "index.html")];
  let file = await firstExisting(candidates);

  // Unknown path with no extension → the app's shell, so client-side routing
  // still resolves it (a hard reload of a client route must not 404).
  if (!file && !extname(pathname)) file = await firstExisting([join(root, "index.html")]);
  if (!file) return new Response("Not found", { status: 404 });

  const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  const headers = new Headers({
    "content-type": mimeFor(file),
    "cache-control": "no-cache",
  });
  if (file.endsWith(".html")) headers.set("content-security-policy", options.csp);
  return new Response(body, { status: 200, headers });
}

async function serveMedia(
  request: Request,
  rawId: string,
  options: ProtocolOptions
): Promise<Response> {
  const mediaId = rawId.split("/")[0] ?? "";
  const path = await options.resolveMedia(mediaId);
  if (!path) return new Response("Not found", { status: 404 });

  let size: number;
  try {
    const s = await stat(path);
    if (!s.isFile()) return new Response("Not found", { status: 404 });
    size = s.size;
  } catch {
    // The user moved or deleted the file since import — the UI surfaces this
    // as "source missing" via the media revalidation path.
    return new Response("Source file unavailable", { status: 410 });
  }

  const common = {
    "content-type": mimeFor(path),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };

  const range = parseRange(request.headers.get("range"), size);
  if (!range) {
    if (request.headers.get("range")) {
      return new Response(null, {
        status: 416,
        headers: { ...common, "content-range": `bytes */${size}` },
      });
    }
    return new Response(
      Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
      { status: 200, headers: { ...common, "content-length": String(size) } }
    );
  }

  const { start, end } = range;
  return new Response(
    Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>,
    {
      status: 206,
      headers: {
        ...common,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": String(end - start + 1),
      },
    }
  );
}

