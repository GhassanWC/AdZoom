/**
 * Chunked-export ELIGIBILITY + chunk math — the single decision point for whether
 * a cloud export renders as the proven single-worker job ("single") or as N
 * parallel chunk tasks inside one Batch job ("chunked"), and with what shape.
 *
 * Pure + dependency-free on purpose: no `@/` runtime imports, no `server-only`, so
 * it unit-tests cleanly under `node --test` (type-only imports are stripped). The
 * caller (create-job.ts) passes plain primitives; this module owns the gates +
 * arithmetic so the app NEVER asks the worker for something it will reject.
 *
 * Chunking is gated OFF by default (ship dark): it engages only when
 * EXPORT_CHUNKED_RENDER is "1"/"true". EXPORT_CHUNKED_RENDER=0 (or unset) is the
 * emergency kill switch → every export uses the single path.
 */

export type RenderMode = "single" | "chunked";

export interface ChunkPlan {
  renderMode: RenderMode;
  /** Number of parallel chunk tasks (>=2 when chunked; 1 when single). */
  chunkCount: number;
  /** Output seconds per chunk; the worker derives window [i*chunkSeconds, …]. */
  chunkSeconds: number;
  /** Max chunks rendering at once (plan-capped); 1 when single. */
  chunkParallelism: number;
  /** Why single was chosen (diagnostics/logs only). */
  reason: string;
}

export interface ChunkPlanInput {
  /** OUTPUT duration in seconds (post cuts/speed). For linear timelines == source. */
  outputDurationSeconds: number;
  /** Export container; only "mp4" is chunk-eligible. */
  format: string;
  /** True iff the timeline is LINEAR: no active cuts AND no speed sections. The
   *  render CLI hard-refuses cuts/speed (chunk_unsupported_timeline), so this
   *  MUST mirror that condition (totalRemoved===0 && every segment speed===1). */
  linear: boolean;
  /** Plan tier — only pro/creator reach cloud export; sets the parallelism cap. */
  plan: "free" | "pro" | "creator";
  /** process.env (or a test override). */
  env?: Record<string, string | undefined>;
}

function intEnv(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const n = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** EXPORT_CHUNKED_RENDER is the kill switch: chunking is OFF unless explicitly "1"/"true". */
export function chunkingEnabled(env: Record<string, string | undefined>): boolean {
  const v = (env.EXPORT_CHUNKED_RENDER ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function single(reason: string): ChunkPlan {
  return { renderMode: "single", chunkCount: 1, chunkSeconds: 0, chunkParallelism: 1, reason };
}

/**
 * Decide single vs chunked and compute the chunk shape. Chunked requires ALL of:
 * kill switch ON, MP4, output >= EXPORT_CHUNK_MIN_VIDEO_SECONDS, a LINEAR timeline,
 * and a paid plan. Otherwise returns the proven single path with a `reason`.
 */
export function planChunking(input: ChunkPlanInput): ChunkPlan {
  const env = input.env ?? {};
  if (!chunkingEnabled(env)) return single("kill_switch_off");
  if (input.format !== "mp4") return single("not_mp4");
  if (input.plan !== "pro" && input.plan !== "creator") return single("plan_no_cloud");
  if (!input.linear) return single("nonlinear_timeline"); // cuts/speed → CLI can't chunk
  const dur = input.outputDurationSeconds;
  if (!(Number.isFinite(dur) && dur > 0)) return single("invalid_duration");

  const minVideo = intEnv(env, "EXPORT_CHUNK_MIN_VIDEO_SECONDS", 360);
  if (dur < minVideo) return single("too_short");

  const maxTotal = Math.max(2, intEnv(env, "EXPORT_CHUNK_MAX_TOTAL_CHUNKS", 30));
  const targetSeconds = Math.max(1, intEnv(env, "EXPORT_CHUNK_SECONDS", 120));

  // Pick chunkSeconds so the chunk COUNT never exceeds maxTotal, then derive the
  // ACTUAL count from the (possibly grown) chunkSeconds so the worker's window
  // math (count = ceil(dur/chunkSeconds)) produces no empty trailing chunk.
  let chunkSeconds = targetSeconds;
  let chunkCount = Math.ceil(dur / chunkSeconds);
  if (chunkCount > maxTotal) {
    chunkSeconds = Math.ceil(dur / maxTotal);
    chunkCount = Math.ceil(dur / chunkSeconds); // <= maxTotal by construction
  }
  if (chunkCount < 2) return single("not_enough_chunks");

  const maxParallel =
    input.plan === "creator"
      ? Math.max(1, intEnv(env, "EXPORT_CHUNK_MAX_PARALLEL_CREATOR", 4))
      : Math.max(1, intEnv(env, "EXPORT_CHUNK_MAX_PARALLEL_PRO", 2));
  const chunkParallelism = Math.max(1, Math.min(maxParallel, chunkCount));

  return { renderMode: "chunked", chunkCount, chunkSeconds, chunkParallelism, reason: "eligible" };
}
