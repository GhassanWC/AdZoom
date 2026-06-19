/** Worker configuration, read once from the environment. */
export interface WorkerConfig {
  /** GCP project id (for Admin SDK + Storage bucket resolution). */
  projectId: string | undefined;
  /** Firebase Storage bucket (e.g. "my-app.appspot.com"). */
  storageBucket: string | undefined;
  /** HTTP port Cloud Run / the dev server listens on. */
  port: number;
  /**
   * Expected OIDC audience — must equal the worker's own public URL, the value
   * the Cloud Tasks enqueuer set as the token audience. Required in production.
   */
  oidcAudience: string | undefined;
  /**
   * Service account email Cloud Tasks signs the OIDC token with. When set, the
   * worker additionally checks the verified token's `email` claim matches.
   */
  invokerServiceAccount: string | undefined;
  /** When "1", skip OIDC verification (local dev only). */
  devDisableOidc: boolean;
  /** Optional shared secret the dev dispatcher sends as `x-export-dev-secret`. */
  devSecret: string | undefined;
  /**
   * How often (in output frames) the worker re-reads the job's `cancelRequested`
   * flag and flushes a progress update. 30 ≈ once/sec at 30fps.
   */
  pollEveryFrames: number;
  /** x264 CRF (lower = higher quality / bigger file). */
  crf: number;
  /** x264 preset. */
  preset: string;
  /**
   * When true, the worker PREFLIGHTS the source and, for "risky" inputs (non-
   * H.264 video or non-AAC/undecodable audio), transcodes it to a worker-safe
   * H.264+AAC MP4 BEFORE rendering — caching the result per project. Default
   * off so the feature ships dark (flip via `WORKER_NORMALIZE_ENABLED=1`).
   */
  normalizeEnabled: boolean;
  /** x264 CRF used for the normalization pass (slightly higher quality than the
   *  render CRF to limit double-compression loss). */
  normalizeCrf: number;
  /** x264 preset for the normalization pass. */
  normalizePreset: string;
}

export function loadConfig(): WorkerConfig {
  return {
    projectId:
      process.env.GCLOUD_PROJECT ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    port: Number(process.env.PORT ?? 8787),
    oidcAudience: process.env.WORKER_OIDC_AUDIENCE,
    invokerServiceAccount: process.env.EXPORT_INVOKER_SA,
    devDisableOidc: process.env.DEV_DISABLE_OIDC === "1",
    devSecret: process.env.EXPORT_WORKER_DEV_SECRET,
    pollEveryFrames: Number(process.env.WORKER_POLL_EVERY_FRAMES ?? 30),
    crf: Number(process.env.WORKER_X264_CRF ?? 19),
    preset: process.env.WORKER_X264_PRESET ?? "veryfast",
    normalizeEnabled: process.env.WORKER_NORMALIZE_ENABLED === "1",
    normalizeCrf: Number(process.env.WORKER_NORMALIZE_CRF ?? 18),
    normalizePreset: process.env.WORKER_NORMALIZE_PRESET ?? "veryfast",
  };
}
