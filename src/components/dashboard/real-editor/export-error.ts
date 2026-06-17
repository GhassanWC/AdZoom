/**
 * Stage-tagged export errors — the single contract for "what failed, and where".
 *
 * The export runs through a fixed sequence of stages (permit → load-video →
 * canvas → recorder → audio → render → upload). Before this existed, ANY raw
 * throw — a Firebase `StorageError`, a `DOMException`, a tainted-canvas
 * `SecurityError`, even a bare gRPC "Internal Error." — surfaced to the user
 * verbatim with no context, which is exactly the useless "Internal Error."
 * production report this fixes.
 *
 * `ExportError` carries:
 *   • `stage`   — which pipeline stage threw (drives diagnostics + the UI hint).
 *   • `message` — a FRIENDLY, user-facing reason (already human-readable).
 *   • `cause`   — the original error, preserved for the console + debug panel.
 *   • `detail`  — extra structured, NON-SECRET context (dims, codes, sizes).
 *
 * Mirrors `RecordingError` (src/lib/recording/types.ts) so the two failure
 * surfaces in the app read consistently.
 */

export type ExportStage =
  | "permit"
  | "load-video"
  | "audio"
  | "canvas"
  | "recorder"
  | "render"
  | "upload"
  | "unknown";

export class ExportError extends Error {
  readonly stage: ExportStage;
  /** The original error this wraps (kept for the console + debug panel). */
  readonly cause?: unknown;
  /** Extra structured context for diagnostics. MUST NOT contain secrets/tokens. */
  readonly detail?: Record<string, unknown>;

  constructor(
    stage: ExportStage,
    message: string,
    opts?: { cause?: unknown; detail?: Record<string, unknown> }
  ) {
    super(message);
    this.name = "ExportError";
    this.stage = stage;
    this.cause = opts?.cause;
    this.detail = opts?.detail;
  }
}

/** Flattened, log-/UI-safe view of any thrown value. */
export interface ErrorDetail {
  /** Constructor name / DOMException name (e.g. "SecurityError", "FirebaseError"). */
  name?: string;
  /** SDK error code when present (e.g. "storage/unauthorized", "auth/internal-error"). */
  code?: string;
  /** Human message. Always set. */
  message: string;
  /** Stack, when available. */
  stack?: string;
  /** The stage, when the value is (or wraps) an ExportError. */
  stage?: ExportStage;
}

/**
 * Normalize ANY thrown value into a flat, printable shape. Pulls `.code` off
 * Firebase errors and `.name` off DOMExceptions so the console/debug panel can
 * show the real failure code, not just a generic message. For an `ExportError`
 * it also drills into `.cause` to recover the underlying SDK code.
 */
export function describeError(err: unknown): ErrorDetail {
  if (err instanceof ExportError) {
    const inner = err.cause !== undefined ? describeError(err.cause) : undefined;
    return {
      name: inner?.name ?? err.name,
      code: inner?.code,
      message: err.message,
      stack: err.stack ?? inner?.stack,
      stage: err.stage,
    };
  }
  if (err && typeof err === "object") {
    const e = err as {
      name?: string;
      code?: unknown;
      message?: unknown;
      stack?: unknown;
    };
    return {
      name: typeof e.name === "string" ? e.name : undefined,
      code: typeof e.code === "string" ? e.code : undefined,
      message:
        typeof e.message === "string" && e.message ? e.message : String(err),
      stack: typeof e.stack === "string" ? e.stack : undefined,
    };
  }
  return { message: String(err) };
}

/**
 * Wrap an unknown error as an `ExportError` for `stage`, preserving an existing
 * `ExportError` unchanged (so the deepest, most-specific stage wins). Use this
 * at stage boundaries that call into code which throws plain errors.
 */
export function toExportError(
  err: unknown,
  stage: ExportStage,
  fallbackMessage?: string
): ExportError {
  if (err instanceof ExportError) return err;
  const d = describeError(err);
  return new ExportError(stage, fallbackMessage ?? d.message, { cause: err });
}

/**
 * Is this error a user-initiated cancel (abort)? Cancels flow through
 * `AbortError` / Firebase `storage/canceled` and must NOT be reported as a
 * failure. The provider also checks `signal.aborted`, but this catches the
 * cases where the signal isn't reachable.
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const d = describeError(err);
  return d.name === "AbortError" || d.code === "storage/canceled";
}

/**
 * Map a Firebase Storage error code to a clear, actionable upload-stage reason.
 * Falls back to the raw message so nothing is ever swallowed.
 */
export function friendlyStorageMessage(code: string | undefined, raw: string): string {
  switch (code) {
    case "storage/unauthorized":
      return "Storage permission denied — you don't have access to write this export.";
    case "storage/unauthenticated":
      return "Your session expired. Sign in again and re-run the export.";
    case "storage/canceled":
      return "Upload canceled.";
    case "storage/quota-exceeded":
      return "Storage quota exceeded for this project.";
    case "storage/retry-limit-exceeded":
      return "Upload timed out (network or CORS). Check Storage CORS for this domain, then retry.";
    case "storage/invalid-checksum":
    case "storage/server-file-wrong-size":
      return "Upload was corrupted in transit. Please retry.";
    case "storage/unknown":
      return "Storage rejected the upload (often a missing CORS rule for this domain).";
    default:
      return raw || "The export couldn't be saved to storage.";
  }
}
