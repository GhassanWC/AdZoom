import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);

// src/worker.ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync as existsSync2, statSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join as join3 } from "node:path";
import { FieldValue } from "firebase-admin/firestore";
import { makeCancelSignal } from "@remotion/renderer";

// src/firebase.ts
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

// src/config.ts
var cached;
function intEnv(key, fallback) {
  const n = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function loadConfig() {
  if (cached) return cached;
  const concurrencyRaw = Number.parseInt(process.env.REMOTION_CONCURRENCY ?? "", 10);
  const timeoutSeconds = intEnv("REMOTION_EXPORT_TIMEOUT_SECONDS", 1800);
  const timeoutGraceSeconds = intEnv("REMOTION_TIMEOUT_GRACE_SECONDS", 120);
  cached = {
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET,
    crf: intEnv("REMOTION_CRF", 18),
    x264Preset: process.env.REMOTION_X264_PRESET || "medium",
    concurrency: Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? concurrencyRaw : null,
    timeoutSeconds,
    timeoutGraceSeconds,
    // Fire the in-process kill at least 60s before the platform timeout (and never
    // below 60s total) so the worker can always settle the job first.
    hardTimeoutSeconds: Math.max(60, timeoutSeconds - timeoutGraceSeconds),
    downloadTimeoutSeconds: intEnv("REMOTION_DOWNLOAD_TIMEOUT_SECONDS", 600),
    perFrameTimeoutMs: intEnv("REMOTION_FRAME_TIMEOUT_MS", 6e4),
    cancelPollMs: intEnv("REMOTION_CANCEL_POLL_MS", 3e3),
    progressThrottleMs: intEnv("REMOTION_PROGRESS_THROTTLE_MS", 2e3),
    heartbeatMs: intEnv("REMOTION_HEARTBEAT_MS", 3e4)
  };
  return cached;
}

// src/firebase.ts
var app;
function getAdmin() {
  const cfg = loadConfig();
  if (!app) {
    if (getApps().length) {
      app = getApps()[0];
    } else {
      const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
      const credential = b64 ? cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))) : applicationDefault();
      app = initializeApp({
        credential,
        projectId: cfg.projectId,
        storageBucket: cfg.storageBucket
      });
    }
  }
  return { app, db: getFirestore(app), bucketName: cfg.storageBucket };
}
function bucket() {
  const { app: a, bucketName } = getAdmin();
  return getStorage(a).bucket(bucketName);
}

// src/bundle.ts
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { bundle } from "@remotion/bundler";
var here = dirname(fileURLToPath(import.meta.url));
var APP_SRC = process.env.REMOTION_APP_SRC || resolve(here, "../../../src");
var ENTRY = join(APP_SRC, "remotion", "Root.tsx");
var cached2;
function getServeUrl() {
  if (cached2) return cached2;
  const prebuilt = process.env.REMOTION_SERVE_DIR;
  if (prebuilt && existsSync(prebuilt)) {
    cached2 = Promise.resolve(prebuilt);
    return cached2;
  }
  cached2 = bundle({
    entryPoint: ENTRY,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        alias: { ...config.resolve?.alias ?? {}, "@": APP_SRC }
      }
    })
  });
  return cached2;
}

// src/source.ts
import { createWriteStream } from "node:fs";
import { join as join2, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
async function resolveSource(job, workDir, opts) {
  const file = bucket().file(job.sourceStoragePath);
  if ((process.env.REMOTION_SOURCE_MODE || "download").toLowerCase() === "signed") {
    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + Math.max(6e4, opts.signedTtlMs)
    });
    return { src: url, bytes: 0 };
  }
  const ext = extname(job.sourceStoragePath) || ".mp4";
  const localPath = join2(workDir, `source${ext}`);
  const timeout = AbortSignal.timeout(Math.max(1, opts.downloadTimeoutMs));
  const combined = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    await pipeline(file.createReadStream(), createWriteStream(localPath), { signal: combined });
  } catch (err) {
    const e = err;
    const aborted = e?.name === "AbortError" || e?.code === "ABORT_ERR";
    throw new Error(
      `source download ${aborted ? "timed out" : "failed"}: ${e?.message ?? String(err)}`
    );
  }
  const [meta] = await file.getMetadata().catch(() => [{ size: 0 }]);
  const bytes = Number(meta.size ?? 0) || 0;
  return { src: pathToFileURL(localPath).href, localPath, bytes };
}

// src/render.ts
import {
  selectComposition,
  renderMedia
} from "@remotion/renderer";
var COMPOSITION_ID = "Framevo";
async function renderExport(args) {
  const composition = await selectComposition({
    serveUrl: args.serveUrl,
    id: COMPOSITION_ID,
    inputProps: args.inputProps
  });
  console.info("[remotion-worker] composition selected", {
    id: COMPOSITION_ID,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames
  });
  await renderMedia({
    composition,
    serveUrl: args.serveUrl,
    codec: "h264",
    audioCodec: "aac",
    outputLocation: args.outputLocation,
    inputProps: args.inputProps,
    crf: args.crf,
    x264Preset: args.x264Preset,
    imageFormat: "jpeg",
    concurrency: args.concurrency,
    chromiumOptions: { enableMultiProcessOnLinux: true },
    timeoutInMilliseconds: args.perFrameTimeoutMs,
    cancelSignal: args.cancelSignal,
    onProgress: args.onProgress
  });
  return {
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames
  };
}

// src/progress.ts
function makeThrottle(ms) {
  let last = 0;
  return (fn) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn();
    }
  };
}

// src/errors.ts
function toUserFacingError(err) {
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (raw.includes("render_timeout") || raw.includes("timed out") || raw.includes("timeout")) {
    return { code: "render_timeout", message: "The export took too long and was stopped. Please try again." };
  }
  if (raw.includes("upload_failed") || raw.includes("upload")) {
    return { code: "upload_failed", message: "The export rendered but couldn't be uploaded. Please try again." };
  }
  if (raw.includes("no such object") || raw.includes("not found") || raw.includes("download") || raw.includes("source")) {
    return { code: "source_unavailable", message: "Couldn't read the source recording. Please try again." };
  }
  if (raw.includes("decode") || raw.includes("unsupported") || raw.includes("codec")) {
    return { code: "unsupported_source", message: "This recording couldn't be processed for export." };
  }
  return { code: "render_failed", message: "Something went wrong while exporting your video. Please try again." };
}

// src/worker.ts
var WORKER_ID = process.env.EXPORT_WORKER_ID || hostname() || "remotion-renderer";
var BUILD_VERSION = process.env.BUILD_VERSION ?? "unknown";
var RENDERER_VERSION = "2026.06-remotion";
var HEARTBEAT_STALE_MS = 3 * 60 * 1e3;
function toMs(v) {
  return v?.toMillis?.() ?? 0;
}
function log(msg, extra) {
  console.info(`[remotion-worker] ${msg}`, extra ?? {});
}
async function claimJob(db, uid, jobId) {
  const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) return { action: "missing" };
    const job = snap.data();
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
        status: job.status
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
      // Progress baseline so the reconciler's stale-PROGRESS watchdog measures
      // from "claim", not a frozen `startedAt` fallback. Real progress writes
      // (download/decode/render/upload) bump it; the bare heartbeat NEVER does.
      lastProgressAt: Date.now(),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { action: "claimed", job };
  });
}
async function processRemotionJob(uid, jobId) {
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
  const preAbort = new AbortController();
  let wasCanceled = false;
  let timedOut = false;
  const patch = (data) => jobRef.set(
    { ...data, lastHeartbeatAt: Date.now(), heartbeatAt: Date.now(), updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  const progressPatch = (data) => patch({ ...data, lastProgressAt: Date.now() });
  let polling = false;
  const cancelPoll = setInterval(() => {
    if (polling) return;
    polling = true;
    void jobRef.get().then((snap) => {
      const st = snap.exists ? snap.get("status") : void 0;
      if (!snap.exists || snap.get("cancelRequested") === true || st === "canceled" || st === "failed") {
        wasCanceled = true;
        cancel();
        preAbort.abort();
        clearInterval(cancelPoll);
      }
    }).catch(() => {
    }).finally(() => {
      polling = false;
    });
  }, cfg.cancelPollMs);
  const heartbeat = setInterval(() => {
    void patch({}).catch(() => {
    });
  }, cfg.heartbeatMs);
  const hardTimeout = setTimeout(() => {
    timedOut = true;
    console.error("[remotion-worker] HARD TIMEOUT \u2014 aborting render", {
      uid,
      jobId,
      hardTimeoutSeconds: cfg.hardTimeoutSeconds,
      platformTimeoutSeconds: cfg.timeoutSeconds
    });
    cancel();
    preAbort.abort();
  }, cfg.hardTimeoutSeconds * 1e3);
  let workDir = null;
  try {
    workDir = await mkdtemp(join3(tmpdir(), `framevo-remotion-${jobId}-`));
    const outPath = join3(workDir, `${jobId}.mp4`);
    await progressPatch({ stage: "downloading", progress: 0.02, progressStage: "preparing" });
    const source = await resolveSource(job, workDir, {
      signedTtlMs: (cfg.timeoutSeconds + 600) * 1e3,
      downloadTimeoutMs: cfg.downloadTimeoutSeconds * 1e3,
      signal: preAbort.signal
    });
    log("props loaded / source readable", { uid, jobId, bytes: source.bytes, mode: source.localPath ? "download" : "signed" });
    const audioMode = "source";
    const inputProps = {
      recipe: job.renderRecipe,
      src: source.src,
      audioMode
    };
    await progressPatch({ stage: "decoding", progress: 0.04, progressStage: "rendering" });
    const serveUrl = await getServeUrl();
    log("composition bundle ready", { uid, jobId });
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
        gate(
          () => void progressPatch({
            stage: stitchStage === "muxing" ? "encoding" : "rendering",
            progressStage: "rendering",
            progress: Math.min(0.97, Math.max(0.04, progress))
          }).catch(() => {
          })
        );
      }
    });
    log("render completed", { uid, jobId, frames: result.durationInFrames });
    if (!existsSync2(outPath) || statSync(outPath).size <= 0) {
      throw new Error("render produced no output file");
    }
    await progressPatch({ stage: "uploading", progress: 0.98, progressStage: "uploading" });
    log("upload started", { uid, jobId, dest: job.outputPath });
    const token = randomUUID();
    try {
      await bucket().upload(outPath, {
        destination: job.outputPath,
        metadata: { contentType: "video/mp4", metadata: { firebaseStorageDownloadTokens: token } }
      });
    } catch (err) {
      throw new Error(`upload_failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(job.outputPath)}?alt=media&token=${token}`;
    log("upload completed", { uid, jobId });
    const finalized = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return false;
      const st = snap.get("status");
      if (st === "canceled" || st === "failed" || st === "ready") return false;
      const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
      const usageSnap = await tx.get(usageRef);
      const u = usageSnap.data() ?? {};
      tx.set(
        usageRef,
        {
          cloudMinutesReserved: Math.max(0, (u.cloudMinutesReserved ?? 0) - estimate),
          cloudMinutesConsumed: Math.max(0, u.cloudMinutesConsumed ?? 0) + estimate,
          lastCloudExportAt: Date.now(),
          updatedAt: Date.now()
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
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return true;
    });
    if (!finalized) {
      log("canceled/already-final during upload \u2014 skipping ready", { uid, jobId });
      return "canceled";
    }
    await db.doc(`users/${uid}/projects/${job.projectId}`).set({ exportUrl: downloadUrl, updatedAt: Date.now() }, { merge: true }).catch(() => {
    });
    log("Firestore settled success", { uid, jobId, minutes: estimate });
    return "ready";
  } catch (err) {
    if (wasCanceled) {
      log("canceled", { uid, jobId });
      return "canceled";
    }
    const raw = err instanceof Error ? err.message : "Render failed.";
    const friendly = timedOut ? { code: "render_timeout", message: "The export took too long and was stopped. Please try again." } : toUserFacingError(err);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return;
      const st = snap.get("status");
      if (st === "ready" || st === "failed" || st === "canceled") return;
      if (estimate > 0 && monthKey) {
        const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
        const uSnap = await tx.get(usageRef);
        const reserved = uSnap.data()?.cloudMinutesReserved ?? 0;
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
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }).catch((e) => console.error("[remotion-worker] failed-finalize txn error", { uid, jobId, e }));
    log("Firestore settled failure", { uid, jobId, errorCode: friendly.code, error: raw, timedOut });
    return "failed";
  } finally {
    clearInterval(cancelPoll);
    clearInterval(heartbeat);
    clearTimeout(hardTimeout);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {
    });
  }
}

// src/run.ts
async function main() {
  const build = process.env.BUILD_VERSION ?? "unknown";
  console.info(`[remotion-worker] container started build=${build} node=${process.version}`);
  const uid = process.env.EXPORT_JOB_UID?.trim();
  const jobId = process.env.EXPORT_JOB_ID?.trim();
  console.info(
    `[remotion-worker] env EXPORT_JOB_UID=${uid ?? "(unset)"} EXPORT_JOB_ID=${jobId ?? "(unset)"}`
  );
  if (!uid || !jobId) {
    console.error("[remotion-worker] FATAL: missing EXPORT_JOB_UID/EXPORT_JOB_ID \u2014 nothing to render");
    process.exit(1);
  }
  try {
    const result = await processRemotionJob(uid, jobId);
    console.info(`[remotion-worker] finished result=${result}`);
    process.exit(result === "failed" ? 1 : 0);
  } catch (err) {
    console.error("[remotion-worker] FATAL unhandled error", err);
    process.exit(1);
  }
}
void main();
