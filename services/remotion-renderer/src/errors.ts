/** Map a raw render/upload error to a clean, classifiable user-facing message.
 *  Raw detail stays in the worker logs; only this reaches Firestore/the UI. */
export interface UserFacingError {
  code: string;
  message: string;
}

/**
 * The source recording couldn't be made available to the renderer — the object
 * is missing/empty, unreadable by the worker's SA, or a signed read URL could
 * not be minted (e.g. the runtime SA lacks token-creator/signBlob rights). Always
 * surfaced as `source_unavailable` regardless of the underlying message, so a
 * signing failure never gets mislabeled as a generic render error or a timeout.
 */
export class SourceUnavailableError extends Error {
  readonly code = "source_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

export const SOURCE_UNAVAILABLE_MESSAGE =
  "Couldn't read the source recording. Please try again.";

/**
 * Frame 0 couldn't be rendered/decoded in the pre-render smoke test — the source
 * video can't be decoded by the compositor (bad codec, corrupt file, or the
 * OffthreadVideo pipeline can't read it). Fails fast before committing to a long
 * full render that would only hang.
 */
export class VideoDecodeError extends Error {
  readonly code = "video_decode_failed";
  constructor(message: string) {
    super(message);
    this.name = "VideoDecodeError";
  }
}

export const VIDEO_DECODE_FAILED_MESSAGE =
  "Could not decode the source video for cloud export.";

export function toUserFacingError(err: unknown): UserFacingError {
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (raw.includes("render_timeout") || raw.includes("timed out") || raw.includes("timeout")) {
    return { code: "render_timeout", message: "The export took too long and was stopped. Please try again." };
  }
  if (raw.includes("upload_failed") || raw.includes("upload")) {
    return { code: "upload_failed", message: "The export rendered but couldn't be uploaded. Please try again." };
  }
  if (
    raw.includes("no such object") ||
    raw.includes("not found") ||
    raw.includes("download") ||
    raw.includes("source")
  ) {
    return { code: "source_unavailable", message: "Couldn't read the source recording. Please try again." };
  }
  if (raw.includes("decode") || raw.includes("unsupported") || raw.includes("codec")) {
    return { code: "unsupported_source", message: "This recording couldn't be processed for export." };
  }
  return { code: "render_failed", message: "Something went wrong while exporting your video. Please try again." };
}
