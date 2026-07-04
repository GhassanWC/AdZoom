/**
 * Caption/transcription state — SEPARATE from the main analysis status.
 *
 * Captions are an independent transcription feature: they can be disabled,
 * blocked by the caption quota, still processing in the background, or failed
 * — all while the AI edit itself is complete. This resolver derives the ONE
 * caption state every surface shows (analysis summary card, processing
 * overlay, export panel), from real recorded data only:
 *
 *   • the run's captions preference (`lastRunOptions.generateCaptions`)
 *   • the transcript lifecycle (`analysis.transcript.status`)
 *   • the structured skip reason (`transcript.skipReason` — quota vs generic)
 *
 * The MAIN analysis status is never used as the caption status, and existing
 * projects (no `skipReason`, no usage fields) resolve exactly as before.
 */
import type { Transcript } from "@/lib/firebase/schema";

export type CaptionState =
  | "disabled"
  | "not_started"
  | "processing"
  | "complete"
  | "failed"
  | "unavailable"
  | "blocked_by_quota";

export function resolveCaptionState(input: {
  /** The run's captions toggle — `generateCaptions !== false`. */
  captionsRequested: boolean;
  transcript: Transcript | null | undefined;
}): CaptionState {
  const { captionsRequested, transcript } = input;
  if (!captionsRequested) return "disabled";
  const status = transcript?.status ?? "not_started";
  switch (status) {
    case "not_started":
      return "not_started";
    case "processing":
      return "processing";
    case "complete":
      return "complete";
    case "failed":
      return "failed";
    case "unavailable":
      return transcript?.skipReason === "quota_exhausted" ||
        transcript?.skipReason === "per_video_limit"
        ? "blocked_by_quota"
        : "unavailable";
    default:
      return "unavailable";
  }
}

/** Short status labels for the caption card / progress row. */
export const CAPTION_STATE_LABEL: Record<CaptionState, string> = {
  disabled: "Disabled",
  not_started: "Not started",
  processing: "Transcribing in background…",
  complete: "Complete",
  failed: "Failed",
  unavailable: "Unavailable",
  blocked_by_quota: "Quota exhausted",
};
