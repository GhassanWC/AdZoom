/**
 * `GET /api/desktop/download` — the stable installer URL.
 *
 * This is the link that goes in emails, docs, the website and anywhere else a
 * URL outlives a build. It resolves the caller's OS and architecture and
 * redirects to the exact artifact; the storage layout underneath can change
 * without invalidating a single published link.
 *
 *   /api/desktop/download                  → detect from the request
 *   /api/desktop/download?platform=macos   → force a platform
 *   /api/desktop/download?platform=windows&arch=arm64
 *
 * Refusals are deliberate and specific rather than a generic 404:
 *
 *   • DRAFT release → 503. The current production download must not be replaced
 *     until the packaged app has passed end-to-end testing, so an unpublished
 *     release refuses to serve rather than handing out an unverified binary.
 *   • Mobile / Linux / anything with no asset → 404 naming what happened, and
 *     browsers get sent to /download where the page explains it in prose.
 *
 * Browsers are redirected to the page; API clients (curl, scripts, anything
 * asking for JSON) get JSON. The difference is decided by `Accept`, so a human
 * clicking a stale link lands somewhere useful and a script gets a parseable
 * error.
 */
import { NextResponse, type NextRequest } from "next/server";
import { CURRENT_RELEASE } from "@/lib/desktop/current-release";
import {
  assetFor,
  isPublished,
  type ReleaseArch,
  type ReleasePlatform,
} from "@/lib/desktop/release";
import { detectPlatform, headerSignals } from "@/lib/desktop/platform-detect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLATFORMS = new Set<ReleasePlatform>(["windows", "macos"]);
const ARCHES = new Set<ReleaseArch>(["x64", "arm64", "universal"]);

/** True when the caller is a browser following a link rather than a script. */
function prefersHtml(req: NextRequest): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

function pageRedirect(req: NextRequest, reason: string): NextResponse {
  const url = new URL("/download", req.nextUrl.origin);
  url.searchParams.set("reason", reason);
  return NextResponse.redirect(url, 302);
}

export function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const requestedPlatform = params.get("platform") as ReleasePlatform | null;
  const requestedArch = params.get("arch") as ReleaseArch | null;

  // An explicit but invalid parameter is a caller error worth naming — silently
  // falling back to detection would send someone a Windows installer because
  // they typed "mac" instead of "macos".
  if (requestedPlatform && !PLATFORMS.has(requestedPlatform)) {
    return NextResponse.json(
      { error: "unsupported_platform", supported: [...PLATFORMS] },
      { status: 400 }
    );
  }
  if (requestedArch && !ARCHES.has(requestedArch)) {
    return NextResponse.json(
      { error: "unsupported_arch", supported: [...ARCHES] },
      { status: 400 }
    );
  }

  if (!isPublished(CURRENT_RELEASE)) {
    if (prefersHtml(req)) return pageRedirect(req, "unreleased");
    return NextResponse.json(
      {
        error: "not_released",
        status: CURRENT_RELEASE.status,
        message:
          "No desktop installer has been published yet. See /download for status.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  const detected = detectPlatform(headerSignals(req.headers));
  const platform = requestedPlatform ?? detected.downloadPlatform;
  const arch = requestedArch ?? detected.arch;

  const asset = assetFor(CURRENT_RELEASE, platform, arch);
  if (!asset) {
    if (prefersHtml(req)) {
      return pageRedirect(req, detected.isMobile ? "mobile" : "unsupported");
    }
    return NextResponse.json(
      {
        error: "no_asset",
        detected: { os: detected.os, arch: detected.arch, mobile: detected.isMobile },
        message: "Framevo Desktop is available for Windows and macOS.",
      },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }

  // 302, not 301: the target changes with every release, and a permanently
  // cached redirect would pin browsers to an old installer forever.
  return NextResponse.redirect(asset.url, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      // Lets a caller confirm what they're about to get without following it.
      "X-Framevo-Version": CURRENT_RELEASE.version,
      "X-Framevo-Sha256": asset.sha256,
      "X-Framevo-Filename": asset.filename,
    },
  });
}
