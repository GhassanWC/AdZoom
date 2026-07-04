/**
 * Pure parser for Google Speech-to-Text v1 `results`. DOM/SDK-free (type-only
 * imports) so it's unit-testable + reused by the provider without pulling in
 * Node/GCP deps. Turns the API's results into Framevo's transcript shape.
 */
import type { TranscriptSegment, TranscriptWord } from "@/lib/firebase/schema";

/**
 * Turn a Speech-to-Text REST error (status + raw body) into a CONCISE, actionable
 * message — never a raw truncated JSON dump. Special-cases the most common
 * local-setup failure (the Speech API not enabled on the project) with the exact
 * enable URL. Pure string logic, so it lives here (testable) not in the provider.
 */
export function speechHttpError(op: string, status: number, body: string): Error {
  let apiMessage = "";
  let reason = "";
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string; status?: string; details?: Array<{ reason?: string }> };
    };
    apiMessage = j.error?.message ?? "";
    reason = j.error?.status ?? j.error?.details?.find((d) => d.reason)?.reason ?? "";
  } catch {
    /* non-JSON body — fall through to the raw snippet */
  }
  // 403 + "has not been used" / SERVICE_DISABLED → the API is off for the project.
  if (
    status === 403 &&
    (/has not been used|SERVICE_DISABLED|is disabled/i.test(apiMessage) || reason === "SERVICE_DISABLED")
  ) {
    const project = apiMessage.match(/project (\d+)/i)?.[1];
    const url = project
      ? `https://console.developers.google.com/apis/api/speech.googleapis.com/overview?project=${project}`
      : "https://console.cloud.google.com/apis/library/speech.googleapis.com";
    return new Error(
      `Cloud Speech-to-Text API is not enabled${project ? ` for project ${project}` : ""}. ` +
        `Enable it at ${url}, wait ~1 minute for it to propagate, then re-analyze.`
    );
  }
  const detail = apiMessage.trim() || body.replace(/\s+/g, " ").trim().slice(0, 200) || `HTTP ${status}`;
  return new Error(`Speech-to-Text ${op} failed (${status}): ${detail}`);
}

/** A gRPC/REST duration: "1.200s" | { seconds, nanos } | number → seconds. */
export function parseDuration(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/s$/, ""));
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v === "object") {
    const o = v as { seconds?: number | string; nanos?: number };
    const s = Number(o.seconds ?? 0);
    const nanos = Number(o.nanos ?? 0);
    return (Number.isFinite(s) ? s : 0) + (Number.isFinite(nanos) ? nanos / 1e9 : 0);
  }
  return 0;
}

export interface SpeechWord {
  word?: string;
  startTime?: unknown;
  endTime?: unknown;
  confidence?: number;
}
export interface SpeechAlternative {
  transcript?: string;
  confidence?: number;
  words?: SpeechWord[];
}
export interface SpeechResult {
  alternatives?: SpeechAlternative[];
  languageCode?: string;
  resultEndTime?: unknown;
}

export interface ParsedTranscript {
  text: string;
  language?: string;
  segments: TranscriptSegment[];
  words: TranscriptWord[];
}

/**
 * Build a transcript from Speech-to-Text `results`. Each result becomes a
 * segment (top alternative); word timings flatten into `words`. Times fall back
 * gracefully when word offsets are absent (uses `resultEndTime` + the prior
 * segment's end so segments never overlap or invert).
 */
export function parseSpeechResults(results: SpeechResult[] | undefined | null): ParsedTranscript {
  const segments: TranscriptSegment[] = [];
  const words: TranscriptWord[] = [];
  const texts: string[] = [];
  let language: string | undefined;
  let prevEnd = 0;

  for (let i = 0; i < (results?.length ?? 0); i++) {
    const r = results![i];
    const alt = r.alternatives?.[0];
    const text = (alt?.transcript ?? "").trim();
    if (!text) continue;
    if (!language && r.languageCode) language = r.languageCode;

    const segWords: TranscriptWord[] = (alt?.words ?? [])
      .filter((w) => (w.word ?? "").trim().length > 0)
      .map((w) => ({
        word: (w.word ?? "").trim(),
        startTime: parseDuration(w.startTime),
        endTime: parseDuration(w.endTime),
        ...(typeof w.confidence === "number" ? { confidence: w.confidence } : {}),
      }));

    let start: number;
    let end: number;
    if (segWords.length > 0) {
      start = segWords[0].startTime;
      end = segWords[segWords.length - 1].endTime;
    } else {
      start = prevEnd;
      end = parseDuration(r.resultEndTime) || prevEnd;
    }
    if (!(end > start)) end = start + 0.5;
    prevEnd = end;

    segments.push({
      id: `seg-${i}`,
      startTime: start,
      endTime: end,
      text,
      ...(typeof alt?.confidence === "number" ? { confidence: alt.confidence } : {}),
    });
    words.push(...segWords);
    texts.push(text);
  }

  return { text: texts.join(" ").trim(), language, segments, words };
}
