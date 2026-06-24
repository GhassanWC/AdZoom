import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { createCloudExportJob } from "@/lib/export/create-job";
import { isCloudExportEnabled } from "@/lib/export/feature";
import type {
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
  SourceCrop,
  VisualAnalysis,
} from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CloudExportBody {
  projectId?: string;
  projectTitle?: string;
  resolution?: "1080p" | "4K";
  fps?: 30 | 60;
  format?: ExportFormat;
  /** Live editor render state (what the browser exporter would use). */
  sourceWidth?: number;
  sourceHeight?: number;
  sourceDuration?: number;
  moments?: DetectedMoment[];
  effects?: EffectsSettings;
  sourceCrop?: SourceCrop | null;
  visualAnalysis?: VisualAnalysis;
}

/**
 * POST /api/export/cloud
 *
 * Creates (or DEDUPLICATES to) a server-side cloud MP4 export job. The heavy
 * lifting — ownership, settingsHash dedup, stale-job cleanup, plan/minute gating,
 * recipe build, atomic reserve+create, and dispatch — lives in the shared
 * `createCloudExportJob` so this route and `/api/export/retry` behave identically.
 * This handler only verifies the token, validates the body, and maps the result.
 */
export async function POST(req: NextRequest) {
  try {
    if (!isCloudExportEnabled()) {
      return NextResponse.json(
        { error: "Cloud export is not enabled.", kind: "cloud_export_disabled" },
        { status: 503 }
      );
    }

    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
    }

    const { auth, db } = getAdmin();
    let uid: string;
    try {
      const decoded = await auth.verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (err) {
      console.error("[export-cloud] token verify failed", err);
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as CloudExportBody;
    const { projectId, projectTitle, resolution, fps, format } = body;
    if (
      typeof projectId !== "string" ||
      typeof projectTitle !== "string" ||
      (resolution !== "1080p" && resolution !== "4K") ||
      (fps !== 30 && fps !== 60) ||
      (format !== "Source" &&
        format !== "TikTok 9:16" &&
        format !== "YouTube 16:9" &&
        format !== "Custom") ||
      !Array.isArray(body.moments) ||
      typeof body.effects !== "object" ||
      body.effects == null
    ) {
      return NextResponse.json(
        {
          error:
            "Body must include { projectId, projectTitle, resolution: '1080p'|'4K', fps: 30|60, format, moments[], effects }",
        },
        { status: 400 }
      );
    }

    const result = await createCloudExportJob(db, {
      uid,
      projectId,
      projectTitle,
      resolution,
      fps,
      format,
      sourceWidth: body.sourceWidth,
      sourceHeight: body.sourceHeight,
      sourceDuration: body.sourceDuration,
      moments: body.moments,
      effects: body.effects,
      sourceCrop: body.sourceCrop,
      visualAnalysis: body.visualAnalysis,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          kind: result.kind,
          ...(result.remaining != null ? { remaining: result.remaining } : {}),
          ...(result.requested != null ? { requested: result.requested } : {}),
        },
        { status: result.status }
      );
    }

    return NextResponse.json({
      ok: true,
      jobId: result.jobId,
      deduped: result.deduped,
      queuedForSlot: result.queuedForSlot ?? false,
      estimatedExportMinutes: result.estimatedExportMinutes,
      outputDurationSeconds: result.outputDurationSeconds,
      plan: result.plan,
      priority: result.priority,
      limit: result.limit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Cloud export failed.";
    console.error("[export-cloud] failed", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
