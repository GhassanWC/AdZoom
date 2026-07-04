/**
 * HTTP entry for the export worker.
 *
 *   POST /        { uid, jobId }   — render a job (the Cloud Tasks / dev target)
 *   GET  /healthz                  — liveness
 *
 * Auth: production verifies the Cloud Tasks OIDC token; local dev
 * (`DEV_DISABLE_OIDC=1`) checks an optional shared secret instead.
 *
 * Execution model:
 *   • production — process SYNCHRONOUSLY and respond when done. Cloud Run keeps
 *     CPU allocated for the whole request, and Cloud Tasks waits for the 2xx;
 *     non-2xx triggers a retry. Handled (deterministic) failures still return
 *     200 — the job doc records the failure, so retrying would only fail again.
 *   • local dev — respond 202 immediately and render in the background, so the
 *     app's `/api/export/cloud` request returns the jobId without blocking.
 */
import os from "node:os";
import { readFileSync } from "node:fs";
import express, { type Request, type Response } from "express";
import { loadConfig, type WorkerConfig } from "./config.js";
import { verifyRequestAuth } from "./oidc.js";
import { processJob } from "./handler.js";
import { registerAndDiagnoseFonts } from "./fonts.js";

/** Best-effort container memory limit (MB) from cgroup v2/v1; "unknown" otherwise. */
function detectMemoryLimitMB(): number | "unknown" {
  for (const p of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const raw = readFileSync(p, "utf8").trim();
      if (raw === "max") continue; // cgroup v2 "no limit"
      const n = Number(raw);
      // Ignore the cgroup v1 "unlimited" sentinel (a ~9.2e18 value).
      if (Number.isFinite(n) && n > 0 && n < 1024 ** 4) return Math.round(n / 1048576);
    } catch {
      /* path not present on this platform */
    }
  }
  return "unknown";
}

/**
 * Log a single [worker:startup] block describing the effective runtime config,
 * then warn LOUDLY about production misconfig. Deliberately NON-blocking: a
 * crash-loop on a missing env var would take the whole worker down, whereas
 * running + failing individual jobs with clean errors is recoverable. The point
 * is to make a misconfigured revision obvious in the logs.
 */
function logStartup(cfg: WorkerConfig): void {
  // Load + verify multilingual fonts once, so a fontless image is obvious at boot.
  registerAndDiagnoseFonts();
  const availableCpus =
    typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;

  console.info("[worker:startup]", {
    // "version/commit": Cloud Run sets K_SERVICE/K_REVISION; WORKER_COMMIT is
    // an optional git SHA the deploy can inject.
    service: process.env.K_SERVICE ?? "(local)",
    revision: process.env.K_REVISION ?? "(local)",
    commit: process.env.WORKER_COMMIT ?? "(unset)",
    node: process.version,
    oidc: cfg.devDisableOidc ? "disabled(dev)" : "enabled",
    normalizeEnabled: cfg.normalizeEnabled,
    storageBucket: cfg.storageBucket ?? "(MISSING)",
    oidcAudience: cfg.oidcAudience ? "present" : "MISSING",
    invokerSA: cfg.invokerServiceAccount ? "present" : "MISSING",
    cpus: availableCpus,
    memoryLimitMB: detectMemoryLimitMB(),
    totalMemMB: Math.round(os.totalmem() / 1048576),
    port: cfg.port,
    x264: `${cfg.preset}/crf${cfg.crf}`,
    normalize: `${cfg.normalizePreset}/crf${cfg.normalizeCrf}`,
  });

  const warnings: string[] = [];
  // The most dangerous misconfig: dev mode on Cloud Run. It disables OIDC auth
  // AND (before the lifecycle fix) made the worker respond async + render in the
  // background, so Cloud Run recycled the instance mid-render (SIGTERM).
  if (cfg.devDisableOidc && process.env.K_SERVICE) {
    warnings.push(
      "DEV_DISABLE_OIDC is set on Cloud Run (K_SERVICE present) — this disables auth; unset it in production. (The worker now still renders synchronously here, but this combo is unsafe.)"
    );
  }
  if (!cfg.normalizeEnabled) {
    warnings.push(
      "WORKER_NORMALIZE_ENABLED is not 1 — risky sources (HEVC / unsupported audio like apac) will NOT be pre-normalized; they fall back to the render-time guard only."
    );
  }
  if (!cfg.storageBucket) {
    warnings.push(
      "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is missing — the worker cannot download sources or upload exports; every job will fail."
    );
  }
  // OIDC vars only matter in production (dev disables OIDC on purpose).
  if (!cfg.devDisableOidc) {
    if (!cfg.oidcAudience) {
      warnings.push(
        "WORKER_OIDC_AUDIENCE is missing — production OIDC verification can't validate the token audience; authenticated requests will be rejected."
      );
    }
    if (!cfg.invokerServiceAccount) {
      warnings.push(
        "EXPORT_INVOKER_SA is missing — the OIDC token's email claim won't be checked (weaker auth)."
      );
    }
  }

  if (warnings.length) {
    console.warn(`[worker:startup] ⚠ ${warnings.length} CONFIG WARNING(S) — this revision may be misconfigured:`);
    for (const w of warnings) console.warn(`  ⚠ ${w}`);
  } else {
    console.info("[worker:startup] config looks OK");
  }
}

/**
 * Process-level visibility. A render that dies mid-flight (OOM SIGKILL, a
 * Cloud Run instance recycle via SIGTERM, or an unhandled error) leaves no clue
 * in the job doc — these logs are how we tell WHY a job stopped. The job itself
 * recovers via the heartbeat lease (a stale job is re-claimable by a Cloud Tasks
 * retry) and the reconciler (fails + releases minutes after the stale window).
 *
 * Note: an OOM kill is SIGKILL — uncatchable, so it won't log here; the
 * per-render memory logs (see render.ts) are how we catch a climb toward OOM.
 */
function installProcessGuards(): void {
  process.on("uncaughtException", (err) => {
    console.error("[worker:fatal] uncaughtException", err);
    // Undefined state — exit so Cloud Run restarts; the in-flight request 503s
    // and a Cloud Tasks retry re-claims the job once its heartbeat goes stale.
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[worker:fatal] unhandledRejection", reason);
  });
  process.on("SIGTERM", () => {
    // Cloud Run sends SIGTERM ~10s before SIGKILL when recycling an instance.
    console.warn(
      "[worker:signal] SIGTERM — instance shutting down; any in-flight job will be re-claimed after its heartbeat goes stale"
    );
  });
  process.on("exit", (code) => {
    console.warn("[worker:exit] process exiting", { code });
  });
}

export function start(): void {
  installProcessGuards();
  const cfg = loadConfig();
  logStartup(cfg);
  const app = express();
  app.use(express.json({ limit: "16mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).send("ok");
  });

  app.post("/", async (req: Request, res: Response) => {
    const authed = await verifyRequestAuth(req, cfg);
    if (!authed.ok) {
      console.warn("[worker] auth rejected:", authed.reason);
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const { uid, jobId } = (req.body ?? {}) as { uid?: string; jobId?: string };
    if (!uid || !jobId) {
      res.status(400).json({ error: "body must include { uid, jobId }" });
      return;
    }

    console.info("[worker:request-start]", { uid, jobId });
    const startedMs = Date.now();

    // Fire-and-forget is for LOCAL DEV ONLY. On Cloud Run (K_SERVICE is always
    // set) we MUST hold the request open for the whole render — otherwise Cloud
    // Run sees the request finish and recycles the idle instance (SIGTERM →
    // SIGKILL), killing the in-flight render. So async is gated on NOT being on
    // Cloud Run, regardless of the OIDC flag.
    const respondAsync = cfg.devDisableOidc && !process.env.K_SERVICE;
    if (respondAsync) {
      res.status(202).json({ accepted: true, jobId });
      console.info("[worker:request-end]", {
        uid,
        jobId,
        outcome: "accepted(async-dev)",
        status: 202,
        durationMs: Date.now() - startedMs,
      });
      processJob(uid, jobId).catch((err) =>
        console.error("[worker] background processJob threw", err)
      );
      return;
    }

    // Cloud Run / production: await the FULL render, then report the outcome.
    // The response is sent AFTER processJob returns (i.e. after
    // [worker:complete]) — if [worker:request-end] ever logs before
    // [worker:complete], the async path is wrongly active.
    try {
      const outcome = await processJob(uid, jobId);
      // `leased` = held by ANOTHER live worker (fresh heartbeat) → retryable so
      // Cloud Tasks keeps the task and tries later (the holder finishes →
      // terminal → 200, or crashes → next attempt re-claims). Everything else is
      // terminal/no-op → 200 (a deterministic `failed` must NOT be retried — it
      // would just re-fail; transient faults crash/500 and ARE retried).
      const status = outcome === "leased" ? 409 : 200;
      console.info("[worker:request-end]", {
        uid,
        jobId,
        outcome,
        status,
        durationMs: Date.now() - startedMs,
      });
      res.status(status).json({ outcome });
    } catch (err) {
      // Unexpected/transient error — 500 so Cloud Tasks retries.
      console.error("[worker] processJob threw", err);
      console.info("[worker:request-end]", {
        uid,
        jobId,
        outcome: "error",
        status: 500,
        durationMs: Date.now() - startedMs,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.listen(cfg.port, () => {
    console.info(
      `[worker] listening on :${cfg.port} (oidc=${cfg.devDisableOidc ? "disabled(dev)" : "enabled"})`
    );
  });
}

start();
