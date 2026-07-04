/**
 * Transcription job lifecycle + dedup — the pure, testable brain that decides
 * whether an analysis run should REUSE an existing transcript, SKIP because one
 * is already in flight, TRANSCRIBE (enqueue), or report UNAVAILABLE. Keeps ASR
 * off the export path (it only ever runs from analysis) and prevents duplicate
 * jobs. DOM/SDK-free (type-only imports).
 */
import type { Transcript } from "@/lib/firebase/schema";
import type { TranscriptLanguageMode } from "./language";

/** A `processing` job older than this is treated as dead → retryable. */
export const PROCESSING_STALE_MS = 10 * 60 * 1000;

export type TranscriptionAction = "reuse" | "skip" | "transcribe" | "unavailable";

export interface TranscriptionDecision {
  action: TranscriptionAction;
  reason: string;
}

/** Where the heavy ASR (ffmpeg + Speech) actually runs. */
export type AsrExecutionMode = "worker" | "inline" | "disabled";

/**
 * Resolve the execution mode from env. `worker` dispatches to an ffmpeg-equipped
 * runtime; `inline` runs in-process (only where ffmpeg exists — dev); anything
 * else → `disabled` (ASR does not run; transcript stays unavailable — never fake).
 */
export function asrExecutionMode(): AsrExecutionMode {
  const m = process.env.TRANSCRIPT_EXECUTION?.trim().toLowerCase();
  if (m === "worker" || m === "inline") return m;
  return "disabled";
}

/**
 * Longest video that may run ASR INLINE (synchronously inside the analyze
 * request). Anything longer runs in the BACKGROUND so "Generate AI Edit" is
 * never blocked / timed-out by transcription — even in `inline` mode, which is
 * meant only for short local/dev tests. (Product decision: async ASR is the
 * default for real videos; the AI edit lands first, captions arrive later.)
 */
export const INLINE_ASR_MAX_SECONDS = 60;

/** How a NEEDED transcription should run this analysis. */
export type AsrDispatch = "inline" | "background" | "none";

/**
 * Decide HOW to run a transcription the run already decided it NEEDS:
 *   • `disabled`             → "none" (ASR off).
 *   • `worker`               → "background" (always — dispatch to the ffmpeg
 *                              runtime; the Next.js request never runs ffmpeg).
 *   • `inline` + short video → "inline" (fast, fine for local/dev tests).
 *   • `inline` + long video  → "background" (run ASR out-of-band via the internal
 *                              endpoint so analysis isn't blocked on it).
 * An unknown duration is treated as long → background (safe: never blocks).
 */
export function resolveAsrDispatch(input: {
  execMode: AsrExecutionMode;
  durationSeconds?: number | null;
}): AsrDispatch {
  if (input.execMode === "disabled") return "none";
  if (input.execMode === "worker") return "background";
  const dur = input.durationSeconds ?? Infinity;
  return dur <= INLINE_ASR_MAX_SECONDS ? "inline" : "background";
}

/**
 * Is there anywhere to dispatch a BACKGROUND transcription to? A dedicated
 * ffmpeg worker (`TRANSCRIPT_WORKER_URL`) OR — for local/dev inline mode — this
 * app's own origin (`NEXT_PUBLIC_APP_URL`), where /api/internal/transcribe runs
 * ffmpeg in-process. Used to fail honest (→ unavailable) instead of stranding a
 * transcript in `processing` with nothing to complete it.
 */
export function hasBackgroundAsrTarget(): boolean {
  return !!(
    process.env.TRANSCRIPT_WORKER_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim()
  );
}

/** True when a provider is configured (google_speech + a project id). */
export function isAsrProviderConfigured(): boolean {
  const kind = process.env.TRANSCRIPT_PROVIDER?.trim().toLowerCase();
  const projectId =
    process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  return (
    (kind === "google_speech" || kind === "google-speech" || kind === "google") && !!projectId
  );
}

/**
 * True when ASR can actually run: a provider is configured AND there's a real
 * runtime for it — `inline` (ffmpeg in-process) or `worker` WITH a dispatch URL.
 * Worker mode without `TRANSCRIPT_WORKER_URL` is NOT runnable (→ unavailable),
 * so we never strand a transcript in `processing` with nothing to complete it.
 */
export function isAsrRunnable(): boolean {
  if (!isAsrProviderConfigured()) return false;
  const mode = asrExecutionMode();
  if (mode === "inline") return true;
  if (mode === "worker") return !!process.env.TRANSCRIPT_WORKER_URL?.trim();
  return false;
}

/**
 * Stable fingerprint of the source video. Changes when the user re-uploads or the
 * file changes (size/duration), so a stale transcript is naturally re-made.
 */
export function sourceFingerprint(source: {
  storagePath?: string | null;
  originalVideoUrl?: string | null;
  fileSize?: number | null;
  duration?: number | null;
}): string {
  const key = source.storagePath || source.originalVideoUrl || "";
  const size = source.fileSize ?? "";
  const dur = source.duration != null ? Math.round(source.duration) : "";
  return `${key}|${size}|${dur}`;
}

/**
 * Transcript IDENTITY fingerprint — the video fingerprint PLUS the language
 * configuration + ASR model/provider. Changing the language must force a fresh
 * transcript (a transcript made with en-US must never be reused after the user
 * switches to ar-OM), so the language is part of the identity. In `auto` mode the
 * key is just "auto" (the detected language is whatever it is — reuse is correct
 * for the same video); in `selected` mode it's the exact code, so switching codes
 * yields a different fingerprint → retranscription. Same language + unchanged
 * video → identical fingerprint → reuse.
 */
export function transcriptionFingerprint(input: {
  source: Parameters<typeof sourceFingerprint>[0];
  languageMode: TranscriptLanguageMode;
  languageCode?: string | null;
  model?: string | null;
  provider?: string | null;
}): string {
  const langKey =
    input.languageMode === "selected" ? (input.languageCode ?? "").toLowerCase() : "auto";
  return [
    sourceFingerprint(input.source),
    input.languageMode,
    langKey,
    input.model ?? "",
    input.provider ?? "",
  ].join("|");
}

export interface TranscriptionDecisionInput {
  existing: Transcript | null | undefined;
  fingerprint: string;
  /** ASR is configured + has a runtime (provider + execution mode). */
  runnable: boolean;
  /** User explicitly asked to re-transcribe (overrides reuse). */
  forceRetranscribe?: boolean;
  now: number;
}

/**
 * Decide what to do about transcription for THIS analysis run. Encodes the dedup
 * rules: reuse a fresh complete transcript, don't double-queue an in-flight one,
 * (re)transcribe when missing / failed / stale / the video changed / forced.
 */
export function decideTranscription(input: TranscriptionDecisionInput): TranscriptionDecision {
  const { existing, fingerprint, runnable, forceRetranscribe, now } = input;
  if (!runnable) {
    // ASR off / not configured / captions disabled → NEVER wipe a good transcript
    // (it still powers hook text); just don't start a new one.
    if (existing?.status === "complete" && (existing.segments?.length ?? 0) > 0) {
      return { action: "reuse", reason: "captions/ASR off — keeping existing transcript" };
    }
    return { action: "unavailable", reason: "no ASR provider/runtime configured" };
  }
  if (forceRetranscribe) return { action: "transcribe", reason: "re-transcription requested" };

  if (existing?.status === "complete" && (existing.segments?.length ?? 0) > 0) {
    // Reuse when the source is unchanged. Legacy transcripts with no stored
    // fingerprint are assumed unchanged (avoid needless re-transcription).
    if (!existing.sourceFingerprint || existing.sourceFingerprint === fingerprint) {
      return { action: "reuse", reason: "up-to-date transcript exists" };
    }
    return { action: "transcribe", reason: "source video changed" };
  }

  if (existing?.status === "processing") {
    const age = existing.requestedAt ? now - existing.requestedAt : Infinity;
    if (age < PROCESSING_STALE_MS) {
      return { action: "skip", reason: "transcription already in progress" };
    }
    return { action: "transcribe", reason: "prior transcription stalled — retrying" };
  }

  // missing / unavailable / failed / complete-but-empty → transcribe.
  return {
    action: "transcribe",
    reason: existing ? `prior status "${existing.status}" — transcribing` : "no transcript yet",
  };
}
