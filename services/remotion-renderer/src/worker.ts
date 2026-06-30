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
import { prepareSource, type PreparedSource } from "./source.js";
import { selectFramevoComposition, renderFirstFrame, renderExport } from "./render.js";
import { makeThrottle } from "./progress.js";
import {
  toUserFacingError,
  SourceUnavailableError,
  SOURCE_UNAVAILABLE_MESSAGE,
  VideoDecodeError,
  VIDEO_DECODE_FAILED_MESSAGE,
} from "./errors.js";
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

/** Reject if `p` doesn't settle within `ms`. The underlying op may keep running
 *  in the background; callers fail + (the run entry) exits, so nothing hangs. */
async function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Sliding no-progress watchdog. `promise` REJECTS if `bump()` isn't called within
 * `timeoutMs`. Race it against the render so the awaited render call returns the
 * instant the watchdog fires — even if Remotion's own cancel can't unblock a
 * pre-first-frame hang (the bug where the old setTimeout fired but `await render`
 * never returned). `onFire` is the best-effort clean cancel.
 */
function makeProgressWatchdog(timeoutMs: number, onFire: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reject: ((e: Error) => void) | undefined;
  let fired = false;
  let stopped = false;
  const promise = new Promise<never>((_, rej) => {
    reject = rej;
  });
  const arm = () => {
    if (stopped || fired) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      onFire();
      reject?.(new Error("render_no_progress_timeout"));
    }, timeoutMs);
  };
  return {
    promise,
    start: arm,
    bump: arm,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    get fired() {
      return fired;
    },
  };
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
      // Re-stamp the backend so the UI shows Remotion progress (not chunks) even
      // for jobs created before `backend` was written at creation.
      backend: "remotion",
      renderMode: "single",
      workerId: WORKER_ID,
      buildVersion: BUILD_VERSION,
      remotionRendererVersion: RENDERER_VERSION,
      startedAt: FieldValue.serverTimestamp(),
      claimedAt: FieldValue.serverTimestamp(),
      lastHeartbeatAt: Date.now(),
      heartbeatAt: Date.now(),
      // Progress baseline so the reconciler's stale-PROGRESS watchdog measures
      // from "claim", not a frozen `startedAt` fallback. Real progress writes
      // (download/decode/render/upload) bump it; the bare heartbeat NEVER does.
      lastProgressAt: Date.now(),
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
  // Aborts pre-render stages the render `cancelSignal` can't reach (the source
  // download runs BEFORE renderMedia). Fired by both the cancel poll and the
  // hard timeout so neither a user-cancel nor a wedged download can hang the job.
  const preAbort = new AbortController();
  let wasCanceled = false;
  let timedOut = false;
  // Render-progress watchdog: started before renderMedia, re-armed on every
  // onProgress. If renderMedia produces NO progress within noProgressTimeoutMs
  // (e.g. the asset fetch stalls before the first frame), its promise REJECTS
  // (raced against the render) so the await returns and we fail clearly.
  let noProgressTimedOut = false;
  let renderWatchdog: ReturnType<typeof makeProgressWatchdog> | undefined;

  const patch = (data: Record<string, unknown>) =>
    jobRef.set(
      { ...data, lastHeartbeatAt: Date.now(), heartbeatAt: Date.now(), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  // Real-progress write: same as `patch` but also bumps `lastProgressAt` so the
  // reconciler's stale-progress watchdog sees forward motion. The bare heartbeat
  // (`patch({})`) deliberately does NOT bump it — that's what lets the watchdog
  // still catch an alive-but-wedged render.
  const progressPatch = (data: Record<string, unknown>) =>
    patch({ ...data, lastProgressAt: Date.now() });

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
          preAbort.abort();
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
  // Fires at `hardTimeoutSeconds` (< the Cloud Run execution timeout) so the
  // worker aborts + writes `failed` + releases minutes BEFORE the platform
  // SIGKILLs the container. Aborts both the render and any pre-render stage.
  const hardTimeout = setTimeout(() => {
    timedOut = true;
    console.error("[remotion-worker] HARD TIMEOUT — aborting render", {
      uid,
      jobId,
      hardTimeoutSeconds: cfg.hardTimeoutSeconds,
      platformTimeoutSeconds: cfg.timeoutSeconds,
    });
    cancel();
    preAbort.abort();
  }, cfg.hardTimeoutSeconds * 1000);

  let workDir: string | null = null;
  let source: PreparedSource | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), `framevo-remotion-${jobId}-`));
    const outPath = join(workDir, `${jobId}.mp4`);

    // ── Source ──────────────────────────────────────────────────────────────
    // Validate the GCS object, download it to /tmp, and serve it from a tiny
    // local HTTP server. Remotion's compositor downloads OffthreadVideo assets
    // Node-side: file:// is rejected and a remote signed URL can stall, so we
    // hand it a NORMAL http://127.0.0.1 URL backed by bytes already on disk.
    await progressPatch({ stage: "downloading", progress: 0.02, progressStage: "preparing" });
    source = await prepareSource(job, workDir, {
      resolveTimeoutMs: cfg.sourceResolveTimeoutSeconds * 1000,
      downloadTimeoutMs: cfg.downloadTimeoutSeconds * 1000,
      signal: preAbort.signal,
    });
    const renderUrlProtocol = new URL(source.renderUrl).protocol.replace(/:$/, "");
    log("local source server started", { uid, jobId, url: source.renderUrl, bytes: source.bytes });
    log(`render src protocol=${renderUrlProtocol}`, { uid, jobId });
    log("props loaded / source readable", { uid, jobId, bytes: source.bytes });

    // Paid cloud export always renders the source audio track (per-section speed
    // `audioMode:"mute"` is still honored from the recipe's moments inside the
    // composition). A global "muted" mode is intentionally not wired from the
    // client yet, so there is no job/recipe field to read here.
    const audioMode: FramevoAudioMode = "source";
    const inputProps: FramevoCompositionProps = {
      recipe: job.renderRecipe,
      src: source.renderUrl,
      audioMode,
    };

    // ── Bundle ──────────────────────────────────────────────────────────────
    await progressPatch({ stage: "decoding", progress: 0.04, progressStage: "rendering" });
    const serveUrl = await getServeUrl();
    log("composition bundle ready", { uid, jobId });

    // ── Verify the render src is exactly the local HTTP URL (no file://, no
    //    remote URL, no undefined) before handing it to the compositor. ───────
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(inputProps.src)) {
      throw new Error(`render src must be a local http URL, got: ${String(inputProps.src).slice(0, 40)}`);
    }
    log("render src verified", { uid, jobId, src: inputProps.src });

    // ── Select the composition once (metadata only — no video load). ──────────
    const composition = await selectFramevoComposition(serveUrl, inputProps);

    // ── First-frame smoke test: decode frame 0 through the SAME OffthreadVideo
    //    pipeline. If it can't decode/render in time, fail FAST as
    //    video_decode_failed instead of entering a long full render that hangs. ─
    log("first frame smoke test started", { uid, jobId, timeoutMs: cfg.smokeTestTimeoutMs });
    try {
      await raceTimeout(
        renderFirstFrame({
          composition,
          serveUrl,
          inputProps,
          output: join(workDir, "frame0.jpg"),
          timeoutMs: cfg.smokeTestTimeoutMs,
          gl: cfg.gl,
          logLevel: cfg.logLevel,
        }),
        cfg.smokeTestTimeoutMs,
        "first frame smoke test"
      );
    } catch (err) {
      if (wasCanceled) throw err; // a cancel during the smoke test → handled as canceled
      throw new VideoDecodeError(
        `first frame smoke test failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    log("first frame smoke test passed", { uid, jobId });

    // ── Full render (single MP4; native audio mux) with a sliding no-progress
    //    watchdog RACED against the render so a stall returns within the window. ─
    const gate = makeThrottle(cfg.progressThrottleMs);
    let sawProgress = false;
    renderWatchdog = makeProgressWatchdog(cfg.noProgressTimeoutMs, () => {
      noProgressTimedOut = true;
      console.error("[remotion-worker] no progress for the watchdog window — aborting render", {
        uid,
        jobId,
        noProgressTimeoutMs: cfg.noProgressTimeoutMs,
      });
      cancel(); // best-effort clean cancel
      preAbort.abort();
      // Last-resort: if settle/cleanup wedges, force a non-zero exit so the
      // container can never live on after a no-progress failure.
      setTimeout(() => {
        console.error("[remotion-worker] forcing exit(1) after no-progress timeout");
        process.exit(1);
      }, 45_000).unref();
    });
    log("renderMedia started", { uid, jobId, concurrency: cfg.concurrency });
    renderWatchdog.start();
    const totalFrames = composition.durationInFrames;
    const renderStartedAt = Date.now();
    const result = await Promise.race([
      renderExport({
        composition,
        serveUrl,
        inputProps,
        outputLocation: outPath,
        crf: cfg.crf,
        x264Preset: cfg.x264Preset,
        concurrency: cfg.concurrency,
        perFrameTimeoutMs: cfg.perFrameTimeoutMs,
        gl: cfg.gl,
        logLevel: cfg.logLevel,
        cancelSignal,
        onProgress: ({ progress, stitchStage, renderedFrames }) => {
          // Re-arm on EVERY callback (not just throttled writes) so real progress
          // always resets the watchdog.
          renderWatchdog?.bump();
          if (!sawProgress) {
            sawProgress = true;
            log("render progress", { uid, jobId, progress: Math.round(progress * 100) / 100 });
          }
          // Firestore writes are throttled (~7s) — compute frame/fps/eta so the UI
          // can show "Rendering video" with a real percentage + ETA.
          gate(() => {
            const elapsedSec = Math.max(0.001, (Date.now() - renderStartedAt) / 1000);
            const fpsEstimate =
              renderedFrames > 0 ? Math.round((renderedFrames / elapsedSec) * 10) / 10 : 0;
            const remaining = Math.max(0, totalFrames - renderedFrames);
            const etaSeconds = fpsEstimate > 0 ? Math.round(remaining / fpsEstimate) : undefined;
            const clamped = Math.min(0.97, Math.max(0.04, progress));
            void progressPatch({
              stage: stitchStage === "muxing" ? "encoding" : "rendering",
              progressStage: "rendering",
              progress: clamped,
              // Explicit 0–100 percentage too (safe for Remotion: the chunk-count
              // UI path is bypassed, so this never reads as a chunk percent).
              progressPercent: Math.round(clamped * 100),
              renderedFrames,
              totalFrames,
              fpsEstimate,
              ...(etaSeconds != null ? { etaSeconds } : {}),
            }).catch(() => {});
          });
        },
      }),
      renderWatchdog.promise,
    ]);
    renderWatchdog.stop();
    log("render completed", { uid, jobId, frames: result.durationInFrames });

    if (!existsSync(outPath) || statSync(outPath).size <= 0) {
      throw new Error("render produced no output file");
    }

    // ── Upload + Firebase download URL ───────────────────────────────────────
    await progressPatch({ stage: "uploading", progress: 0.98, progressStage: "uploading" });
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
    const friendly = noProgressTimedOut
      ? {
          code: "render_no_progress_timeout",
          message: "The export stalled before producing any video and was stopped. Please try again.",
        }
      : err instanceof VideoDecodeError
        ? { code: err.code, message: VIDEO_DECODE_FAILED_MESSAGE }
        : timedOut
          ? { code: "render_timeout", message: "The export took too long and was stopped. Please try again." }
          : err instanceof SourceUnavailableError
            ? { code: err.code, message: SOURCE_UNAVAILABLE_MESSAGE }
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
    renderWatchdog?.stop();
    // Stop the local source server before deleting the dir it serves from.
    if (source) {
      await source.close().catch(() => {});
      log("local source server closed", { uid, jobId });
    }
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
