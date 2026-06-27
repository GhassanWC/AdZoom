/**
 * Chunked-export ELIGIBILITY + chunk math — the single decision point for whether
 * a cloud export renders as the proven single-worker job ("single") or as N
 * parallel chunk tasks inside one Batch job ("chunked"), and with what shape.
 *
 * Pure + dependency-free on purpose: no `@/` RUNTIME imports, no `server-only`, so
 * it unit-tests cleanly under `node --test` (type-only imports are stripped). The
 * caller (create-job.ts) passes a plain timeline summary + primitives; this module
 * owns the gates + arithmetic so the app NEVER asks the worker for something it
 * will reject.
 *
 * Chunking is gated OFF by default (ship dark): it engages only when
 * EXPORT_CHUNKED_RENDER is "1"/"true". EXPORT_CHUNKED_RENDER=0 (or unset) is the
 * emergency kill switch → every export uses the single path. (Distinct from
 * EXPORT_RENDER_MODE, which selects the RUNTIME path per Batch task.)
 *
 * Timeline-aware: chunks are sliced by OUTPUT time (post cuts/speed) and the
 * render core maps each output frame back to source time via the recipe's
 * timeline map, so cuts + speed are chunkable. Only effect TYPES not in
 * {@link SUPPORTED_CHUNK_EFFECT_TYPES} force a single render (fail-closed).
 */
import type { DetectedMoment } from "@/lib/firebase/schema";

export type RenderMode = "single" | "chunked";

/**
 * Moment effect types the chunked renderer can reproduce deterministically per
 * OUTPUT frame (each is a pure function of source-time inside composeFrame, and
 * cuts/speed are handled by the recipe timeline map). Any effect type NOT in this
 * allowlist forces a single render — fail-closed, so a FUTURE stateful effect
 * (e.g. a transition that reads neighbor frames, or look-ahead motion blur) must
 * be explicitly vetted + added here before it can be chunked. Mirrored as a
 * backstop in the worker (services/export-worker/src/render.ts) so the app gate
 * and the CLI can never diverge.
 */
export const SUPPORTED_CHUNK_EFFECT_TYPES = [
  "zoom",
  "click-highlight",
  "cursor-focus",
  "speed-up",
  "cut",
  "crop",
] as const;

/** Timeline classification used for the chunk gate + diagnostics. */
export interface ChunkTimelineSummary {
  /** Any ACTIVE cut removes output time (restored cuts don't count). */
  hasCuts: boolean;
  /** Any speed-up moment (type based — multiplier-agnostic, so audioMode is kept). */
  hasSpeed: boolean;
  /** Background music present (no schema yet → always false; wired when it lands). */
  hasMusic: boolean;
  /** Any moment carries a camera keyframe path (animated zoom/pan). */
  hasAnimations: boolean;
  /** Distinct moment effect types NOT in the allowlist. Non-empty → single render. */
  unsupportedEffects: string[];
}

export interface ChunkPlan {
  renderMode: RenderMode;
  /** TOTAL number of output chunks (NOT the Batch task count). Each shard worker
   *  renders a contiguous range of chunks. >=2 when chunked; 1 when single. */
  chunkCount: number;
  /** Output seconds per chunk; the worker derives windows via chunk-window.ts. */
  chunkSeconds: number;
  /** Number of Batch tasks (shard workers) = taskCount = parallelism. Each worker
   *  renders a CONTIGUOUS range of chunks (ceil(chunkCount/workerCount) each).
   *  1 when single. This is what EXPORT_CHUNK_MAX_PARALLEL_* caps (WORKER count,
   *  not chunk count). */
  workerCount: number;
  /** Why single was chosen (diagnostics/logs only); "eligible" when chunked. */
  reason: string;
}

export interface ChunkPlanInput {
  /** OUTPUT duration in seconds (post cuts/speed). */
  outputDurationSeconds: number;
  /** Export container; only "mp4" is chunk-eligible. */
  format: string;
  /** Plan tier — only pro/creator reach cloud export; sets the parallelism cap. */
  plan: "free" | "pro" | "creator";
  /** Timeline classification — gates on `unsupportedEffects` (fail-closed). */
  timeline: ChunkTimelineSummary;
  /** process.env (or a test override). */
  env?: Record<string, string | undefined>;
}

function intEnv(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const n = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Classify a timeline for chunking from its moments. Cuts + speed are chunkable
 * (handled by the timeline map), so they only set diagnostic flags — they do NOT
 * land in `unsupportedEffects`. Only an effect type outside the allowlist does.
 */
export function summarizeTimelineForChunking(
  moments:
    | ReadonlyArray<Pick<DetectedMoment, "effectType" | "cut" | "keyframes">>
    | null
    | undefined
): ChunkTimelineSummary {
  const list = moments ?? [];
  const supported = new Set<string>(SUPPORTED_CHUNK_EFFECT_TYPES);
  let hasCuts = false;
  let hasSpeed = false;
  let hasAnimations = false;
  const unsupported = new Set<string>();
  for (const m of list) {
    const t = m.effectType as string;
    if (t === "speed-up") hasSpeed = true;
    // Restored cuts (active:false) don't remove time; the `cut` TYPE is supported
    // either way (it never lands in unsupportedEffects).
    if (t === "cut" && m.cut?.active !== false) hasCuts = true;
    if (m.keyframes && m.keyframes.length > 0) hasAnimations = true;
    if (!supported.has(t)) unsupported.add(t);
  }
  return {
    hasCuts,
    hasSpeed,
    hasMusic: false, // no music schema yet — set here when audio tracks land
    hasAnimations,
    unsupportedEffects: [...unsupported].sort(),
  };
}

/** EXPORT_CHUNKED_RENDER is the kill switch: chunking is OFF unless explicitly "1"/"true". */
export function chunkingEnabled(env: Record<string, string | undefined>): boolean {
  const v = (env.EXPORT_CHUNKED_RENDER ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function single(reason: string): ChunkPlan {
  return { renderMode: "single", chunkCount: 1, chunkSeconds: 0, workerCount: 1, reason };
}

/**
 * Decide single vs chunked and compute the chunk shape. Chunked requires ALL of:
 * kill switch ON, MP4, a paid plan, NO unsupported effect types, output >=
 * EXPORT_CHUNK_MIN_VIDEO_SECONDS, and >= 2 chunks. Cuts + speed are chunkable
 * (the render core maps output→source time). Otherwise returns the proven single
 * path with a `reason`.
 */
export function planChunking(input: ChunkPlanInput): ChunkPlan {
  const env = input.env ?? {};
  if (!chunkingEnabled(env)) return single("kill_switch_off");
  if (input.format !== "mp4") return single("not_mp4");
  if (input.plan !== "pro" && input.plan !== "creator") return single("plan_no_cloud");
  // Fail-closed: any effect type the chunk renderer can't reproduce → single.
  if (input.timeline.unsupportedEffects.length > 0) return single("unsupported_effects");
  const dur = input.outputDurationSeconds;
  if (!(Number.isFinite(dur) && dur > 0)) return single("invalid_duration");

  const minVideo = intEnv(env, "EXPORT_CHUNK_MIN_VIDEO_SECONDS", 360);
  if (dur < minVideo) return single("too_short");

  const maxTotal = Math.max(2, intEnv(env, "EXPORT_CHUNK_MAX_TOTAL_CHUNKS", 80));
  const targetSeconds = Math.max(1, intEnv(env, "EXPORT_CHUNK_SECONDS", 15));

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

  // workerCount = number of SHARD WORKERS (Batch tasks). Each worker renders a
  // contiguous range of small chunks, so we cap the TASK count (not the chunk
  // count) to avoid one-container-per-chunk overhead. EXPORT_CHUNK_MAX_PARALLEL_*
  // is the per-plan WORKER cap (pro 6, creator 8). The Batch submitter further
  // reduces this if workers × bootDiskGb would bust the SSD_TOTAL_GB quota.
  const maxWorkers =
    input.plan === "creator"
      ? Math.max(1, intEnv(env, "EXPORT_CHUNK_MAX_PARALLEL_CREATOR", 8))
      : Math.max(1, intEnv(env, "EXPORT_CHUNK_MAX_PARALLEL_PRO", 6));
  const workerCount = Math.max(1, Math.min(maxWorkers, chunkCount));

  return { renderMode: "chunked", chunkCount, chunkSeconds, workerCount, reason: "eligible" };
}

/**
 * The structured eligibility log — one flat object covering the decision + every
 * input flag, so logs explain WHY a job chunked or fell back. Emitted by
 * create-job.ts at decision time.
 */
export function chunkEligibilityLog(
  input: ChunkPlanInput,
  plan: ChunkPlan,
  extra: { sourceDurationSeconds?: number } = {}
): Record<string, unknown> {
  return {
    renderMode: plan.renderMode,
    reason: plan.reason,
    outputDurationSeconds: input.outputDurationSeconds,
    sourceDurationSeconds: extra.sourceDurationSeconds ?? null,
    hasCuts: input.timeline.hasCuts,
    hasSpeed: input.timeline.hasSpeed,
    hasMusic: input.timeline.hasMusic,
    hasAnimations: input.timeline.hasAnimations,
    unsupportedEffects: input.timeline.unsupportedEffects,
    chunkCount: plan.chunkCount,
    workerCount: plan.workerCount,
    chunkSeconds: plan.chunkSeconds,
  };
}
