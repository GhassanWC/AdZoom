/**
 * `GET /api/desktop/latest` — the machine-readable release manifest.
 *
 * One stable URL that outlives any particular host, so the download page, the
 * desktop gate, support scripts and anything checking "what's current?" all
 * read the same record instead of scraping a page or hard-coding a filename.
 *
 * Checksums are part of the response on purpose: a user who wants to verify an
 * installer should be able to get the expected digest from an origin they
 * already trust, not from the same place that served them the file.
 *
 * A DRAFT release is reported honestly (`status: "draft"`, `available: false`)
 * rather than hidden — the download page renders that state, and the desktop
 * gate reads it to decide it must not block web editing yet.
 */
import { NextResponse } from "next/server";
import { CURRENT_RELEASE } from "@/lib/desktop/current-release";
import { isPublished } from "@/lib/desktop/release";

export const runtime = "nodejs";
// Cached at the edge for a few minutes: releases change on the order of weeks,
// and a stale-by-minutes manifest is harmless, but it must not be baked into a
// static build — publishing is a content edit that should take effect on deploy.
export const revalidate = 300;

export function GET() {
  const available = isPublished(CURRENT_RELEASE);
  return NextResponse.json(
    {
      version: CURRENT_RELEASE.version,
      channel: CURRENT_RELEASE.channel,
      status: CURRENT_RELEASE.status,
      available,
      releasedAt: CURRENT_RELEASE.releasedAt,
      notes: CURRENT_RELEASE.notes,
      updateFeedUrl: CURRENT_RELEASE.updateFeedUrl ?? null,
      assets: CURRENT_RELEASE.assets.map((a) => ({
        platform: a.platform,
        arch: a.arch,
        filename: a.filename,
        url: a.url,
        sizeBytes: a.sizeBytes,
        sha256: a.sha256,
        minimumOs: a.minimumOs,
      })),
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
      },
    }
  );
}
