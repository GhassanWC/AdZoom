import { NextResponse, type NextRequest } from "next/server";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import {
  analyzeInline,
  analyzeWithGeminiFile,
  uploadVideoToGemini,
  waitForGeminiFileActive,
  GeminiCancelled,
} from "@/lib/gemini";
import {
  classifyError,
  estimateAnalysisSeconds,
} from "@/lib/analysis-stages";
import { balanceTimeline, distributionScore } from "@/lib/timeline-balancer";
import type {
  AnalysisActivityEvent,
  AnalysisErrorKind,
  DetectedMoment,
  Pacing,
  ProjectStatus,
  VisualAnalysis,
} from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const INLINE_BYTE_LIMIT = 18 * 1024 * 1024;

interface RouteContext {
  params: Promise<{ id: string }>;
}

class CancelledError extends Error {
  constructor() {
    super("Cancelled by user");
    this.name = "CancelledError";
  }
}

async function emitActivity(
  ref: DocumentReference,
  kind: AnalysisActivityEvent["kind"],
  text: string
) {
  await ref.set(
    {
      analysis: {
        activity: FieldValue.arrayUnion({ ts: Date.now(), kind, text }),
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function setStage(
  ref: DocumentReference,
  status: ProjectStatus,
  stageLabel: string
) {
  await ref.set(
    {
      status,
      analysis: {
        status: "analyzing",
        stage: stageLabel,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function isCancelled(ref: DocumentReference): Promise<boolean> {
  const snap = await ref.get();
  const data = snap.data() as Record<string, unknown> | undefined;
  const analysis = data?.analysis as { cancelRequested?: boolean } | undefined;
  return Boolean(analysis?.cancelRequested);
}

async function bail(
  ref: DocumentReference,
  kind: AnalysisErrorKind,
  message: string
) {
  await ref.set(
    {
      status: "failed" as ProjectStatus,
      analysis: {
        status: "failed",
        errorKind: kind,
        errorMessage: message,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function markCancelled(ref: DocumentReference) {
  await ref.set(
    {
      status: "cancelled" as ProjectStatus,
      analysis: {
        status: "cancelled",
        stage: "Cancelled",
        cancelRequested: false,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function ensureNotCancelled(ref: DocumentReference) {
  if (await isCancelled(ref)) throw new CancelledError();
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id: projectId } = await params;
  let ref: DocumentReference | null = null;

  try {
    // 1. Auth
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
    }

    const { auth, db, storage } = getAdmin();
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch (err) {
      console.error("[analyze] token verify failed", err);
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }
    const uid = decoded.uid;

    // 2. Load project
    ref = db.doc(`users/${uid}/projects/${projectId}`);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const project = snap.data() as Record<string, unknown>;
    const storagePath = project.storagePath as string | undefined;
    const mimeType = (project.mimeType as string | undefined) || "video/mp4";
    const duration = project.duration as number | undefined;
    const fileSize = project.fileSize as number | undefined;

    if (!storagePath) {
      return NextResponse.json({ error: "Project has no video uploaded" }, { status: 400 });
    }
    if (!process.env.GEMINI_API_KEY) {
      await bail(ref, "unknown", "GEMINI_API_KEY is not configured on the server.");
      return NextResponse.json(
        { error: "Gemini is not configured on this server." },
        { status: 503 }
      );
    }

    // 3. Initialize analysis state (reset activity, clear errors, set estimate)
    const estimateSeconds = estimateAnalysisSeconds(fileSize, duration);
    await ref.set(
      {
        status: "preparing" as ProjectStatus,
        analysis: {
          status: "analyzing",
          stage: "Preparing analysis",
          detectedMoments: [],
          suggestedCaptions: [],
          boringSections: [],
          recommendedPresetIds: [],
          activity: [],
          startedAt: Date.now(),
          estimateSeconds,
          cancelRequested: false,
          errorKind: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await emitActivity(ref, "info", "Analysis started");

    // 4. Download from Storage
    await ensureNotCancelled(ref);
    const bucket = storage.bucket();
    const file = bucket.file(storagePath);
    const [exists] = await file.exists();
    if (!exists) {
      await bail(ref, "upload_failed", `Storage object missing: ${storagePath}`);
      return NextResponse.json({ error: "Source video missing" }, { status: 410 });
    }
    const [buffer] = await file.download();
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    await emitActivity(ref, "ok", `Downloaded video (${sizeMB} MB)`);

    await ensureNotCancelled(ref);

    // 5. Inline vs Files API
    const useInline = buffer.length <= INLINE_BYTE_LIMIT;
    let analysisJson;

    if (useInline) {
      await setStage(ref, "analyzing", "Analyzing UI interactions");
      await emitActivity(ref, "info", `Sending video to Gemini (inline, ${sizeMB} MB)`);
      analysisJson = await analyzeInline({
        videoBuffer: buffer,
        mimeType,
        hintedDuration: duration,
      });
    } else {
      await setStage(ref, "uploading_to_gemini", "Uploading to Gemini");
      await emitActivity(ref, "info", "Uploading video to Gemini Files API");
      const uploaded = await uploadVideoToGemini(buffer, mimeType);
      await emitActivity(ref, "ok", `Uploaded — file id ${uploaded.name.split("/").pop()}`);

      await ensureNotCancelled(ref);

      await setStage(ref, "extracting_frames", "Extracting frames");
      await waitForGeminiFileActive(uploaded.name, {
        timeoutMs: 180_000,
        shouldCancel: () => isCancelled(ref!),
        onProgress: async (state, attempt) => {
          if (attempt > 0 && attempt % 3 === 0) {
            await emitActivity(ref!, "info", `Gemini state: ${state}`);
          }
        },
      });
      await emitActivity(ref, "ok", "Gemini finished extracting frames");

      await ensureNotCancelled(ref);

      await setStage(ref, "analyzing", "Analyzing UI interactions");
      await emitActivity(ref, "info", "Asking Gemini for the cinematic plan");
      analysisJson = await analyzeWithGeminiFile(uploaded, duration);
    }

    await ensureNotCancelled(ref);

    // 6. Build timeline — balancer redistributes Gemini's output across the
    // full duration, respects min-spacing, and rescues empty quartiles.
    await setStage(ref, "generating_timeline", "Building zoom timeline");
    await emitActivity(
      ref,
      "ok",
      `Detected ${analysisJson.detectedMoments.length} moments, ${analysisJson.suggestedCaptions.length} captions`
    );

    const rawMoments = analysisJson.detectedMoments as DetectedMoment[];
    // Default pacing from the project's preset (Gemini-recommended or user's prior choice)
    const existingPacing = (project.effectsSettings as { pacing?: Pacing } | undefined)?.pacing;
    const pacing: Pacing = existingPacing ?? "moderate";

    // The client-side CV pass wrote this top-level before calling the route.
    // Absent when the video wasn't readable on-device — analysis still proceeds.
    const visualAnalysis = project.visualAnalysis as VisualAnalysis | undefined;

    const balanced = balanceTimeline({
      raw: rawMoments,
      duration: duration ?? 0,
      pacing,
      videoType: analysisJson.videoType,
      visualAnalysis,
    });

    if (balanced.stats.fusedCount > 0) {
      const bits = [
        `Fused ${balanced.stats.fusedCount} moment${
          balanced.stats.fusedCount === 1 ? "" : "s"
        } with on-device CV signals`,
      ];
      if (balanced.stats.clickRefinedCount > 0) {
        bits.push(`refined ${balanced.stats.clickRefinedCount} click timing${
          balanced.stats.clickRefinedCount === 1 ? "" : "s"
        }`);
      }
      await emitActivity(ref, "ok", bits.join(" · "));
    } else if (!visualAnalysis) {
      await emitActivity(ref, "info", "No on-device CV data — using Gemini scores only");
    }

    if (analysisJson.videoType) {
      await emitActivity(
        ref,
        "info",
        `Classified as ${analysisJson.videoType.replace(/-/g, " ")}`
      );
    }
    if (balanced.stats.rewrittenEffects > 0) {
      await emitActivity(
        ref,
        "info",
        `Rewrote ${balanced.stats.rewrittenEffects} effect${
          balanced.stats.rewrittenEffects === 1 ? "" : "s"
        } by UI context (e.g. scroll → speed-up)`
      );
    }
    if (balanced.stats.rhythmPenalized > 0) {
      await emitActivity(
        ref,
        "info",
        `Rhythm memory adjusted ${balanced.stats.rhythmPenalized} pick${
          balanced.stats.rhythmPenalized === 1 ? "" : "s"
        }`
      );
    }
    if (balanced.stats.droppedTooClose > 0) {
      await emitActivity(
        ref,
        "info",
        `Balancer pruned ${balanced.stats.droppedTooClose} clustered moment${
          balanced.stats.droppedTooClose === 1 ? "" : "s"
        }`
      );
    }
    const emptyQuartiles = balanced.stats.quartileCoverage.filter((c) => !c).length;
    if (emptyQuartiles > 0) {
      await emitActivity(
        ref,
        "warn",
        `${emptyQuartiles} of 4 quartiles had no detectable activity`
      );
    } else {
      await emitActivity(ref, "ok", "All 4 quartiles covered");
    }
    const distScore = distributionScore(balanced.moments, duration ?? 0);
    await emitActivity(
      ref,
      "info",
      `Distribution score ${(distScore * 100).toFixed(0)}/100 · avg attention ${(balanced.stats.avgAttention * 100).toFixed(0)}/100`
    );

    await new Promise((r) => setTimeout(r, 350));

    // 7. Preset recommendations
    await setStage(ref, "generating_presets", "Generating presets");
    if (analysisJson.recommendedPresetIds.length > 0) {
      await emitActivity(
        ref,
        "ok",
        `Recommended ${analysisJson.recommendedPresetIds.length} preset${
          analysisJson.recommendedPresetIds.length === 1 ? "" : "s"
        }`
      );
    } else {
      await emitActivity(ref, "warn", "No preset matched strongly — defaults will be used");
    }
    await new Promise((r) => setTimeout(r, 250));

    await ensureNotCancelled(ref);

    // 8. Finalize — write BOTH the balanced view and the raw Gemini output.
    //    rawMoments lets us re-balance on preset change without re-calling Gemini.
    await ref.set(
      {
        status: "analyzed" as ProjectStatus,
        analysis: {
          status: "complete",
          stage: "Complete",
          summary: analysisJson.summary,
          detectedMoments: balanced.moments,
          rawMoments,
          suggestedCaptions: analysisJson.suggestedCaptions,
          boringSections: analysisJson.boringSections,
          recommendedPresetIds: analysisJson.recommendedPresetIds,
          videoType: analysisJson.videoType,
          narrativeStructure: analysisJson.narrativeStructure,
          completedAt: Date.now(),
          cancelRequested: false,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await emitActivity(
      ref,
      "ok",
      `Analysis complete — ${balanced.moments.length} balanced moment${
        balanced.moments.length === 1 ? "" : "s"
      }`
    );

    return NextResponse.json({
      ok: true,
      momentCount: balanced.moments.length,
      summary: analysisJson.summary,
      recommendedPresetIds: analysisJson.recommendedPresetIds,
    });
  } catch (err) {
    if (err instanceof CancelledError || err instanceof GeminiCancelled) {
      console.log("[analyze] cancelled by user");
      if (ref) await markCancelled(ref);
      return NextResponse.json({ ok: false, cancelled: true }, { status: 200 });
    }

    const msg = err instanceof Error ? err.message : "Analysis failed.";
    const kind = classifyError(msg);
    console.error("[analyze] failed", { kind, msg, err });

    if (ref) {
      await bail(ref, kind, msg);
      await emitActivity(ref, "error", `Failed: ${msg.slice(0, 200)}`);
    }
    return NextResponse.json({ error: msg, kind }, { status: 500 });
  }
}
