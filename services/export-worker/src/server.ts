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
import express, { type Request, type Response } from "express";
import { loadConfig } from "./config.js";
import { verifyRequestAuth } from "./oidc.js";
import { processJob } from "./handler.js";

export function start(): void {
  const cfg = loadConfig();
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

    if (cfg.devDisableOidc) {
      // Local dev: ack immediately, render in the background.
      res.status(202).json({ accepted: true, jobId });
      processJob(uid, jobId).catch((err) =>
        console.error("[worker] background processJob threw", err)
      );
      return;
    }

    // Production: render synchronously, then report the outcome.
    try {
      const outcome = await processJob(uid, jobId);
      res.status(200).json({ outcome });
    } catch (err) {
      // Unexpected/transient error — 500 so Cloud Tasks retries.
      console.error("[worker] processJob threw", err);
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
