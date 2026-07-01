/**
 * Tunables for the progressive chunked analysis engine.
 *
 * Short videos (≤ threshold) keep the existing direct `startAnalyze` path
 * unchanged; longer videos route to the chunk orchestrator so edits stream in
 * progressively instead of after the whole video finishes.
 */

/** Videos with duration ≤ this (seconds) use the existing direct flow. */
export const CHUNKED_ANALYSIS_THRESHOLD_S = 90;

/** Default target chunk length (seconds) — the "Balanced" preset. */
export const CHUNK_SIZE_S = 30;

/** User-selectable analysis-granularity presets. */
export type ChunkMode = "fast" | "balanced" | "detailed" | "very-detailed" | "custom";

/** Hard bounds for any chunk size (preset or custom). */
export const CHUNK_SIZE_MIN_S = 5;
export const CHUNK_SIZE_MAX_S = 60;

/** Chunk length (seconds) for each non-custom preset. */
export const CHUNK_MODE_SIZES: Record<Exclude<ChunkMode, "custom">, number> = {
  fast: 45,
  balanced: 30,
  detailed: 15,
  "very-detailed": 10,
};

/** Friendly label for a chunk mode — shown in the dialog + processing UI. */
export function chunkModeLabel(mode: ChunkMode): string {
  switch (mode) {
    case "fast":
      return "Fast";
    case "detailed":
      return "Detailed";
    case "very-detailed":
      return "Very detailed";
    case "custom":
      return "Custom";
    case "balanced":
    default:
      return "Balanced";
  }
}

/** Clamp a chunk size to the allowed [MIN, MAX] range (rounded to whole seconds). */
export function clampChunkSize(seconds: number): number {
  if (!Number.isFinite(seconds)) return CHUNK_SIZE_S;
  return Math.min(CHUNK_SIZE_MAX_S, Math.max(CHUNK_SIZE_MIN_S, Math.round(seconds)));
}

/**
 * Resolve the effective chunk size (seconds) for a granularity choice:
 *  - a preset → its fixed size;
 *  - custom "by count" (a target chunk count) → duration / count, clamped;
 *  - custom "by size" → the entered size, clamped.
 */
export function resolveChunkSize(
  mode: ChunkMode,
  opts: { customSize?: number; customCount?: number; duration?: number } = {}
): number {
  if (mode !== "custom") return CHUNK_MODE_SIZES[mode];
  if (opts.customCount && opts.customCount > 0 && opts.duration && opts.duration > 0) {
    return clampChunkSize(opts.duration / opts.customCount);
  }
  return clampChunkSize(opts.customSize ?? CHUNK_SIZE_S);
}

/**
 * Small overlap (seconds) appended to each chunk's window so an interaction or
 * scene change straddling a boundary is captured by both neighbours; the merge
 * + final balancer dedupe the duplicate.
 */
export const CHUNK_OVERLAP_S = 2;

/**
 * Max concurrent CV chunks for the WebCodecs worker pool. The hidden-`<video>`
 * fallback overrides this to 1 (a single shared decode path).
 */
export const CV_CHUNK_CONCURRENCY = 3;

/** Per-chunk retry budget before a chunk is left `failed`. */
export const CHUNK_MAX_ATTEMPTS = 3;

/**
 * No-progress watchdog for a chunk's CV pass. If the engine produces NO progress
 * within this window, the orchestrator aborts it + throws so the retry /
 * probe-fallback / mark-failed path runs — instead of hanging the whole analysis
 * forever on a video the on-device decoder can't handle (unsupported codec,
 * metadata that never loads, a silent WebCodecs worker). Generous enough that a
 * healthy chunk (≤60s of video, decoded in seconds by the worker, or streamed
 * frame-by-frame by the hidden-video engine) always finishes first.
 */
export const CHUNK_CV_NO_PROGRESS_MS = 60_000;

/** Debounce (ms) for per-chunk progress writes so we don't hammer Firestore. */
export const CHUNK_PROGRESS_WRITE_MS = 500;

/** Number of chunks for a given duration at a given chunk size. */
export function chunkCountFor(
  duration: number,
  chunkSize: number = CHUNK_SIZE_S
): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const size = chunkSize > 0 ? chunkSize : CHUNK_SIZE_S;
  return Math.max(1, Math.ceil(duration / size));
}

/**
 * Single source of truth for the analysis-path decision: any video longer than
 * the cutoff uses the progressive chunked path, regardless of how old the
 * project is. Callers MUST pass a RELIABLE duration (resolved from the video
 * element when the stored `project.duration` is missing/0) — a 0/NaN duration
 * routes to the direct flow.
 */
export function shouldUseChunkedAnalysis(durationSeconds: number): boolean {
  return (
    Number.isFinite(durationSeconds) &&
    durationSeconds > CHUNKED_ANALYSIS_THRESHOLD_S
  );
}

/** @deprecated use {@link shouldUseChunkedAnalysis} */
export function shouldChunk(duration: number): boolean {
  return shouldUseChunkedAnalysis(duration);
}

/** One chunk's absolute-time window. `primaryEnd` is the end of its OWNED span
 *  (excludes the overlap tail) — the single source of truth for ownership in
 *  both the orchestrator and the VA merge. */
export interface ChunkWindow {
  index: number;
  startTime: number;
  endTime: number;
  primaryEnd: number;
}

/** Build the ordered absolute-time chunk windows for a duration + chunk size. */
export function chunkWindows(
  duration: number,
  chunkSize: number = CHUNK_SIZE_S
): ChunkWindow[] {
  const size = chunkSize > 0 ? chunkSize : CHUNK_SIZE_S;
  const out: ChunkWindow[] = [];
  const n = chunkCountFor(duration, size);
  for (let i = 0; i < n; i++) {
    const startTime = i * size;
    // The owned (primary) span ends at the next stride boundary, clamped.
    const primaryEnd = Math.min(duration, startTime + size);
    // Last chunk runs to the exact duration; interior chunks add the overlap.
    const rawEnd = (i + 1) * size + (i < n - 1 ? CHUNK_OVERLAP_S : 0);
    out.push({ index: i, startTime, endTime: Math.min(duration, rawEnd), primaryEnd });
  }
  return out;
}
