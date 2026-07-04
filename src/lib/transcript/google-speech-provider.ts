/**
 * Google Speech-to-Text provider (server-only). Implements the transcript
 * provider abstraction: extracts a mono 16 kHz FLAC from the source video
 * (ffmpeg, streamed), then calls the Speech-to-Text v1 REST API with a
 * cloud-platform ADC token — short audio inline (`recognize`), longer audio via
 * a temp GCS object (`longrunningrecognize`). Word-level timestamps are always
 * requested. Credentials never reach the browser.
 *
 * Failure is contained: any error (no ffmpeg, auth failure, API error, timeout)
 * throws and the `transcribe` wrapper reports `status: "failed"` — analysis +
 * export continue. Over-limit media returns `unavailable` (a skip, not a fail).
 * NEVER fabricates a transcript.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Transcript } from "@/lib/firebase/schema";
import { getAdmin } from "@/lib/firebase/admin";
import type { TranscribeInput, TranscriptProvider } from "./provider";
import {
  extractAudioToFlac,
  EXTRACT_CHANNELS,
  EXTRACT_SAMPLE_RATE,
  SYNC_AUDIO_LIMIT_SEC,
} from "./audio-extract";
import { getCloudAccessToken } from "./gcp-auth";
import { parseSpeechResults, speechHttpError, type SpeechResult } from "./speech-parse";

const SPEECH_API = "https://speech.googleapis.com/v1";
/** Inline `recognize` accepts ≤ ~10MB; keep a margin. */
const INLINE_BYTES_LIMIT = 9_500_000;

function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface SpeechConfig {
  encoding: string;
  sampleRateHertz: number;
  audioChannelCount: number;
  languageCode: string;
  /** Auto-Detect candidates (Google v1 detects only from this supplied list). */
  alternativeLanguageCodes?: string[];
  enableAutomaticPunctuation: boolean;
  enableWordTimeOffsets: boolean;
  model: string;
}

async function headSizeMb(url: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const r = await fetch(url, { method: "HEAD", signal });
    const len = Number(r.headers.get("content-length") || 0);
    return len > 0 ? len / (1024 * 1024) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("cancelled"));
      },
      { once: true }
    );
  });
}

async function recognizeSync(
  token: string,
  config: SpeechConfig,
  contentBase64: string,
  signal?: AbortSignal
): Promise<SpeechResult[]> {
  const res = await fetch(`${SPEECH_API}/speech:recognize`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ config, audio: { content: contentBase64 } }),
    signal,
  });
  if (!res.ok) {
    throw speechHttpError("recognize", res.status, await res.text().catch(() => ""));
  }
  return ((await res.json()) as { results?: SpeechResult[] }).results ?? [];
}

async function recognizeLong(
  token: string,
  config: SpeechConfig,
  gcsUri: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SpeechResult[]> {
  const start = await fetch(`${SPEECH_API}/speech:longrunningrecognize`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ config, audio: { uri: gcsUri } }),
    signal,
  });
  if (!start.ok) {
    throw speechHttpError("longrunningrecognize", start.status, await start.text().catch(() => ""));
  }
  const opName = ((await start.json()) as { name?: string }).name;
  if (!opName) throw new Error("no long-running operation name returned");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000, signal);
    const op = await fetch(`${SPEECH_API}/operations/${encodeURIComponent(opName)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (!op.ok) throw new Error(`speech operation poll ${op.status}`);
    const json = (await op.json()) as {
      done?: boolean;
      error?: { message?: string };
      response?: { results?: SpeechResult[] };
    };
    if (json.done) {
      if (json.error) throw new Error(`speech LRO failed: ${json.error.message ?? "unknown"}`);
      return json.response?.results ?? [];
    }
  }
  throw new Error("speech transcription timed out");
}

export function createGoogleSpeechProvider(): TranscriptProvider {
  const model = process.env.TRANSCRIPT_MODEL || "latest_long";
  return {
    name: "google_speech",
    model,
    async transcribeVideo(input: TranscribeInput): Promise<Transcript> {
      // The caller's plan-level cap (caption quota) wins over the env default,
      // so higher tiers aren't clipped by the global fallback.
      const maxDurationSec =
        input.maxDurationSeconds ?? num(process.env.TRANSCRIPT_MAX_DURATION_SECONDS, 900);
      const maxFileMb = num(process.env.TRANSCRIPT_MAX_FILE_MB, 260);
      // Bounded well under the route's 300s wall so transcription + the Gemini
      // finalize steps both fit. Long videos that exceed it → failed (non-blocking).
      const timeoutMs = num(process.env.TRANSCRIPT_TIMEOUT_MS, 120_000);

      if (input.durationSeconds && input.durationSeconds > maxDurationSec) {
        return { status: "unavailable", error: `media exceeds ${maxDurationSec}s ASR limit` };
      }
      const sizeMb = await headSizeMb(input.videoUrl, input.signal);
      if (sizeMb != null && sizeMb > maxFileMb) {
        return { status: "unavailable", error: `media ${Math.round(sizeMb)}MB exceeds ${maxFileMb}MB ASR limit` };
      }

      const createdAt = Date.now();
      const extracted = await extractAudioToFlac({
        videoUrl: input.videoUrl,
        durationSec: input.durationSeconds ?? maxDurationSec,
        maxDurationSec,
        signal: input.signal,
      });
      let gcsObject: string | null = null;
      try {
        const token = await getCloudAccessToken();
        // The caller resolves the spoken language (see resolveTranscriptLanguage)
        // and passes it verbatim. TRANSCRIPT_LANGUAGE is only a fallback when the
        // caller sent NOTHING — it must never override the user's selection.
        const languageCode = input.languageCode?.trim() || process.env.TRANSCRIPT_LANGUAGE || "en-US";
        // v1 detects languages ONLY from this supplied candidate list. Cap at 3,
        // and never include the primary. Empty in selected mode (no detection).
        const alternativeLanguageCodes = (input.alternativeLanguageCodes ?? [])
          .filter((c) => c && c.toLowerCase() !== languageCode.toLowerCase())
          .slice(0, 3);
        const config: SpeechConfig = {
          encoding: "FLAC",
          sampleRateHertz: EXTRACT_SAMPLE_RATE,
          audioChannelCount: EXTRACT_CHANNELS,
          languageCode,
          ...(alternativeLanguageCodes.length ? { alternativeLanguageCodes } : {}),
          enableAutomaticPunctuation: true,
          enableWordTimeOffsets: true,
          model,
        };
        const useLong = extracted.durationSec > SYNC_AUDIO_LIMIT_SEC || extracted.bytes > INLINE_BYTES_LIMIT;
        console.info("[asr:google-speech:start]", {
          model,
          languageCode: config.languageCode,
          alternativeLanguageCodes: config.alternativeLanguageCodes ?? [],
          audioSec: extracted.durationSec,
          audioBytes: extracted.bytes,
          mode: useLong ? "longrunning" : "sync",
        });

        let results: SpeechResult[];
        if (!useLong) {
          const content = (await readFile(extracted.path)).toString("base64");
          results = await recognizeSync(token, config, content, input.signal);
        } else {
          const { storage } = getAdmin();
          const bucket = storage.bucket();
          gcsObject = `transcripts/tmp/asr-${createdAt}-${randomUUID()}.flac`;
          const buf = await readFile(extracted.path);
          await bucket.file(gcsObject).save(buf, { contentType: "audio/flac", resumable: false });
          results = await recognizeLong(token, config, `gs://${bucket.name}/${gcsObject}`, timeoutMs, input.signal);
        }

        const parsed = parseSpeechResults(results);
        // Google reports the matched language in results[].languageCode (esp. with
        // alternativeLanguageCodes). When it doesn't, fall back to what we REQUESTED —
        // never to en-US, so an Arabic run stays Arabic in the recorded metadata.
        const detectedLanguage = parsed.language || languageCode;
        console.info("[asr:google-speech:result]", {
          status: "complete",
          requestedLanguage: languageCode,
          detectedLanguage,
          segments: parsed.segments.length,
          words: parsed.words.length,
          durationAnalyzed: extracted.durationSec,
        });
        return {
          status: "complete",
          text: parsed.text,
          language: detectedLanguage,
          segments: parsed.segments,
          words: parsed.words,
          provider: {
            provider: "google_speech",
            model,
            createdAt,
            durationAnalyzed: extracted.durationSec,
            languageCode,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "speech transcription failed";
        console.warn("[asr:google-speech:error]", { message });
        return { status: "failed", error: message };
      } finally {
        await extracted.cleanup();
        if (gcsObject) {
          try {
            await getAdmin().storage.bucket().file(gcsObject).delete({ ignoreNotFound: true });
          } catch {
            /* best-effort temp cleanup */
          }
        }
      }
    },
  };
}
