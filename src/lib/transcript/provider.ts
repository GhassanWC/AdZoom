/**
 * Transcript provider abstraction. The app is NEVER hard-coded to one ASR
 * engine: a provider implements `transcribeVideo` and is resolved from env by
 * `getTranscriptProvider`. When none is configured (today), the resolver returns
 * `null` and the caller reports `status: "unavailable"` — we NEVER fabricate
 * transcript data. Add a real engine by implementing `TranscriptProvider` and
 * returning it behind its env flag + API key here.
 */
import type { Transcript } from "@/lib/firebase/schema";

export interface TranscribeInput {
  /** Public / signed URL of the media to transcribe. */
  videoUrl: string;
  mimeType?: string;
  durationSeconds?: number;
  /**
   * Primary BCP-47 to transcribe in — the resolved spoken language. When set it
   * is sent VERBATIM as `RecognitionConfig.languageCode` (never overridden by
   * `TRANSCRIPT_LANGUAGE`). Absent → the provider falls back to env then en-US.
   */
  languageCode?: string;
  /** Auto-Detect candidates (v1 `alternativeLanguageCodes`). Empty in selected mode. */
  alternativeLanguageCodes?: string[];
  /**
   * Per-request ASR duration ceiling (seconds) — the caller's PLAN limit
   * (caption quota). Overrides the env default so paid tiers with a higher
   * per-video cap (e.g. Creator's 30 minutes) aren't blocked by the global
   * `TRANSCRIPT_MAX_DURATION_SECONDS` fallback.
   */
  maxDurationSeconds?: number;
  signal?: AbortSignal;
}

export interface TranscriptProvider {
  readonly name: string;
  readonly model?: string;
  transcribeVideo(input: TranscribeInput): Promise<Transcript>;
}

/**
 * Resolve the configured provider from env, or `null` when none is configured —
 * the honest "unavailable" state (never fake). Async + lazy: the heavy
 * server-only provider module is dynamically imported ONLY when selected, so
 * this file stays free of Node/GCP deps (and unit-test loadable).
 */
export async function getTranscriptProvider(): Promise<TranscriptProvider | null> {
  const kind = process.env.TRANSCRIPT_PROVIDER?.trim().toLowerCase();
  if (!kind || kind === "none" || kind === "off") return null;

  if (kind === "google_speech" || kind === "google-speech" || kind === "google") {
    // A project id (explicit or the Firebase one) is required config; absent →
    // treat as not-configured (unavailable), never fake.
    const projectId =
      process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (!projectId) {
      console.warn("[transcript:analysis] google_speech selected but no project id — unavailable");
      return null;
    }
    const { createGoogleSpeechProvider } = await import("./google-speech-provider");
    return createGoogleSpeechProvider();
  }

  // Future engines plug in here behind their own env flag + key:
  //   if (kind === "deepgram" && process.env.DEEPGRAM_API_KEY) { ... }
  return null;
}
