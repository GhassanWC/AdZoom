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

  // Normalization was required (normalizeEnabled) but didn't run — we refuse to
  // silently render the original. Almost always a STALE worker image; distinct
  // code so it's obvious the deploy, not the user's file, is the problem.
  if (raw.includes("normalize_not_executed")) {
    return {
      code: "normalize_not_executed",
      message: "The export could not be prepared (normalization did not run). Please try again; if it persists the render service needs an update.",
    };
  }

  // The render's memory guard tripped — RSS ran away (frames not streamed to
  // ffmpeg). Surfaced as a distinct code so it's never mistaken for a user-file
  // problem; the fix is in the renderer, not the upload.
  if (raw.includes("memory_leak_detected")) {
    return {
      code: "memory_leak_detected",
      message: "The export ran out of memory and was stopped. Please try again — if it keeps happening, contact support.",
    };
  }

  // The render finished but the final MP4 unexpectedly has NO audio while the
  // source had a usable track (a genuine bug, not an unsupported codec which is
  // handled by dropping audio + a warning). Surfaced as its own code so it's
  // never confused with the silent-fallback path.
  if (raw.includes("audio_missing_after_render")) {
    return {
      code: "audio_missing_after_render",
      message:
        "The export finished but its audio went missing. Please try again — if it keeps happening, contact support.",
    };
  }

  // The normalization (pre-transcode) pass itself failed.
  if (raw.includes("normalize_failed")) {
    return {
      code: "normalize_failed",
      message:
        "We couldn't prepare this video for export. Please try again, or re-upload the file.",
    };
  }

  // Uploading the finished MP4 to storage failed.
  if (raw.includes("upload_failed")) {
    return {
      code: "upload_failed",
      message: "The export rendered but couldn't be saved. Please try again.",
    };
  }

  // Audio the bundled ffmpeg can't decode/transcode, or a filtergraph it can't
  // open — the classic "no decoder found for: none" / "Could not find codec
  // parameters" family produced by codecs like `apac`.
  if (
    raw.includes("audio_decode_failed") ||
    raw.includes("no decoder found") ||
    raw.includes("could not find codec parameters") ||
    raw.includes("initializing a simple filtergraph") ||
    raw.includes("error initializing")
  ) {
    return {
      code: "audio_decode_failed",
      message:
        "This video's audio is in a format we can't process. Please try exporting again — if it keeps failing, the audio track may be unsupported.",
    };
  }

  // Normalization couldn't transcode the source VIDEO even video-only (corrupt /
  // truly unsupported codec). The normalizer drops bad AUDIO silently, so this is
  // specifically an unusable video track — the one case that legitimately fails.
  if (raw.includes("unsupported_video")) {
    return {
      code: "unsupported_video",
      message:
        "We couldn't process this video's format. Please re-upload it or try a different file.",
    };
  }

  // Preflight fast-fail: the bundled ffmpeg can't decode the source video at all
  // (corrupt / truly unsupported). Distinct from a stall — we caught it up front.
  if (raw.includes("could not be decoded") || raw.includes("preflight")) {
    return {
      code: "decode_failed",
      message:
        "We couldn't read this video — it may be corrupt or in a format we can't process. Please re-upload it or try a different file.",
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
