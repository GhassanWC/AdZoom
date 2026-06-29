/** Map a raw render/upload error to a clean, classifiable user-facing message.
 *  Raw detail stays in the worker logs; only this reaches Firestore/the UI. */
export interface UserFacingError {
  code: string;
  message: string;
}

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
