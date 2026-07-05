/**
 * Captions-only endpoint — the ONE server entry point for the dedicated
 * "Generate AI Captions" action. Completely separate from
 * /api/projects/[id]/analyze (which no longer starts ASR or touches captions).
 *
 * Runs the captions request pipeline: language resolution, transcript reuse,
 * per-video + monthly caption-quota enforcement, atomic reservation, and
 * dispatch to the shared transcription worker (which generates the caption
 * moments and commits/releases the reservation). Server-side duplicate
 * protection means a repeated call cannot reserve quota twice, call Google
 * twice, or duplicate caption moments.
 *
 * Auth: Bearer ID token (same as the analyze route).
 */
import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requestCaptions, captionResultHttpStatus } from "@/lib/transcript/caption-request";
import type { TranscriptLanguageMode } from "@/lib/transcript/language";
import type { CaptionPosition, OverlayTextPreset } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: projectId } = await ctx.params;
  const { auth } = getAdmin();

  const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
  const idToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  let uid: string;
  try {
    uid = (await auth.verifyIdToken(idToken)).uid;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    mode?: TranscriptLanguageMode;
    code?: string;
    locale?: string;
    force?: boolean;
    stylePreset?: OverlayTextPreset;
    position?: CaptionPosition;
  } | null;

  const result = await requestCaptions({
    uid,
    projectId,
    mode: body?.mode === "selected" ? "selected" : "auto",
    code: body?.code,
    locale: body?.locale,
    force: body?.force === true,
    stylePreset: body?.stylePreset,
    position: body?.position,
  });

  return NextResponse.json(result, { status: captionResultHttpStatus(result) });
}
