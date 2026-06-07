/**
 * Tunables for the progressive chunked analysis engine.
 *
 * Short videos (≤ threshold) keep the existing direct `startAnalyze` path
 * unchanged; longer videos route to the chunk orchestrator so edits stream in
 * progressively instead of after the whole video finishes.
 */

/** Videos with duration ≤ this (seconds) use the existing direct flow. */
export const CHUNKED_ANALYSIS_THRESHOLD_S = 90;

/** Target chunk length (seconds). */
export const CHUNK_SIZE_S = 30;

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

/** Debounce (ms) for per-chunk progress writes so we don't hammer Firestore. */
export const CHUNK_PROGRESS_WRITE_MS = 500;

/** Number of chunks for a given duration. */
export function chunkCountFor(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(1, Math.ceil(duration / CHUNK_SIZE_S));
}

/** Should this duration use the progressive chunked path? */
export function shouldChunk(duration: number): boolean {
  return Number.isFinite(duration) && duration > CHUNKED_ANALYSIS_THRESHOLD_S;
}

/** Build the ordered absolute-time chunk windows for a duration. */
export function chunkWindows(
  duration: number
): Array<{ index: number; startTime: number; endTime: number }> {
  const out: Array<{ index: number; startTime: number; endTime: number }> = [];
  const n = chunkCountFor(duration);
  for (let i = 0; i < n; i++) {
    const startTime = i * CHUNK_SIZE_S;
    // Last chunk runs to the exact duration; interior chunks add the overlap.
    const rawEnd = (i + 1) * CHUNK_SIZE_S + (i < n - 1 ? CHUNK_OVERLAP_S : 0);
    out.push({ index: i, startTime, endTime: Math.min(duration, rawEnd) });
  }
  return out;
}
