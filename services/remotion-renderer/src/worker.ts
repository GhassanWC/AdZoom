/**
 * Render ONE export job with Remotion, end to end. Mirrors the proven lifecycle of
 * services/export-worker/src/handler.ts (claim → heartbeat/cancel-poll → settle),
 * but the render is a single `@remotion/renderer` renderMedia() call — no chunking,
 * no merge leader, no custom audiomux. Writes the SAME exportJobs doc schema the
 * existing UI + reconciler understand (queued → rendering → uploading → ready /
 * failed / canceled).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { makeCancelSignal } from "@remotion/renderer";
import { getAdmin, bucket } from "./firebase.js";
import { loadConfig } from "./config.js";
import { getServeUrl } from "./bundle.js";
import { resolveSource } from "./source.js";
import { renderExport } from "./render.js";
import { makeThrottle } from "./progress.js";
import { toUserFacingError } from "./errors.js";
import type { ExportJobDoc } from "@/lib/firebase/schema";
import type { FramevoAudioMode, FramevoCompositionProps } from "@/remotion/types";

const WORKER_ID = process.env.EXPORT_WORKER_ID || hostname() || "remotion-renderer";
const BUILD_VERSION = process.env.BUILD_VERSION ?? "unknown";
const RENDERER_VERSION = "2026.06-remotion";
/** A claimed job whose heartbeat is older than this is abandoned → re-claimable. */
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

type ClaimResult =
  | { action: "missing" | "terminal" | "leased" }
  | { action: "claimed"; job: ExportJobDoc };

function toMs(v: unknown): number {
  return (v as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
}

function log(msg: string, extra?: Record<string, unknown>): void {
  console.info(`[remotion-worker] ${msg}`, extra ?? {});
}

async function claimJob(db: Firestore, uid: string, jobId: string): Promise<ClaimResult> {
  const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) return { action: "missing" };
    const job = snap.data() as ExportJobDoc;
    if (job.status === "ready" || job.status === "failed" || job.status === "canceled") {
      return { action: "terminal" };
    }
    const inFlight = job.status === "rendering" || job.status === "uploading";
    if (inFlight && Date.now() - toMs(job.updatedAt) < HEARTBEAT_STALE_MS) {
      return { action: "leased" };
    }
    if (inFlight) {
      console.warn("[remotion-worker] re-claiming abandoned job (stale heartbeat)", {
        uid,
        jobId,
        status: job.status,
      });
    }
    tx.update(jobRef, {
      status: "rendering",
      stage: "downloading",
      progressStage: "preparing",
      progress: 0,
      workerId: WORKER_ID,
      buildVersion: BUILD_VERSION,
      remotionRendererVersion: RENDERER_VERSION,
      startedAt: FieldValue.serverTimestamp(),
      claimedAt: FieldValue.serverTimestamp(),
      lastHeartbeatAt: Date.now(),
      heartbeatAt: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { action: "claimed", job };
  });
}

export async function processRemotionJob(uid: string, jobId: string): Promise<string> {
  const cfg = loadConfig();
  const { db, bucketName } = getAdmin();
  const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);

  const claim = await claimJob(db, uid, jobId);
  if (claim.action !== "claimed") {
    log("skip", { uid, jobId, reason: claim.action });
    return claim.action;
  }
  log("job created/claimed", { uid, jobId, build: BUILD_VERSION });
  const job = claim.job;
  const estimate = job.estimatedExportMinutes ?? 0;
  const monthKey = job.monthlyBucket;

  const { cancelSignal, cancel } = makeCancelSignal();
  let wasCanceled = false;
  let timedOut = false;

  const patch = (data: Record<string, unknown>) =>
    jobRef.set(
      { ...data, lastHeartbeatAt: Date.now(), heartbeatAt: Date.now(), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

  // Cancel poll — the cancel route is authoritative (it sets canceled + releases
  // minutes). This just watches the flag and aborts the render.
  let polling = false;
  const cancelPoll = setInterval(() => {
    if (polling) return;
    polling = true;
    void jobRef
      .get()
      .then((snap) => {
        const st = snap.exists ? (snap.get("status") as string | undefined) : undefined;
        if (!snap.exists || snap.get("cancelRequested") === true || st === "canceled" || st === "failed") {
          wasCanceled = true;
          cancel();
          clearInterval(cancelPoll);
        }
      })
      .catch(() => {})
      .finally(() => {
        polling = false;
      });
  }, cfg.cancelPollMs);

  // Liveness heartbeat — bump updatedAt/heartbeatAt so neither the 10-min reconciler
  // nor the 12-min UI stale check fires during a long-but-healthy render.
  const heartbeat = setInterval(() => {
    void patch({}).catch(() => {});
  }, cfg.heartbeatMs);

  // Hard wall-clock timeout — kill the render so a wedged job can't run forever.
  const hardTimeout = setTimeout(() => {
    timedOut = true;
    console.error("[remotion-worker] HARD TIMEOUT — canceling render", {
      uid,
      jobId,
      timeoutSeconds: cfg.timeoutSeconds,
    });
    cancel();
  }, cfg.timeoutSeconds * 1000);

  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), `framevo-remotion-${jobId}-`));
    const outPath = join(workDir, `${jobId}.mp4`);

    // ── Source ──────────────────────────────────────────────────────────────
    await patch({ stage: "downloading", progress: 0.02, progressStage: "preparing" });
    const source = await resolveSource(job, workDir, (cfg.timeoutSeconds + 600) * 1000);
    log("props loaded / source readable", { uid, jobId, bytes: source.bytes, mode: source.localPath ? "download" : "signed" });

    const audioMode: FramevoAudioMode =
      ((job as { audioMode?: FramevoAudioMode }).audioMode ?? "source");
    const inputProps: FramevoCompositionProps = {
      recipe: job.renderRecipe,
      src: source.src,
      audioMode,
    };

    // ── Bundle ──────────────────────────────────────────────────────────────
    await patch({ stage: "decoding", progress: 0.04, progressStage: "rendering" });
    const serveUrl = await getServeUrl();
    log("composition bundle ready", { uid, jobId });

    // ── Render (single MP4; native audio mux) ────────────────────────────────
    const gate = makeThrottle(cfg.progressThrottleMs);
    log("render started", { uid, jobId });
    const result = await renderExport({
      serveUrl,
      inputProps,
      outputLocation: outPath,
      crf: cfg.crf,
      x264Preset: cfg.x264Preset,
      concurrency: cfg.concurrency,
      perFrameTimeoutMs: cfg.perFrameTimeoutMs,
      cancelSignal,
      onProgress: ({ progress, stitchStage }) => {
        gate(() =>
          void patch({
            stage: stitchStage === "muxing" ? "encoding" : "rendering",
            progressStage: "rendering",
            progress: Math.min(0.97, Math.max(0.04, progress)),
          }).catch(() => {})
        );
      },
    });
    log("render completed", { uid, jobId, frames: result.durationInFrames });

    if (!existsSync(outPath) || statSync(outPath).size <= 0) {
      throw new Error("render produced no output file");
    }

    // ── Upload + Firebase download URL ───────────────────────────────────────
    await patch({ stage: "uploading", progress: 0.98, progressStage: "uploading" });
    log("upload started", { uid, jobId, dest: job.outputPath });
    const token = randomUUID();
    try {
      await bucket().upload(outPath, {
        destination: job.outputPath,
        metadata: { contentType: "video/mp4", metadata: { firebaseStorageDownloadTokens: token } },
      });
    } catch (err) {
      throw new Error(`upload_failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(job.outputPath)}?alt=media&token=${token}`;
    log("upload completed", { uid, jobId });

    // ── Settle minutes + mark ready (atomic, guarded against a late cancel) ───
    const finalized = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return false;
      const st = snap.get("status") as string | undefined;
      if (st === "canceled" || st === "failed" || st === "ready") return false;
      const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
      const usageSnap = await tx.get(usageRef);
      const u = (usageSnap.data() as { cloudMinutesReserved?: number; cloudMinutesConsumed?: number } | undefined) ?? {};
      tx.set(
        usageRef,
        {
          cloudMinutesReserved: Math.max(0, (u.cloudMinutesReserved ?? 0) - estimate),
          cloudMinutesConsumed: Math.max(0, u.cloudMinutesConsumed ?? 0) + estimate,
          lastCloudExportAt: Date.now(),
          updatedAt: Date.now(),
        },
        { merge: true }
      );
      tx.set(
        jobRef,
        {
          status: "ready",
          stage: "uploading",
          progressStage: "ready",
          progress: 1,
          downloadUrl,
          consumedExportMinutes: estimate,
          remotionRendererVersion: RENDERER_VERSION,
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return true;
    });

    if (!finalized) {
      log("canceled/already-final during upload — skipping ready", { uid, jobId });
      return "canceled";
    }

    await db
      .doc(`users/${uid}/projects/${job.projectId}`)
      .set({ exportUrl: downloadUrl, updatedAt: Date.now() }, { merge: true })
      .catch(() => {});

    log("Firestore settled success", { uid, jobId, minutes: estimate });
    return "ready";
  } catch (err) {
    if (wasCanceled) {
      // The cancel route already released minutes + set status=canceled.
      log("canceled", { uid, jobId });
      return "canceled";
    }
    const raw = err instanceof Error ? err.message : "Render failed.";
    const friendly = timedOut
      ? { code: "render_timeout", message: "The export took too long and was stopped. Please try again." }
      : toUserFacingError(err);
    await db
      .runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        if (!snap.exists) return;
        const st = snap.get("status") as string | undefined;
        if (st === "ready" || st === "failed" || st === "canceled") return;
        if (estimate > 0 && monthKey) {
          const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
          const uSnap = await tx.get(usageRef);
          const reserved = (uSnap.data() as { cloudMinutesReserved?: number } | undefined)?.cloudMinutesReserved ?? 0;
          tx.set(usageRef, { cloudMinutesReserved: Math.max(0, reserved - estimate), updatedAt: Date.now() }, { merge: true });
        }
        tx.set(
          jobRef,
          {
            status: "failed",
            errorCode: friendly.code,
            errorMessage: friendly.message,
            workerId: WORKER_ID,
            buildVersion: BUILD_VERSION,
            remotionRendererVersion: RENDERER_VERSION,
            failedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      })
      .catch((e) => console.error("[remotion-worker] failed-finalize txn error", { uid, jobId, e }));
    log("Firestore settled failure", { uid, jobId, errorCode: friendly.code, error: raw, timedOut });
    return "failed";
  } finally {
    clearInterval(cancelPoll);
    clearInterval(heartbeat);
    clearTimeout(hardTimeout);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
