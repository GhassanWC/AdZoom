import type { ProjectStatus, AnalysisErrorKind } from "./firebase/schema";

export interface StageDef {
  id: ProjectStatus;
  label: string;
  description: string;
}

/**
 * Ordered list of analysis stages shown in the processing UI.
 * The server walks these in order; the client renders them as a checklist.
 */
// NOTE: these coarse server stages drive the progress FRACTION (indexing), not
// the user-facing step list — the modern, video-type-aware, option-filtered
// steps live in `src/lib/analysis-progress.ts`. Labels here are generic (no
// screen-recording-only language) so any surface that still reads them is clean.
export const ANALYSIS_STAGES: StageDef[] = [
  { id: "scanning_frames", label: "Preparing video", description: "Reading the video on-device — motion, scenes, and visual density." },
  { id: "preparing", label: "Preparing analysis", description: "Loading the project and the source video." },
  { id: "uploading_to_gemini", label: "Preparing AI analysis", description: "Getting the video ready for the AI model." },
  { id: "extracting_frames", label: "Reading the video", description: "The AI model is decoding + indexing the video." },
  { id: "analyzing", label: "Analyzing the video", description: "Finding the scenes and moments that matter." },
  { id: "generating_timeline", label: "Building your edit", description: "Adding the selected edits to the timeline." },
  { id: "generating_presets", label: "Finishing up", description: "Choosing presets that fit this video." },
];

/**
 * Stages that count as "currently processing" (animated, modal open by default).
 * Excludes terminal states (analyzed/completed/failed/cancelled).
 */
export const PROCESSING_STATES: ProjectStatus[] = [
  "scanning_frames",
  "preparing",
  "uploading_to_gemini",
  "extracting_frames",
  "analyzing",
  "generating_timeline",
  "generating_presets",
];

export function isProcessing(status?: ProjectStatus): boolean {
  if (!status) return false;
  return PROCESSING_STATES.includes(status);
}

export function isTerminal(status?: ProjectStatus): boolean {
  if (!status) return false;
  return (
    status === "analyzed" ||
    status === "completed" ||
    status === "exported" ||
    status === "failed" ||
    status === "cancelled"
  );
}

export function stageIndex(status?: ProjectStatus): number {
  if (!status) return -1;
  return ANALYSIS_STAGES.findIndex((s) => s.id === status);
}

/**
 * Rough estimate: based on file size and duration. Returns seconds.
 *  - ~6 s baseline overhead
 *  - +0.8 s per MB (Gemini upload + extraction)
 *  - +0.4 s per second of video (Gemini analyze time)
 * Clamped to [30, 240].
 */
export function estimateAnalysisSeconds(
  fileSizeBytes?: number,
  durationSeconds?: number
): number {
  const mb = (fileSizeBytes ?? 0) / (1024 * 1024);
  const dur = durationSeconds ?? 0;
  const raw = 6 + mb * 0.8 + dur * 0.4;
  return Math.max(30, Math.min(240, Math.round(raw)));
}

export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Human-readable recovery message per error kind. */
export const ERROR_RECOVERY: Record<
  AnalysisErrorKind,
  { title: string; reason: string; suggestion: string }
> = {
  gemini_timeout: {
    title: "Gemini timed out",
    reason: "Gemini took too long to analyze this clip. Usually this is brief congestion.",
    suggestion: "Try again in a minute. For very long videos, trim to under 5 minutes for fastest results.",
  },
  gemini_quota: {
    title: "Gemini quota reached",
    reason: "Your Google AI Studio key has hit its per-minute or per-day quota.",
    suggestion: "Wait a few minutes and retry, or open Google AI Studio to raise the quota.",
  },
  gemini_unsupported: {
    title: "Unsupported video",
    reason: "Gemini could not decode this video — usually a codec it doesn't recognize (e.g. ProRes, HEVC variant).",
    suggestion: "Re-export as MP4 (H.264 / AAC) and re-upload. Most screen recorders have this option in their preferences.",
  },
  gemini_invalid_argument: {
    title: "Gemini rejected the request",
    reason: "The video format or size didn't match what Gemini expects. This sometimes happens on .mov files with unusual headers.",
    suggestion: "Re-export to standard MP4 and try again.",
  },
  upload_failed: {
    title: "Couldn't load the video",
    reason: "We couldn't read your video from Firebase Storage. The file may have been deleted or your session expired.",
    suggestion: "Re-upload the video and start a fresh project.",
  },
  video_too_large: {
    title: "Video too large",
    reason: "This file exceeds the 2 GB limit, or Gemini refused the inline payload.",
    suggestion: "Compress or trim the recording, then re-upload.",
  },
  network_interruption: {
    title: "Analysis connection failed",
    reason: "Framevo couldn't reach the AI service. This is usually a temporary network or connectivity issue.",
    suggestion: "Please retry — or run it in the background and try again in a moment. If it keeps happening, check your network/VPN and try a different browser.",
  },
  unknown: {
    title: "Something went wrong",
    reason: "We hit an error we don't recognize. The full message is below.",
    suggestion: "Retry. If the error repeats, copy the message above and report it.",
  },
};

export function classifyError(message: string): AnalysisErrorKind {
  const m = message.toLowerCase();
  if (m.includes("timeout") || m.includes("timed out") || m.includes("deadline_exceeded") || m.includes("deadline exceeded"))
    return "gemini_timeout";
  if (m.includes("quota") || m.includes("rate") || m.includes("resource_exhausted"))
    return "gemini_quota";
  if (m.includes("unsupported") || m.includes("invalid file") || m.includes("not supported") || m.includes("codec"))
    return "gemini_unsupported";
  if (m.includes("invalid_argument") || m.includes("invalid argument") || m.includes("failed_precondition"))
    return "gemini_invalid_argument";
  if (m.includes("storage object missing") || m.includes("does not exist") || m.includes("permission_denied"))
    return "upload_failed";
  if (m.includes("too large") || m.includes("payload size") || m.includes("exceeded"))
    return "video_too_large";
  if (
    m.includes("network") ||
    m.includes("econn") ||
    m.includes("etimedout") ||
    m.includes("fetch failed") ||
    // gRPC UNAVAILABLE / transport failures (e.g. "14 UNAVAILABLE: No connection
    // established. Last error: Failed to connect").
    m.includes("unavailable") ||
    m.includes("no connection") ||
    m.includes("failed to connect") ||
    m.includes("couldn't reach") ||
    m.includes("connectivity") ||
    m.includes("connection failed")
  )
    return "network_interruption";
  return "unknown";
}
