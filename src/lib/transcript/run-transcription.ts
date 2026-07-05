/**
 * Transcription execution (server-only). Two entry points:
 *
 *   • `processTranscriptionJob` — the WORKER core. Runs the heavy ASR (ffmpeg +
 *     Speech, via the provider), writes `analysis.transcript`, and appends
 *     transcript-derived caption operations to the timeline. This is what an
 *     ffmpeg-equipped runtime executes (e.g. the internal /api/internal/transcribe
 *     route deployed with ffmpeg). It is TRIGGERED BY ANALYSIS, never by export.
 *
 *   • `dispatchTranscription` — from the analysis route in `worker` mode: a fast,
 *     best-effort POST to that runtime so the Next.js request never runs ffmpeg.
 *
 * Everything is contained: a failure sets `transcript.status = "failed"` and
 * NEVER blocks analysis or export. Captions are only ever created here (from a
 * real transcript) or in the analysis route — NEVER during export.
 */
import { FieldValue } from "firebase-admin/firestore";
import type {
  DetectedMoment,
  SelectedVideoType,
  Transcript,
  TranscriptSkipReason,
} from "@/lib/firebase/schema";
import { getAdmin } from "@/lib/firebase/admin";
import { stripUndefined } from "@/lib/firebase/sanitize";
import { transcribeVideo } from "./transcribe";
import { generateCaptionMoments } from "@/lib/analysis/caption-generator";
import { transcriptionFingerprint } from "./transcription-job";
import { normalizePlan } from "@/lib/usage/plan";
import {
  CAPTION_PLAN_LIMITS,
  exceedsCaptionVideoLimit,
  perVideoCaptionLimitMessage,
  shouldCommitCaptionUsage,
} from "@/lib/usage/caption-quota";
import {
  commitCaptionUsage,
  logCaptionQuota,
  releaseCaptionReservation,
  verifyCaptionReservation,
} from "@/lib/usage/caption-ledger";

interface ProjectShape {
  originalVideoUrl?: string;
  storagePath?: string;
  mimeType?: string;
  duration?: number;
  fileSize?: number;
  selectedVideoType?: SelectedVideoType;
  analysis?: {
    transcript?: Transcript;
    detectedMoments?: DetectedMoment[];
    editRecipe?: { effectiveVideoType?: SelectedVideoType; operations?: { category: string }[] };
    lastRunOptions?: { generateCaptions?: boolean };
  };
}

/**
 * Whether a completed transcription should produce caption moments. Captions
 * are now generated EXCLUSIVELY via the dedicated "Generate AI Captions" flow
 * (analysis never dispatches transcription), so any job that reaches this
 * worker IS a caption job by construction. The duplicate guard is the
 * "AI captions already exist" check at the call site, not this function.
 */
function wantsCaptions(_project: ProjectShape): boolean {
  return true;
}

function captionVideoType(project: ProjectShape): SelectedVideoType {
  return (
    project.analysis?.editRecipe?.effectiveVideoType ??
    project.selectedVideoType ??
    "auto"
  );
}

/**
 * Transcribe a project + append captions. Idempotent: a `complete` transcript for
 * the SAME source (and not forced) is a no-op. Writes are merge-based + append
 * captions onto the CURRENT timeline (never clobbers user edits / manual captions).
 */
export async function processTranscriptionJob(
  uid: string,
  projectId: string,
  opts?: { forceRetranscribe?: boolean }
): Promise<{ status: Transcript["status"]; captions: number }> {
  const { db } = getAdmin();
  const ref = db.collection("users").doc(uid).collection("projects").doc(projectId);
  const snap = await ref.get();
  if (!snap.exists) return { status: "failed", captions: 0 };
  const project = snap.data() as ProjectShape;
  const existing = project.analysis?.transcript;
  const requestedAt = existing?.requestedAt ?? Date.now();
  // The spoken language the analysis route resolved + stamped on the `processing`
  // transcript — the worker transcribes in THIS language (never re-derives / never
  // defaults to en-US). It's part of the identity fingerprint too.
  const languageMode = existing?.languageMode ?? "auto";
  const requestedLanguageCode = existing?.requestedLanguageCode ?? existing?.language ?? undefined;
  const requestedAlternativeLanguageCodes = existing?.requestedAlternativeLanguageCodes ?? [];
  const langStamp = {
    languageMode,
    ...(requestedLanguageCode ? { requestedLanguageCode } : {}),
    ...(requestedAlternativeLanguageCodes.length
      ? { requestedAlternativeLanguageCodes }
      : {}),
  };
  const fingerprint = transcriptionFingerprint({
    source: project,
    languageMode,
    languageCode: requestedLanguageCode,
    model: process.env.TRANSCRIPT_MODEL || "latest_long",
    provider: process.env.TRANSCRIPT_PROVIDER?.trim().toLowerCase() || "",
  });

  // Idempotency: already complete for this exact source + language → nothing to do.
  if (
    !opts?.forceRetranscribe &&
    existing?.status === "complete" &&
    existing.sourceFingerprint === fingerprint &&
    (existing.segments?.length ?? 0) > 0
  ) {
    return { status: "complete", captions: 0 };
  }

  // ── Caption-quota enforcement (worker side) ──────────────────────────────
  // The public analyze route reserved caption seconds and stamped the key on
  // the `processing` transcript. NEVER call the provider without verifying
  // that reservation here — a forged/replayed dispatch, a duplicate delivery,
  // an already-finalized job, or a source changed under the reservation all
  // reject BEFORE any Google call.
  const usageKey = existing?.usageKey;
  const usagePeriodId = existing?.usagePeriodId;
  const usageSeconds = existing?.usageSeconds;
  const rejectQuota = async (
    reason: string,
    userMessage: string,
    skipReason: TranscriptSkipReason = "reservation_invalid"
  ) => {
    logCaptionQuota("blocked", { uid, projectId, jobId: usageKey ?? null, reason });
    // Only overwrite a live `processing` marker (never clobber a complete
    // transcript from a racing run).
    if (existing?.status === "processing") {
      await ref
        .set(
          {
            analysis: {
              transcript: stripUndefined({
                status: "unavailable" as const,
                error: userMessage,
                skipReason,
                ...langStamp,
                sourceFingerprint: fingerprint,
                requestedAt,
              }),
            },
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        .catch(() => {});
    }
    return { status: "unavailable" as const, captions: 0 };
  };

  if (existing?.status !== "processing") {
    // Late/duplicate delivery for a job that already reached a terminal state.
    logCaptionQuota("blocked", {
      uid,
      projectId,
      jobId: usageKey ?? null,
      reason: "duplicate_or_stale_delivery",
    });
    return { status: existing?.status ?? "failed", captions: 0 };
  }
  if (existing.sourceFingerprint && existing.sourceFingerprint !== fingerprint) {
    // The source/language changed after this job was reserved — refuse and
    // release; the next analyze reserves fresh for the new identity.
    if (usageKey && usagePeriodId) {
      await releaseCaptionReservation(db, { uid, projectId, key: usageKey, periodId: usagePeriodId }).catch(() => {});
    }
    return rejectQuota(
      "fingerprint_mismatch",
      "The video changed while captions were queued. Re-run the analysis to caption the current video."
    );
  }
  const verdict = await verifyCaptionReservation(db, { uid, projectId, key: usageKey, periodId: usagePeriodId });
  if (!verdict.ok) {
    return rejectQuota(
      verdict.reason,
      "This caption run had no valid usage reservation. Re-run the analysis to caption this video."
    );
  }
  const userSnap = await db.collection("users").doc(uid).get();
  const plan = normalizePlan(userSnap.data()?.plan);
  if (exceedsCaptionVideoLimit(plan, project.duration)) {
    // Plan changed between reserve and execution (e.g. downgrade) — enforce
    // the CURRENT plan's per-video cap and return the reservation.
    if (usageKey && usagePeriodId) {
      await releaseCaptionReservation(db, { uid, projectId, key: usageKey, periodId: usagePeriodId }).catch(() => {});
    }
    return rejectQuota("per_video_limit_exceeded", perVideoCaptionLimitMessage(plan), "per_video_limit");
  }
  const usageStamp = {
    ...(usageKey ? { usageKey } : {}),
    ...(usagePeriodId ? { usagePeriodId } : {}),
    ...(typeof usageSeconds === "number" ? { usageSeconds } : {}),
  };

  try {
    const raw = await transcribeVideo({
      videoUrl: project.originalVideoUrl ?? "",
      mimeType: project.mimeType,
      durationSeconds: project.duration,
      languageCode: requestedLanguageCode,
      alternativeLanguageCodes: requestedAlternativeLanguageCodes,
      maxDurationSeconds: CAPTION_PLAN_LIMITS[plan].maxCaptionVideoSeconds,
    });
    const transcript: Transcript = {
      ...raw,
      ...langStamp,
      ...usageStamp,
      sourceFingerprint: fingerprint,
      requestedAt,
    };

    let captionMoments: DetectedMoment[] = [];
    if (transcript.status === "complete" && wantsCaptions(project)) {
      const current = project.analysis?.detectedMoments ?? [];
      // Only AI captions block regeneration (manual captions survive a re-transcribe).
      const hasCaptions = current.some((m) => m.effectType === "captions" && m.source !== "user");
      if (!hasCaptions) {
        // Honor the style/position the user chose in the Generate AI Captions
        // dialog (stamped on the processing transcript); fall back to the
        // video-type default when absent.
        captionMoments = generateCaptionMoments(transcript, captionVideoType(project), {
          stylePreset: existing?.captionStylePreset,
          position: existing?.captionPosition,
        }).moments;
      }
    }

    const analysisPatch: Record<string, unknown> = { transcript: stripUndefined(transcript) };
    if (captionMoments.length > 0) {
      const merged = [...(project.analysis?.detectedMoments ?? []), ...captionMoments].sort(
        (a, b) => a.startTime - b.startTime
      );
      analysisPatch.detectedMoments = stripUndefined(merged);
    }
    await ref.set({ analysis: analysisPatch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    // Finalize the reservation AFTER the transcript write (a lost commit is
    // self-healed by the sweep, which sees the recorded `complete` state):
    //   • any `complete` transcript — INCLUDING an empty one — COMMITS (the
    //     provider processed/billed the audio);
    //   • `failed`/`unavailable` (provider refused before processing) RELEASES.
    if (usageKey && usagePeriodId) {
      try {
        if (shouldCommitCaptionUsage(transcript.status)) {
          await commitCaptionUsage(db, {
            uid,
            projectId,
            key: usageKey,
            periodId: usagePeriodId,
            fallbackSeconds: usageSeconds,
          });
        } else {
          await releaseCaptionReservation(db, { uid, projectId, key: usageKey, periodId: usagePeriodId });
        }
      } catch (settleErr) {
        console.warn("[caption-quota] worker settle failed (sweep will reconcile)", settleErr);
      }
    }

    console.info("[captions:generation]", {
      projectId,
      source: "worker",
      transcriptStatus: transcript.status,
      language: transcript.language,
      segments: transcript.segments?.length ?? 0,
      words: transcript.words?.length ?? 0,
      captions: captionMoments.length,
    });
    return { status: transcript.status, captions: captionMoments.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "transcription failed";
    console.warn("[asr:google-speech:error]", { projectId, message });
    await ref
      .set(
        {
          analysis: {
            transcript: stripUndefined({
              status: "failed" as const,
              error: message,
              ...langStamp,
              ...usageStamp,
              sourceFingerprint: fingerprint,
              requestedAt,
            }),
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      .catch(() => {});
    // The provider failed before/while processing — return the reservation.
    if (usageKey && usagePeriodId) {
      await releaseCaptionReservation(db, { uid, projectId, key: usageKey, periodId: usagePeriodId }).catch(
        () => {}
      );
    }
    return { status: "failed", captions: 0 };
  }
}

/**
 * Resolve WHERE a background transcription is dispatched:
 *   • `TRANSCRIPT_WORKER_URL`  — a dedicated ffmpeg-equipped runtime (prod).
 *   • else `NEXT_PUBLIC_APP_URL` — this app's own origin (local/dev inline mode),
 *     where /api/internal/transcribe runs ffmpeg in-process (best-effort).
 * For full durability in prod, point `TRANSCRIPT_WORKER_URL` at a CPU-always-on
 * worker (or layer Cloud Tasks on top); the self-POST is a dev convenience.
 */
function resolveDispatchBase(): { base: string; kind: "worker" | "self" } | null {
  const worker = process.env.TRANSCRIPT_WORKER_URL?.trim();
  if (worker) return { base: worker.replace(/\/$/, ""), kind: "worker" };
  const app = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (app) return { base: app.replace(/\/$/, ""), kind: "self" };
  return null;
}

/**
 * Fire-and-forget dispatch to the runtime that runs ASR. The endpoint
 * acknowledges fast (202) + processes in the background, so the analysis request
 * never runs ffmpeg + never blocks on ASR. A missing target or a failed dispatch
 * is non-fatal — the transcript stays `processing` and the next analysis retries
 * (stale detection).
 */
export async function dispatchTranscription(
  uid: string,
  projectId: string,
  opts?: { forceRetranscribe?: boolean }
): Promise<void> {
  const target = resolveDispatchBase();
  if (!target) {
    console.warn("[asr] no dispatch target (set TRANSCRIPT_WORKER_URL or NEXT_PUBLIC_APP_URL) — cannot dispatch");
    return;
  }
  const secret = process.env.TRANSCRIPT_WORKER_SECRET;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    await fetch(`${target.base}/api/internal/transcribe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-internal-secret": secret } : {}),
      },
      body: JSON.stringify({ uid, projectId, forceRetranscribe: opts?.forceRetranscribe ?? false }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    console.info("[asr] dispatched background transcription", { projectId, via: target.kind });
  } catch (err) {
    console.warn("[asr] dispatch failed (will retry on next analysis)", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
