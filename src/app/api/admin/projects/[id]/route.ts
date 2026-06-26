/**
 * GET /api/admin/projects/<id>?uid=<uid>
 *
 * Resolves a single project's playable video URL for the admin viewer.
 * Prefers the persisted download URL (`originalVideoUrl`); falls back to a
 * short-lived signed read URL minted from `storagePath` when no download URL
 * was stored. Admin-gated via `requireAdmin` — bypasses per-user ownership so
 * an admin can open any user's video.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";
import type { ProjectDoc } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_MS = 60 * 60 * 1000; // 1 hour

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const uid = req.nextUrl.searchParams.get("uid");
  if (!uid) {
    return NextResponse.json({ error: "Missing uid" }, { status: 400 });
  }

  const { db, storage } = getAdmin();

  try {
    const snap = await db.doc(`users/${uid}/projects/${id}`).get();
    if (!snap.exists) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const data = snap.data() as Partial<ProjectDoc>;

    let videoUrl = data.originalVideoUrl || null;

    // Fall back to a signed read URL when no download URL was persisted.
    if (!videoUrl && data.storagePath) {
      try {
        const [url] = await storage
          .bucket()
          .file(data.storagePath)
          .getSignedUrl({
            action: "read",
            expires: Date.now() + SIGNED_URL_TTL_MS,
          });
        videoUrl = url;
      } catch (err) {
        console.error("[admin/projects/:id] signed-url failed", err);
      }
    }

    if (!videoUrl) {
      return NextResponse.json(
        { error: "No video available for this project" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      id,
      uid,
      title: data.title ?? "Untitled",
      videoUrl,
      exportUrl: data.exportUrl ?? null,
      mimeType: data.mimeType ?? null,
    });
  } catch (err) {
    console.error("[admin/projects/:id] failed", err);
    return NextResponse.json({ error: "Failed to load project" }, { status: 500 });
  }
}
