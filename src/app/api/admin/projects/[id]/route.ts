/**
 * GET /api/admin/projects/<id>?uid=<uid>
 *
 * Resolves a single project's playable video URLs for the admin viewer, plus a
 * summary of the edits applied to it (AI moments vs. user tweaks, crop, canvas,
 * preset). Lets an admin both watch any user's video AND see at a glance
 * whether — and how — it was edited.
 *
 * `videoUrl` is the raw source (prefers the persisted download URL, falls back
 * to a short-lived signed read URL). `editedVideoUrl` is the exported render
 * with all edits baked in, when one exists.
 *
 * Admin-gated via `requireAdmin` — bypasses per-user ownership.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";
import type {
  Analysis,
  DetectedMoment,
  EffectsSettings,
  ProjectDoc,
  SourceCrop,
} from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_MS = 60 * 60 * 1000; // 1 hour

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface EditsSummary {
  /** Any edits at all — AI-detected moments or a crop. */
  hasEdits: boolean;
  /** At least one edit the user made by hand (added/tweaked moment or manual crop). */
  hasUserEdits: boolean;
  momentCount: number;
  /** Moments produced by analysis (source !== "user"). */
  aiMoments: number;
  /** Moments the user inserted by hand (source === "user"). */
  userMoments: number;
  /** AI moments the user subsequently adjusted (edited, or retargeted the frame). */
  userTweaked: number;
  /** Count per effect type ("zoom", "crop", "cut", …). */
  effectBreakdown: Record<string, number>;
  /** Global frame crop, with whether it was hand-drawn vs auto-seeded. */
  crop: { enabled: boolean; reason: string | null } | null;
  /** Applied preset id, if any. */
  presetId: string | null;
  /** One-line output-canvas description (e.g. "9:16 · smart-fit · blur") or "Source". */
  canvas: string;
  vignette: boolean;
  clickHighlights: boolean;
}

function summarizeEdits(
  analysis: Analysis | undefined,
  effects: EffectsSettings | undefined,
  crop: SourceCrop | undefined,
  presetId: string | undefined
): EditsSummary {
  const moments: DetectedMoment[] = analysis?.detectedMoments ?? [];

  let aiMoments = 0;
  let userMoments = 0;
  let userTweaked = 0;
  const effectBreakdown: Record<string, number> = {};

  for (const m of moments) {
    if (m.source === "user") userMoments += 1;
    else aiMoments += 1;
    // An AI moment the user adjusted: explicitly flagged edited, or the frame
    // was retargeted by hand.
    if (m.source !== "user" && (m.edited || m.targetRegionSource === "user")) {
      userTweaked += 1;
    }
    const key = m.effectType ?? "zoom";
    effectBreakdown[key] = (effectBreakdown[key] ?? 0) + 1;
  }

  const cropSummary = crop
    ? { enabled: !!crop.enabled, reason: crop.reason ?? null }
    : null;
  const cropApplied = !!cropSummary?.enabled;
  // Only a hand-drawn crop counts as a user edit; the bar-cleanup / auto crops
  // are seeded by the pipeline.
  const cropIsManual = cropApplied && cropSummary?.reason === "manual";

  const oc = effects?.outputCanvas;
  const canvas = oc
    ? `${oc.aspectRatio} · ${oc.fitMode} · ${oc.backgroundMode}`
    : "Source";

  return {
    hasEdits: moments.length > 0 || cropApplied,
    hasUserEdits: userMoments > 0 || userTweaked > 0 || cropIsManual,
    momentCount: moments.length,
    aiMoments,
    userMoments,
    userTweaked,
    effectBreakdown,
    crop: cropSummary,
    presetId: presetId ?? null,
    canvas,
    vignette: !!effects?.vignette,
    clickHighlights: !!effects?.clickHighlights,
  };
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

    const edits = summarizeEdits(
      data.analysis,
      data.effectsSettings,
      data.sourceCrop,
      data.selectedPresetId
    );

    // Raw inputs for the live "edited" preview — only when there are edits to
    // show AND effects settings exist to build the render recipe from. The
    // client feeds these to `buildRenderRecipe` + `composeFrame` (the shared
    // export render core) to play the edited result without an export.
    const render =
      edits.hasEdits && data.effectsSettings
        ? {
            moments: data.analysis?.detectedMoments ?? [],
            effects: data.effectsSettings,
            visualAnalysis: data.visualAnalysis ?? null,
            sourceCrop: data.sourceCrop ?? null,
          }
        : null;

    return NextResponse.json({
      id,
      uid,
      title: data.title ?? "Untitled",
      status: data.status ?? null,
      videoUrl,
      // Exported render — has every edit baked in. Null until first export.
      editedVideoUrl: data.exportUrl ?? null,
      mimeType: data.mimeType ?? null,
      edits,
      render,
    });
  } catch (err) {
    console.error("[admin/projects/:id] failed", err);
    return NextResponse.json({ error: "Failed to load project" }, { status: 500 });
  }
}
