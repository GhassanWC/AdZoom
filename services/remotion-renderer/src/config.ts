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
  /** The Cloud Run execution budget (== REMOTION_EXPORT_TIMEOUT_SECONDS, the
   *  per-execution timeout the dispatcher + Job are configured with). The
   *  in-process kill fires EARLIER (see `hardTimeoutSeconds`) so the worker always
   *  wins the race against the platform SIGKILL and can write `failed` + release
   *  minutes. */
  timeoutSeconds: number;
  /** In-process hard wall-clock kill = `timeoutSeconds - timeoutGraceSeconds`
   *  (floored). Strictly less than the platform timeout so the worker tears the
   *  render down + settles the job before Cloud Run kills the container. */
  hardTimeoutSeconds: number;
  /** Margin reserved below the platform timeout for the worker's graceful
   *  abort + failed-finalize + minute release. */
  timeoutGraceSeconds: number;
  /** Hard cap on the source metadata-read control-plane call so a hung GCS API
   *  can't wedge the job before the download even starts. */
  sourceResolveTimeoutSeconds: number;
  /** Hard cap on streaming the source object to local /tmp (served over the
   *  local HTTP server). A hung GCS read fails the job instead of hanging. */
  downloadTimeoutSeconds: number;
  /** Render-progress watchdog: if `renderMedia` produces NO progress within this
   *  window (e.g. the asset download stalls before the first frame), the worker
   *  aborts and fails `render_no_progress_timeout` rather than hanging. */
  noProgressTimeoutMs: number;
  /** Budget for the pre-render first-frame smoke test (renderStill frame 0). If
   *  frame 0 can't decode/render in time, fail fast as `video_decode_failed`. */
  smokeTestTimeoutMs: number;
  /** Chromium GL backend. "swiftshader" (software) is the reliable headless
   *  default on Cloud Run; override via REMOTION_GL if a GPU backend is wanted. */
  gl: string;
  /** Remotion log verbosity. Defaults to "info"; "verbose" only when
   *  REMOTION_DEBUG=1 (or an explicit REMOTION_LOG_LEVEL). */
  logLevel: string;
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
  const timeoutSeconds = intEnv("REMOTION_EXPORT_TIMEOUT_SECONDS", 1800);
  const timeoutGraceSeconds = intEnv("REMOTION_TIMEOUT_GRACE_SECONDS", 120);
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
    timeoutSeconds,
    timeoutGraceSeconds,
    // Fire the in-process kill at least 60s before the platform timeout (and never
    // below 60s total) so the worker can always settle the job first.
    hardTimeoutSeconds: Math.max(60, timeoutSeconds - timeoutGraceSeconds),
    sourceResolveTimeoutSeconds: intEnv("REMOTION_SOURCE_RESOLVE_TIMEOUT_SECONDS", 60),
    downloadTimeoutSeconds: intEnv("REMOTION_DOWNLOAD_TIMEOUT_SECONDS", 600),
    noProgressTimeoutMs: intEnv("REMOTION_NO_PROGRESS_TIMEOUT_MS", 120_000),
    smokeTestTimeoutMs: intEnv("REMOTION_SMOKE_TIMEOUT_MS", 60_000),
    gl: process.env.REMOTION_GL || "swiftshader",
    logLevel:
      process.env.REMOTION_LOG_LEVEL ||
      (process.env.REMOTION_DEBUG === "1" ? "verbose" : "info"),
    perFrameTimeoutMs: intEnv("REMOTION_FRAME_TIMEOUT_MS", 60_000),
    cancelPollMs: intEnv("REMOTION_CANCEL_POLL_MS", 3000),
    // Throttle Firestore progress writes to ~every 7s (5–10s band) so the UI
    // updates smoothly without hammering Firestore.
    progressThrottleMs: intEnv("REMOTION_PROGRESS_THROTTLE_MS", 7000),
    heartbeatMs: intEnv("REMOTION_HEARTBEAT_MS", 30_000),
  };
  return cached;
}
