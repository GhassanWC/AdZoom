/**
 * Captions-only request handler (server) — the SINGLE entry point for the
 * dedicated "Generate AI Captions" action. It is completely independent of the
 * full AI analysis (Gemini / zoom / cut / speed / overlays): analysis never
 * starts ASR or reserves caption quota anymore; ALL caption generation flows
 * through here.
 *
 * It does the "front half" of transcription — resolve language, fingerprint,
 * decide reuse/skip/transcribe, enforce the per-video + monthly caption quota,
 * atomically RESERVE, then hand off to the shared `processTranscriptionJob`
 * (inline in dev, or the background worker) which transcribes, generates the
 * caption moments, and commits/releases the reservation. When a valid complete
 * transcript already exists it generates captions from it for FREE (no ASR, no
 * charge).
 *
 * Server-side duplicate protection (never trusts the disabled UI): a repeated
 * request cannot reserve quota twice, call Google twice, or duplicate caption
 * moments — valid existing AI captions short-circuit to `exists`, an in-flight
 * job short-circuits to `processing`, and the reservation/idempotency key +
 * worker verification guard the rest.
 */
import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import { stripUndefined } from "@/lib/firebase/sanitize";
import { getUserPlan } from "@/lib/usage/gating";
import { resolveTranscriptLanguage, type TranscriptLanguageMode } from "./language";
import {
  transcriptionFingerprint,
  decideTranscription,
  isAsrRunnable,
  hasBackgroundAsrTarget,
  resolveAsrDispatch,
  asrExecutionMode,
} from "./transcription-job";
import { processTranscriptionJob, dispatchTranscription } from "./run-transcription";
import { generateCaptionMoments } from "@/lib/analysis/caption-generator";
import {
  CAPTION_PLAN_LIMITS,
  CAPTION_ALLOWANCE_EXHAUSTED_MESSAGE,
  CaptionQuotaExhaustedError,
  exceedsCaptionVideoLimit,
  perVideoCaptionLimitMessage,
  requiredCaptionSeconds,
} from "@/lib/usage/caption-quota";
import { reserveCaptionSeconds, releaseCaptionReservation, logCaptionQuota } from "@/lib/usage/caption-ledger";
import type {
  CaptionPosition,
  DetectedMoment,
  OverlayTextPreset,
  SelectedVideoType,
  Transcript,
  TranscriptSkipReason,
} from "@/lib/firebase/schema";

export interface CaptionRequestInput {
  uid: string;
  projectId: string;
  mode: TranscriptLanguageMode;
  code?: string;
  locale?: string;
  /** Retranscribe / change-language: replace AI captions + bypass reuse. */
  force?: boolean;
  stylePreset?: OverlayTextPreset;
  position?: CaptionPosition;
}

export type CaptionRequestResult =
  | { status: "processing"; message: string }
  | { status: "reused"; captionCount: number; message: string }
  | { status: "complete"; captionCount: number; message: string }
  | { status: "exists"; captionCount: number; message: string }
  | { status: "unavailable"; message: string }
  | { status: "blocked"; skipReason: TranscriptSkipReason; message: string };

/** HTTP status for each result kind (the route maps these). */
export function captionResultHttpStatus(r: CaptionRequestResult): number {
  switch (r.status) {
    case "processing":
    case "reused":
    case "complete":
      return 200;
    case "exists":
      return 409; // already generated — do not duplicate
    case "unavailable":
      return 200; // honest no-op (no provider)
    case "blocked":
      return 402; // quota / per-video limit
  }
}

function aiCaptionMoments(moments: DetectedMoment[] | undefined): DetectedMoment[] {
  return (moments ?? []).filter((m) => m.effectType === "captions" && m.source !== "user");
}

interface CaptionProjectShape {
  storagePath?: string;
  originalVideoUrl?: string;
  mimeType?: string;
  fileSize?: number;
  duration?: number;
  selectedVideoType?: SelectedVideoType;
  analysis?: {
    transcript?: Transcript;
    detectedMoments?: DetectedMoment[];
    editRecipe?: { effectiveVideoType?: SelectedVideoType };
  };
}

export async function requestCaptions(input: CaptionRequestInput): Promise<CaptionRequestResult> {
  const { uid, projectId, mode, code, locale, force, stylePreset, position } = input;
  const { db } = getAdmin();
  const ref = db.collection("users").doc(uid).collection("projects").doc(projectId);
  const snap = await ref.get();
  if (!snap.exists) return { status: "unavailable", message: "Project not found." };
  const project = snap.data() as CaptionProjectShape;

  if (!isAsrRunnable()) {
    logCaptionQuota("blocked", { uid, projectId, reason: "no_provider" });
    return { status: "unavailable", message: "Captions are unavailable — no transcription provider is configured." };
  }

  const duration = typeof project.duration === "number" ? project.duration : undefined;
  const plan = await getUserPlan(uid);
  const asrModel = process.env.TRANSCRIPT_MODEL || "latest_long";
  const asrProvider = process.env.TRANSCRIPT_PROVIDER?.trim().toLowerCase() || "";
  const existing = project.analysis?.transcript;
  const langConfig = resolveTranscriptLanguage({
    mode,
    selectedCode: code,
    priorLanguage: existing?.status === "complete" ? existing.language : null,
    locale,
    envFallback: process.env.TRANSCRIPT_LANGUAGE,
  });
  const fingerprint = transcriptionFingerprint({
    source: {
      storagePath: project.storagePath,
      originalVideoUrl: project.originalVideoUrl,
      fileSize: project.fileSize,
      duration,
    },
    languageMode: langConfig.mode,
    languageCode: langConfig.languageCode,
    model: asrModel,
    provider: asrProvider,
  });

  const existingAiCaptions = aiCaptionMoments(project.analysis?.detectedMoments);
  const videoType: SelectedVideoType =
    project.analysis?.editRecipe?.effectiveVideoType ?? project.selectedVideoType ?? "auto";

  const decision = decideTranscription({
    existing,
    fingerprint,
    runnable: true,
    forceRetranscribe: force === true,
    now: Date.now(),
  });

  logCaptionQuota("check", {
    uid,
    projectId,
    plan,
    reason: `captions_request:${decision.action}`,
    requestedSeconds: duration ? requiredCaptionSeconds(duration) : 0,
  });

  // ── Duplicate protection #1: valid AI captions already exist for THIS
  //    source + language → never re-run (unless the user explicitly forces). ──
  if (!force && existingAiCaptions.length > 0 && decision.action === "reuse") {
    return {
      status: "exists",
      captionCount: existingAiCaptions.length,
      message: "AI captions already exist for this video.",
    };
  }
  // ── Duplicate protection #2: a transcription job is already in flight. ──
  if (!force && decision.action === "skip") {
    return { status: "processing", message: "Captions are already being generated." };
  }

  const langStamp = {
    languageMode: langConfig.mode,
    requestedLanguageCode: langConfig.languageCode,
    ...(langConfig.alternativeLanguageCodes.length
      ? { requestedAlternativeLanguageCodes: langConfig.alternativeLanguageCodes }
      : {}),
  };
  const styleStamp = {
    ...(stylePreset ? { captionStylePreset: stylePreset } : {}),
    ...(position ? { captionPosition: position } : {}),
  };

  // ── FREE reuse: a complete transcript for the current source exists but no
  //    AI captions yet → generate them directly, no ASR, no quota. ──
  if (decision.action === "reuse" && existing && existingAiCaptions.length === 0) {
    const gen = generateCaptionMoments(existing, videoType, { stylePreset, position });
    if (gen.moments.length > 0) {
      const merged = [...(project.analysis?.detectedMoments ?? []), ...gen.moments].sort(
        (a, b) => a.startTime - b.startTime
      );
      await ref.set(
        { analysis: { detectedMoments: stripUndefined(merged) }, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    logCaptionQuota("committed", { uid, projectId, plan, reason: "reused_existing_transcript", requestedSeconds: 0 });
    return {
      status: "reused",
      captionCount: gen.moments.length,
      message: `Added ${gen.moments.length} captions from the existing transcript.`,
    };
  }

  if (decision.action === "unavailable") {
    return { status: "unavailable", message: "Captions are unavailable for this video." };
  }

  // ── decision.action === "transcribe": a NEW ASR run (the ONLY path that
  //    charges quota). Per-video limit → reserve → mark processing → dispatch. ──
  if (exceedsCaptionVideoLimit(plan, duration)) {
    logCaptionQuota("blocked", { uid, projectId, plan, reason: "per_video_limit" });
    return { status: "blocked", skipReason: "per_video_limit", message: perVideoCaptionLimitMessage(plan) };
  }
  if (duration === undefined || !(duration > 0)) {
    return {
      status: "blocked",
      skipReason: "unknown_duration",
      message: "The video duration is unknown, so captions can't be metered yet. Try again in a moment.",
    };
  }
  const requiredSeconds = requiredCaptionSeconds(duration);
  const usageKey = `cap_${projectId}_${Date.now().toString(36)}`;
  let usagePeriodId: string;
  try {
    const reserved = await reserveCaptionSeconds(db, { uid, projectId, key: usageKey, seconds: requiredSeconds });
    usagePeriodId = reserved.periodId;
  } catch (err) {
    if (err instanceof CaptionQuotaExhaustedError) {
      return { status: "blocked", skipReason: "quota_exhausted", message: CAPTION_ALLOWANCE_EXHAUSTED_MESSAGE };
    }
    console.warn("[caption-request] reserve failed", err);
    return {
      status: "blocked",
      skipReason: "quota_check_failed",
      message: "The caption usage check failed. Please try again.",
    };
  }

  // Force (retranscribe / change language): drop existing AI captions BEFORE
  // dispatch so the worker regenerates (its dedup guard skips when AI captions
  // exist). Manual captions are preserved.
  const baseMoments =
    force && existingAiCaptions.length > 0
      ? (project.analysis?.detectedMoments ?? []).filter(
          (m) => !(m.effectType === "captions" && m.source !== "user")
        )
      : project.analysis?.detectedMoments;

  const processingTranscript: Transcript = {
    status: "processing",
    ...langStamp,
    ...styleStamp,
    usageKey,
    usagePeriodId,
    usageSeconds: requiredSeconds,
    sourceFingerprint: fingerprint,
    requestedAt: Date.now(),
  };
  await ref.set(
    {
      analysis: {
        transcript: stripUndefined(processingTranscript),
        ...(baseMoments ? { detectedMoments: stripUndefined(baseMoments) } : {}),
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const dispatch = resolveAsrDispatch({ execMode: asrExecutionMode(), durationSeconds: duration });
  const captionMaxSeconds = CAPTION_PLAN_LIMITS[plan].maxCaptionVideoSeconds;
  void captionMaxSeconds; // per-plan cap already enforced above; worker re-checks the live plan.

  if (dispatch === "inline") {
    // Dev / short-video inline mode: run the shared job in-process (transcribe
    // + generate captions + commit/release), then report the outcome.
    const result = await processTranscriptionJob(uid, projectId, { forceRetranscribe: force === true });
    if (result.status === "complete") {
      return { status: "complete", captionCount: result.captions, message: `Generated ${result.captions} captions.` };
    }
    return { status: "processing", message: "Captions are being generated." };
  }

  if (dispatch === "background" && hasBackgroundAsrTarget()) {
    await dispatchTranscription(uid, projectId, { forceRetranscribe: force === true });
    return { status: "processing", message: "Generating captions in the background…" };
  }

  // No dispatch target — return the reservation so quota isn't stranded.
  await releaseCaptionReservation(db, { uid, projectId, key: usageKey, periodId: usagePeriodId }).catch(() => {});
  await ref
    .set({ analysis: { transcript: { status: "unavailable" } }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    .catch(() => {});
  return { status: "unavailable", message: "Captions are unavailable — no transcription runtime is configured." };
}
