/**
 * AI-caption status — the SINGLE source of truth for the "Generate AI
 * Captions" action's state, derived from the project's real timeline +
 * transcript (never from the main analysis status). Pure + dependency-light
 * so it drives the toolbar button, the Captions lane state, and the summary
 * card, and is unit-testable under node:test.
 *
 * Captions are treated as ALREADY GENERATED when one or more AI-generated
 * caption moments exist for the CURRENT source video. Manual captions
 * (`source === "user"`) never count — they must not block AI generation.
 * When the source video changes, the stored transcript fingerprint no longer
 * matches, so existing AI captions are STALE and generation is offered again.
 */
import type { DetectedMoment, Transcript } from "@/lib/firebase/schema";
import { sourceFingerprint } from "@/lib/transcript/transcription-job";

/** Structured outcome of a "Generate AI Captions" / retranscribe request. */
export interface CaptionActionResult {
  status: "processing" | "reused" | "complete" | "exists" | "unavailable" | "blocked" | "error";
  message: string;
  captionCount?: number;
}

export type CaptionButtonState =
  | "generate" // no valid AI captions → enabled ("Generate AI Captions")
  | "generated" // valid AI captions exist → disabled ("AI Captions Generated")
  | "processing" // ASR / caption job active → disabled ("Generating AI Captions…")
  | "unavailable"; // no transcription provider configured

export interface AiCaptionStatus {
  /** AI-generated caption moments (source !== "user"). */
  aiCaptionCount: number;
  /** True when ≥1 AI caption moment exists (fresh OR stale). */
  hasAiCaptions: boolean;
  /** Spoken language of the caption transcript, if known. */
  language: string | null;
  /** Transcription/caption generation is running right now. */
  processing: boolean;
  /**
   * AI captions exist but the source video changed since they were made
   * (stored transcript fingerprint no longer matches the current source) —
   * they're stale, so generation is offered again.
   */
  stale: boolean;
  /** Quota/limit blocked the last attempt (surfaced elsewhere; button re-enables). */
  blockedByQuota: boolean;
  state: CaptionButtonState;
  /** Button label for the current state. */
  label: string;
  /** Whether the primary "Generate AI Captions" action should be clickable. */
  canGenerate: boolean;
}

/** Source-only fingerprint of a project's current video (client-computable). */
export function projectSourceFingerprint(project: {
  storagePath?: string | null;
  originalVideoUrl?: string | null;
  fileSize?: number | null;
  duration?: number | null;
}): string {
  return sourceFingerprint({
    storagePath: project.storagePath,
    originalVideoUrl: project.originalVideoUrl,
    fileSize: project.fileSize,
    duration: project.duration,
  });
}

/**
 * Whether a stored transcript's identity fingerprint was made from the CURRENT
 * source video. The transcript stores the FULL identity fingerprint
 * (`source|mode|lang|model|provider`); its source portion is the prefix, so a
 * changed video (new size/duration/path) breaks the prefix match. A legacy
 * transcript with no stored fingerprint is assumed current (never force a
 * needless re-transcription — matches decideTranscription).
 */
export function transcriptMatchesSource(
  transcript: Transcript | null | undefined,
  currentSourceFingerprint: string
): boolean {
  const fp = transcript?.sourceFingerprint;
  if (!fp) return true;
  return fp === currentSourceFingerprint || fp.startsWith(`${currentSourceFingerprint}|`);
}

export function resolveAiCaptionStatus(input: {
  moments: readonly DetectedMoment[] | null | undefined;
  transcript: Transcript | null | undefined;
  currentSourceFingerprint: string;
  /** False when no ASR provider is configured (env). Defaults to true. */
  providerConfigured?: boolean;
}): AiCaptionStatus {
  const { moments, transcript, currentSourceFingerprint, providerConfigured = true } = input;
  const aiCaptions = (moments ?? []).filter(
    (m) => m.effectType === "captions" && m.source !== "user"
  );
  const aiCaptionCount = aiCaptions.length;
  const hasAiCaptions = aiCaptionCount > 0;
  const sourceMatches = transcriptMatchesSource(transcript, currentSourceFingerprint);
  // Stale = AI captions from a DIFFERENT source video than the current one.
  const stale = hasAiCaptions && !sourceMatches;
  const processing = transcript?.status === "processing";
  const blockedByQuota =
    transcript?.status === "unavailable" &&
    (transcript.skipReason === "quota_exhausted" || transcript.skipReason === "per_video_limit");

  let state: CaptionButtonState;
  if (processing) {
    state = "processing";
  } else if (hasAiCaptions && !stale) {
    state = "generated";
  } else if (!providerConfigured) {
    state = "unavailable";
  } else {
    state = "generate";
  }

  const label =
    state === "processing"
      ? "Generating AI Captions…"
      : state === "generated"
        ? "Regenerate AI Captions"
        : state === "unavailable"
          ? "Captions unavailable"
          : "Generate AI Captions";

  return {
    aiCaptionCount,
    hasAiCaptions,
    language: transcript?.language ?? transcript?.requestedLanguageCode ?? null,
    processing,
    stale,
    blockedByQuota,
    state,
    label,
    // Generation is offered whenever a job isn't already running and a provider
    // exists — INCLUDING when AI captions already exist (a regeneration, which
    // is a fresh charged ASR run). Only `processing`/`unavailable` block it.
    canGenerate: state !== "processing" && state !== "unavailable",
  };
}
