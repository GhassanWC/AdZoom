/** Runtime config for the Remotion renderer Cloud Run Job. Read from env once. */
export interface RendererConfig {
  projectId?: string;
  storageBucket?: string;
  /** x264 quality (lower = better/larger). */
  crf: number;
  /** x264 speed/size preset. */
  x264Preset: string;
  /** renderMedia concurrency; null = auto (half the CPU threads). */
  concurrency: number | null;
  /** Hard wall-clock budget for the whole render before the worker kills it. */
  timeoutSeconds: number;
  /** Per-frame renderMedia timeout (a single stuck frame). */
  perFrameTimeoutMs: number;
  /** How often the worker polls Firestore for cancelRequested. */
  cancelPollMs: number;
  /** Min interval between progress writes to Firestore. */
  progressThrottleMs: number;
  /** Liveness heartbeat cadence (bumps updatedAt/heartbeatAt). */
  heartbeatMs: number;
}

let cached: RendererConfig | undefined;

function intEnv(key: string, fallback: number): number {
  const n = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): RendererConfig {
  if (cached) return cached;
  const concurrencyRaw = Number.parseInt(process.env.REMOTION_CONCURRENCY ?? "", 10);
  cached = {
    projectId:
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
      process.env.FIREBASE_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT,
    storageBucket:
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET,
    crf: intEnv("REMOTION_CRF", 18),
    x264Preset: process.env.REMOTION_X264_PRESET || "medium",
    concurrency: Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? concurrencyRaw : null,
    timeoutSeconds: intEnv("REMOTION_EXPORT_TIMEOUT_SECONDS", 1800),
    perFrameTimeoutMs: intEnv("REMOTION_FRAME_TIMEOUT_MS", 60_000),
    cancelPollMs: intEnv("REMOTION_CANCEL_POLL_MS", 3000),
    progressThrottleMs: intEnv("REMOTION_PROGRESS_THROTTLE_MS", 2000),
    heartbeatMs: intEnv("REMOTION_HEARTBEAT_MS", 30_000),
  };
  return cached;
}
