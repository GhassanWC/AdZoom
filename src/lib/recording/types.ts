/**
 * Recording engine — shared types.
 *
 * The engine orchestrates `getDisplayMedia` (screen) and `getUserMedia`
 * (mic + webcam) into a single MediaRecorder pipeline. The webcam stays as a
 * separate stream for live PiP preview; it is **not** composited into the
 * recorded video in v1 — that happens at export time, Screen-Studio-style.
 */

import type { CaptureDimensions } from "./scope-detect";

export type RecordingState =
  | "idle"
  | "preparing"
  | "ready"
  | "recording"
  | "paused"
  | "stopped"
  | "error";

export interface RecordingOptions {
  /** Always true in v1 — screen is the primary track. */
  screen: boolean;
  /** Capture the user's webcam as a live preview stream (not composited yet). */
  webcam: boolean;
  /** Capture mic audio; mixed with system audio (if granted). */
  mic: boolean;
  /**
   * Try to capture system audio via getDisplayMedia's audio track. Browsers
   * only honor this for "Chrome tab" sources, so it can silently fall through.
   */
  systemAudio: boolean;
}

/**
 * Global source-frame crop — the CapCut-style "Frame Crop". A normalized
 * rectangle of the source video that is kept; everything outside it is removed
 * from preview, AI/CV analysis, and export (a source-rect `drawImage`, not a
 * re-encode — the original blob is untouched). Applied to the WHOLE video,
 * BEFORE Canvas Fit. Distinct from per-moment Crop/Reframe (`CropSettings`,
 * time-based) and from Canvas Fit (output canvas).
 *
 * Coords are normalized 0..1 of the FULL source frame. The browser-tab green
 * sharing-bar cleanup is just a `sourceCrop` with `reason:"browser-bar-cleanup"`
 * (a bottom-only rect). Absent / `enabled:false` ⇒ full frame (no crop).
 */
export interface SourceCrop {
  /** When false (or absent), the full source frame is used (no crop). */
  enabled: boolean;
  /** Crop rectangle, normalized 0..1 of the full source frame. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Resize constraint while editing; "free"/"source" = unconstrained. */
  aspectLock?: "free" | "16:9" | "9:16" | "1:1" | "4:5" | "source";
  /** Provenance — drives UI affordances (e.g. the sharing-bar toggle). */
  reason?: "manual" | "browser-bar-cleanup" | "auto-detected";
  /** Detector confidence 0..1 when `reason === "browser-bar-cleanup"`. */
  confidence?: number;
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  /** Duration in seconds — measured from start/stop ticks, not the blob header. */
  durationSeconds: number;
  /** Source resolution of the captured screen track. */
  width: number;
  height: number;
  /**
   * Real user interactions captured during recording. Always tab-scoped in v1
   * (browser can't see input outside the Framevo tab). Empty when the user
   * recorded an external surface — see `interactionScope`.
   */
  interactions: Interaction[];
  /**
   * "tab" = events came from our own viewport and are authoritative.
   * "external" = the user picked a different window/tab/screen; events array
   * is empty (or noise from our own UI) and downstream must rely on CV only.
   */
  interactionScope: "tab" | "external";
  /**
   * Raw `displaySurface` from the captured video track, when the browser
   * exposes it. "browser" means the user picked a tab — which is the path
   * most likely to bake Chrome's sharing-controls strip into the video.
   * The preview uses this to decide whether to run the green-band detector.
   */
  displaySurface: "monitor" | "window" | "browser" | null;
  /**
   * Capture geometry (track dims, viewport, DPR) recorded at scope-decision
   * time. Persisted on the project doc so the analyzer can independently
   * re-validate scope instead of blindly trusting the capture-time call.
   */
  captureDimensions?: CaptureDimensions;
  /**
   * Global source-frame crop. Seeded at record time when the green-band
   * detector fires on a `displaySurface === "browser"` take (a bottom-only rect
   * with `reason:"browser-bar-cleanup"`); the user can also draw one manually
   * in the editor. Persisted on the project doc and applied at every
   * render/analysis path. Absent ⇒ full frame.
   */
  sourceCrop?: SourceCrop;
}

/**
 * Bounding rect of a clicked element, normalised to the captured
 * display surface (0..1 each axis). Shared by `click`, `dblclick`,
 * `rightclick` variants below. Same coordinate space as the click's
 * own `x` / `y` so the classifier can derive "did the click land near
 * the centre of the element, or near an edge?".
 */
export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Real interaction event captured during recording. Discriminated by `type`.
 * Coordinates are normalized to viewport (0..1) so they line up with
 * `focusRegion` math in the editor.
 *
 * All timestamps `t` are seconds since `recording start` (paused time excluded
 * by the engine before it forwards events).
 */
export type Interaction =
  | {
      type: "mousemove";
      id: string;
      t: number;
      x: number;
      y: number;
      /** px/s along viewport diagonal. */
      velocity: number;
    }
  | {
      type: "click";
      id: string;
      t: number;
      x: number;
      y: number;
      button: "left" | "middle" | "right";
      /**
       * Element bounding rect at click time, normalised to the captured
       * display surface (0..1 each). Present only for tab-self captures
       * where `event.target` is meaningful; undefined for external
       * (window/monitor) captures because the Framevo tab and the
       * captured surface are different windows. Drives click-tier
       * classification in `src/lib/attention/click-classifier.ts`.
       */
      targetRect?: ElementRect;
    }
  | {
      type: "dblclick";
      id: string;
      t: number;
      x: number;
      y: number;
      targetRect?: ElementRect;
    }
  | {
      type: "rightclick";
      id: string;
      t: number;
      x: number;
      y: number;
      targetRect?: ElementRect;
    }
  | {
      type: "scroll";
      id: string;
      t: number;
      /** Negative = up, positive = down. */
      deltaY: number;
      /** px/s. */
      speed: number;
    }
  | {
      type: "scrollpause";
      id: string;
      t: number;
      /** Duration of the idle gap after the scroll, seconds. */
      pauseSeconds: number;
    }
  | {
      type: "typing";
      id: string;
      /** Burst start. */
      t: number;
      /** Burst end. */
      tEnd: number;
      /** Keystroke count — actual keys never stored (privacy). */
      keyCount: number;
    }
  | {
      type: "hover";
      id: string;
      t: number;
      x: number;
      y: number;
      /** Seconds the pointer stayed within ~16px before moving on / clicking. */
      durationSeconds: number;
    }
  | {
      type: "focus";
      id: string;
      t: number;
      /** "in" when a form/control received focus, "out" when it lost it. */
      direction: "in" | "out";
    }
  | {
      type: "resize";
      id: string;
      t: number;
      width: number;
      height: number;
    }
  | {
      type: "idle";
      id: string;
      t: number;
      tEnd: number;
    };

export interface RecordingTick {
  /** Elapsed seconds since `start()` (paused time excluded). */
  elapsedSeconds: number;
  /** Current mic input level, 0..1, smoothed. */
  micLevel: number;
}

export type RecordingEvent =
  | { type: "state"; state: RecordingState }
  | { type: "tick"; tick: RecordingTick }
  | { type: "result"; result: RecordingResult }
  | { type: "error"; error: RecordingError };

export class RecordingError extends Error {
  kind:
    | "permission_denied"
    | "no_display_media"
    | "no_supported_mime"
    | "recorder_failed"
    | "user_cancelled"
    | "unknown";
  constructor(
    kind: RecordingError["kind"],
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = "RecordingError";
    this.kind = kind;
  }
}

/**
 * Pick the first MediaRecorder-supported MIME type the browser implements.
 * Prefer mp4-flavored containers for downstream compatibility; fall back to
 * webm with vp9 / vp8 / opus.
 */
export function pickRecordingMime(): string {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return "video/webm";
}

/** Map a recording MIME type to a sensible file extension for the upload. */
export function mimeToExtension(mime: string): string {
  if (mime.startsWith("video/mp4")) return "mp4";
  if (mime.startsWith("video/webm")) return "webm";
  return "webm";
}

/**
 * Convert a raw `getDisplayMedia` rejection into a typed RecordingError.
 * The DOMException `name` is the most reliable signal: `NotAllowedError` and
 * `AbortError` are emitted when the user dismisses the picker (a benign
 * cancel, not a failure), while `NotFoundError` / `NotSupportedError` mean
 * the browser actually can't service the request.
 */
export function classifyGetDisplayMediaError(err: unknown): RecordingError {
  const name = (err as { name?: string } | null)?.name;
  const msg = (err as { message?: string } | null)?.message;
  switch (name) {
    case "NotAllowedError":
    case "AbortError":
      return new RecordingError("user_cancelled", "Screen share dismissed.", err);
    case "NotFoundError":
      return new RecordingError("no_display_media", "No screen source available.", err);
    case "NotSupportedError":
      return new RecordingError(
        "no_display_media",
        "Screen capture isn't supported in this browser.",
        err
      );
    default:
      return new RecordingError(
        "unknown",
        msg || "Couldn't start screen capture.",
        err
      );
  }
}

/**
 * Convert a `getUserMedia` rejection into a typed RecordingError, scoped to
 * which device was being requested. Mirrors `classifyGetDisplayMediaError` so
 * downstream handlers can render a consistent shape regardless of which API
 * threw.
 */
export function classifyGetUserMediaError(
  err: unknown,
  source: "microphone" | "webcam"
): RecordingError {
  const name = (err as { name?: string } | null)?.name;
  const msg = (err as { message?: string } | null)?.message;
  const label = source === "microphone" ? "Microphone" : "Webcam";
  switch (name) {
    case "NotAllowedError":
      return new RecordingError(
        "permission_denied",
        `${label} permission was blocked.`,
        err
      );
    case "AbortError":
      return new RecordingError("user_cancelled", `${label} prompt dismissed.`, err);
    case "NotFoundError":
      return new RecordingError(
        "permission_denied",
        `No ${source} device found.`,
        err
      );
    case "NotReadableError":
      return new RecordingError(
        "permission_denied",
        `${label} is in use by another app.`,
        err
      );
    case "NotSupportedError":
      return new RecordingError(
        "permission_denied",
        `${label} capture isn't supported in this browser.`,
        err
      );
    default:
      return new RecordingError(
        "unknown",
        msg || `Couldn't start ${source}.`,
        err
      );
  }
}
