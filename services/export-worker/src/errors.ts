/**
 * Translate a worker/ffmpeg failure into a SHORT, user-facing line for the
 * job's `errorMessage` (rendered verbatim in the export panel).
 *
 * FFmpeg's raw stderr — codec ids, stream maps, filtergraph dumps, hex
 * addresses — is useless and alarming to an end user, so it must NEVER reach
 * Firestore/the UI. The handler still logs the full detail via console.error
 * (worker logs only); only the clean line returned here is persisted.
 *
 * Note: an UNSUPPORTED audio codec (e.g. Apple `apac`) does not normally reach
 * here at all — the render guard (`canDecodeAudio`) drops such audio and exports
 * silently with a warning. The audio branch below is the backstop for a source
 * that still trips the encoder despite the guard.
 */
export interface UserFacingError {
  /** Stable, machine-readable reason — useful for analytics/grouping. */
  code: string;
  /** One clean sentence safe to show the user. No ffmpeg text. */
  message: string;
}

export function toUserFacingError(err: unknown): UserFacingError {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();

  // Audio the bundled ffmpeg can't decode/transcode, or a filtergraph it can't
  // open — the classic "no decoder found for: none" / "Could not find codec
  // parameters" family produced by codecs like `apac`.
  if (
    raw.includes("no decoder found") ||
    raw.includes("could not find codec parameters") ||
    raw.includes("initializing a simple filtergraph") ||
    raw.includes("error initializing")
  ) {
    return {
      code: "audio_unsupported",
      message:
        "This video's audio is in a format we can't process. Please try exporting again — if it keeps failing, the audio track may be unsupported.",
    };
  }

  // Watchdog tripped — no frames produced within the stall timeout.
  if (raw.includes("stalled")) {
    return {
      code: "render_stalled",
      message:
        "The export stalled while rendering. The source video may be unreadable or in an unsupported format. Please try again.",
    };
  }

  // A missing binary / spawn failure is an infra problem, not the user's file.
  if (raw.includes("enoent") || raw.includes("spawn")) {
    return {
      code: "worker_error",
      message: "The export service hit a temporary problem. Please try again in a moment.",
    };
  }

  // A broken encoder pipe that slipped past spawnEncoder's error-race (rare) —
  // map it cleanly rather than leaking a bare "write EPIPE" to the user.
  if (
    raw.includes("epipe") ||
    raw.includes("broken pipe") ||
    raw.includes("write after end")
  ) {
    return {
      code: "encoder_pipe_broken",
      message: "The export ended unexpectedly while encoding. Please try again.",
    };
  }

  // Anything else: a generic, non-leaky fallback.
  return {
    code: "render_failed",
    message: "Something went wrong while exporting your video. Please try again.",
  };
}
