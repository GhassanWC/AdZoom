import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);

// src/worker.ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync as existsSync2, statSync as statSync2 } from "node:fs";
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
    sourceResolveTimeoutSeconds: intEnv("REMOTION_SOURCE_RESOLVE_TIMEOUT_SECONDS", 60),
    downloadTimeoutSeconds: intEnv("REMOTION_DOWNLOAD_TIMEOUT_SECONDS", 600),
    noProgressTimeoutMs: intEnv("REMOTION_NO_PROGRESS_TIMEOUT_MS", 12e4),
    smokeTestTimeoutMs: intEnv("REMOTION_SMOKE_TIMEOUT_MS", 6e4),
    gl: process.env.REMOTION_GL || "swiftshader",
    logLevel: process.env.REMOTION_LOG_LEVEL || (process.env.REMOTION_DEBUG === "1" ? "verbose" : "info"),
    perFrameTimeoutMs: intEnv("REMOTION_FRAME_TIMEOUT_MS", 6e4),
    cancelPollMs: intEnv("REMOTION_CANCEL_POLL_MS", 3e3),
    // Throttle Firestore progress writes to ~every 7s (5–10s band) so the UI
    // updates smoothly without hammering Firestore.
    progressThrottleMs: intEnv("REMOTION_PROGRESS_THROTTLE_MS", 7e3),
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
import { createServer } from "node:http";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { join as join2, extname } from "node:path";
import { pipeline } from "node:stream/promises";

// src/errors.ts
var SourceUnavailableError = class extends Error {
  code = "source_unavailable";
  constructor(message) {
    super(message);
    this.name = "SourceUnavailableError";
  }
};
var SOURCE_UNAVAILABLE_MESSAGE = "Couldn't read the source recording. Please try again.";
var VideoDecodeError = class extends Error {
  code = "video_decode_failed";
  constructor(message) {
    super(message);
    this.name = "VideoDecodeError";
  }
};
var VIDEO_DECODE_FAILED_MESSAGE = "Could not decode the source video for cloud export.";
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

// src/source.ts
function withDeadline(p, ms, signal, label) {
  return new Promise((resolve2, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`${label} timed out after ${ms}ms`))),
      ms
    );
    const onAbort = () => finish(() => reject(new Error(`${label} aborted`)));
    if (signal) {
      if (signal.aborted) {
        finish(() => reject(new Error(`${label} aborted`)));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    p.then(
      (v) => finish(() => resolve2(v)),
      (e) => finish(() => reject(e))
    );
  });
}
function startLocalFileServer(filePath, routeName) {
  const size = statSync(filePath).size;
  const server = createServer((req, res) => {
    const startedAt = Date.now();
    const method = (req.method || "GET").toUpperCase();
    const rangeHeader = req.headers.range ?? "";
    const userAgent = req.headers["user-agent"] ?? "";
    const url = req.url ?? "";
    console.info("[local-source] request received", { method, url, range: rangeHeader, userAgent });
    let status = 200;
    let bytesPlanned = 0;
    res.on(
      "finish",
      () => console.info("[local-source] request done", {
        method,
        url,
        range: rangeHeader,
        status,
        bytes: bytesPlanned,
        durationMs: Date.now() - startedAt
      })
    );
    res.on("close", () => {
      if (!res.writableFinished) {
        console.warn("[local-source] request closed before finish", {
          method,
          url,
          range: rangeHeader,
          status,
          durationMs: Date.now() - startedAt
        });
      }
    });
    if (method !== "GET" && method !== "HEAD") {
      status = 405;
      res.writeHead(405).end();
      return;
    }
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const match = rangeHeader ? /bytes=(\d*)-(\d*)/.exec(rangeHeader) : null;
    let start = 0;
    let end = size - 1;
    if (match) {
      const s = match[1] ? Number.parseInt(match[1], 10) : NaN;
      const e = match[2] ? Number.parseInt(match[2], 10) : NaN;
      start = Number.isFinite(s) ? s : 0;
      end = Number.isFinite(e) ? Math.min(e, size - 1) : size - 1;
      if (start > end || start >= size) {
        status = 416;
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      status = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    bytesPlanned = end - start + 1;
    res.setHeader("Content-Length", String(bytesPlanned));
    res.writeHead(status);
    if (method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(filePath, { start, end });
    stream.on("error", () => res.destroy());
    res.on("error", () => stream.destroy());
    stream.pipe(res);
  });
  return new Promise((resolve2, reject) => {
    server.on("error", reject);
    const sockets = /* @__PURE__ */ new Set();
    server.on("connection", (sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve2({
        url: `http://127.0.0.1:${port}/${routeName}`,
        port,
        close: () => new Promise((res) => {
          for (const s of sockets) s.destroy();
          server.close(() => res());
        })
      });
    });
  });
}
async function prepareSource(job, workDir, opts) {
  const file = bucket().file(job.sourceStoragePath);
  let bytes = 0;
  try {
    const [meta] = await withDeadline(
      file.getMetadata(),
      opts.resolveTimeoutMs,
      opts.signal,
      "source metadata read"
    );
    bytes = Number(meta.size ?? 0) || 0;
  } catch (err) {
    throw new SourceUnavailableError(
      `source metadata read failed for ${job.sourceStoragePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!(bytes > 0)) {
    throw new SourceUnavailableError(
      `source object ${job.sourceStoragePath} is empty or has no readable size`
    );
  }
  const ext = extname(job.sourceStoragePath) || ".mp4";
  const routeName = `source${ext}`;
  const localPath = join2(workDir, routeName);
  const timeout = AbortSignal.timeout(Math.max(1, opts.downloadTimeoutMs));
  const combined = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    await pipeline(file.createReadStream(), createWriteStream(localPath), { signal: combined });
  } catch (err) {
    const e = err;
    const aborted = e?.name === "AbortError" || e?.code === "ABORT_ERR";
    throw new SourceUnavailableError(
      `source download ${aborted ? "timed out / aborted" : "failed"} for ${job.sourceStoragePath}: ${e?.message ?? String(err)}`
    );
  }
  let server;
  try {
    server = await startLocalFileServer(localPath, routeName);
  } catch (err) {
    throw new SourceUnavailableError(
      `failed to start local source server: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!/^http:\/\//i.test(server.url)) {
    await server.close().catch(() => {
    });
    throw new SourceUnavailableError(`local source URL is not http: ${server.url.slice(0, 16)}\u2026`);
  }
  return { renderUrl: server.url, bytes, localPath, close: server.close };
}

// src/render.ts
import {
  selectComposition,
  renderMedia,
  renderStill
} from "@remotion/renderer";
var COMPOSITION_ID = "Framevo";
function browserLog(scope) {
  return (l) => console.info(`[remotion-browser:${scope}] ${l.type}: ${(l.text || "").slice(0, 800)}`);
}
function onAssetDownload(src) {
  console.info("[remotion-download] asset fetch start", { src: src.slice(0, 180) });
  return void 0;
}
async function selectFramevoComposition(serveUrl, inputProps) {
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps
  });
  console.info("[remotion-worker] composition selected", {
    id: COMPOSITION_ID,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames
  });
  return composition;
}
async function renderFirstFrame(args) {
  await renderStill({
    composition: args.composition,
    serveUrl: args.serveUrl,
    output: args.output,
    frame: 0,
    inputProps: args.inputProps,
    imageFormat: "jpeg",
    chromiumOptions: {
      gl: args.gl,
      enableMultiProcessOnLinux: true
    },
    timeoutInMilliseconds: args.timeoutMs,
    logLevel: args.logLevel,
    onBrowserLog: browserLog("still")
  });
}
async function renderExport(args) {
  await renderMedia({
    composition: args.composition,
    serveUrl: args.serveUrl,
    codec: "h264",
    audioCodec: "aac",
    outputLocation: args.outputLocation,
    inputProps: args.inputProps,
    crf: args.crf,
    x264Preset: args.x264Preset,
    imageFormat: "jpeg",
    concurrency: args.concurrency,
    chromiumOptions: {
      gl: args.gl,
      enableMultiProcessOnLinux: true
    },
    timeoutInMilliseconds: args.perFrameTimeoutMs,
    cancelSignal: args.cancelSignal,
    onProgress: args.onProgress,
    logLevel: args.logLevel,
    onBrowserLog: browserLog("media"),
    onDownload: onAssetDownload
  });
  return {
    width: args.composition.width,
    height: args.composition.height,
    fps: args.composition.fps,
    durationInFrames: args.composition.durationInFrames
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
function buildExportFilename(projectTitle) {
  const safe = (projectTitle || "video").normalize("NFKD").replace(/[^\w\s-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "video";
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  return `Framevo-export-${safe}-${date}.mp4`;
}
async function raceTimeout(p, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function makeProgressWatchdog(timeoutMs, onFire) {
  let timer;
  let reject;
  let fired = false;
  let stopped = false;
  const promise = new Promise((_, rej) => {
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
    }
  };
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
  let noProgressTimedOut = false;
  let renderWatchdog;
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
  let source = null;
  try {
    workDir = await mkdtemp(join3(tmpdir(), `framevo-remotion-${jobId}-`));
    const outPath = join3(workDir, `${jobId}.mp4`);
    await progressPatch({ stage: "downloading", progress: 0.02, progressStage: "preparing" });
    source = await prepareSource(job, workDir, {
      resolveTimeoutMs: cfg.sourceResolveTimeoutSeconds * 1e3,
      downloadTimeoutMs: cfg.downloadTimeoutSeconds * 1e3,
      signal: preAbort.signal
    });
    const renderUrlProtocol = new URL(source.renderUrl).protocol.replace(/:$/, "");
    log("local source server started", { uid, jobId, url: source.renderUrl, bytes: source.bytes });
    log(`render src protocol=${renderUrlProtocol}`, { uid, jobId });
    log("props loaded / source readable", { uid, jobId, bytes: source.bytes });
    const audioMode = "source";
    const inputProps = {
      recipe: job.renderRecipe,
      src: source.renderUrl,
      audioMode
    };
    await progressPatch({ stage: "decoding", progress: 0.04, progressStage: "rendering" });
    const serveUrl = await getServeUrl();
    log("composition bundle ready", { uid, jobId });
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(inputProps.src)) {
      throw new Error(`render src must be a local http URL, got: ${String(inputProps.src).slice(0, 40)}`);
    }
    log("render src verified", { uid, jobId, src: inputProps.src });
    const composition = await selectFramevoComposition(serveUrl, inputProps);
    log("first frame smoke test started", { uid, jobId, timeoutMs: cfg.smokeTestTimeoutMs });
    try {
      await raceTimeout(
        renderFirstFrame({
          composition,
          serveUrl,
          inputProps,
          output: join3(workDir, "frame0.jpg"),
          timeoutMs: cfg.smokeTestTimeoutMs,
          gl: cfg.gl,
          logLevel: cfg.logLevel
        }),
        cfg.smokeTestTimeoutMs,
        "first frame smoke test"
      );
    } catch (err) {
      if (wasCanceled) throw err;
      throw new VideoDecodeError(
        `first frame smoke test failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    log("first frame smoke test passed", { uid, jobId });
    const gate = makeThrottle(cfg.progressThrottleMs);
    let sawProgress = false;
    renderWatchdog = makeProgressWatchdog(cfg.noProgressTimeoutMs, () => {
      noProgressTimedOut = true;
      console.error("[remotion-worker] no progress for the watchdog window \u2014 aborting render", {
        uid,
        jobId,
        noProgressTimeoutMs: cfg.noProgressTimeoutMs
      });
      cancel();
      preAbort.abort();
      setTimeout(() => {
        console.error("[remotion-worker] forcing exit(1) after no-progress timeout");
        process.exit(1);
      }, 45e3).unref();
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
          renderWatchdog?.bump();
          if (!sawProgress) {
            sawProgress = true;
            log("render progress", { uid, jobId, progress: Math.round(progress * 100) / 100 });
          }
          gate(() => {
            const elapsedSec = Math.max(1e-3, (Date.now() - renderStartedAt) / 1e3);
            const fpsEstimate = renderedFrames > 0 ? Math.round(renderedFrames / elapsedSec * 10) / 10 : 0;
            const remaining = Math.max(0, totalFrames - renderedFrames);
            const etaSeconds = fpsEstimate > 0 ? Math.round(remaining / fpsEstimate) : void 0;
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
              ...etaSeconds != null ? { etaSeconds } : {}
            }).catch(() => {
            });
          });
        }
      }),
      renderWatchdog.promise
    ]);
    renderWatchdog.stop();
    log("render completed", { uid, jobId, frames: result.durationInFrames });
    if (!existsSync2(outPath) || statSync2(outPath).size <= 0) {
      throw new Error("render produced no output file");
    }
    const outputSizeBytes = statSync2(outPath).size;
    const outputFilename = buildExportFilename(job.projectTitle);
    await progressPatch({ stage: "uploading", progress: 0.98, progressStage: "uploading" });
    log("upload started", { uid, jobId, dest: job.outputPath });
    const token = randomUUID();
    try {
      await bucket().upload(outPath, {
        destination: job.outputPath,
        metadata: {
          contentType: "video/mp4",
          contentDisposition: `attachment; filename="${outputFilename}"`,
          metadata: { firebaseStorageDownloadTokens: token }
        }
      });
    } catch (err) {
      throw new Error(`upload_failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(job.outputPath)}?alt=media&token=${token}`;
    log("upload completed", { uid, jobId, bytes: outputSizeBytes, filename: outputFilename });
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
          // Direct-download handoff fields (the /api/export/download route reads
          // outputPath/outputBucket; the UI shows the filename/size).
          backend: "remotion",
          outputPath: job.outputPath,
          outputBucket: bucketName,
          outputSizeBytes,
          outputContentType: "video/mp4",
          outputFilename,
          readyAt: Date.now(),
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
    const friendly = noProgressTimedOut ? {
      code: "render_no_progress_timeout",
      message: "The export stalled before producing any video and was stopped. Please try again."
    } : err instanceof VideoDecodeError ? { code: err.code, message: VIDEO_DECODE_FAILED_MESSAGE } : timedOut ? { code: "render_timeout", message: "The export took too long and was stopped. Please try again." } : err instanceof SourceUnavailableError ? { code: err.code, message: SOURCE_UNAVAILABLE_MESSAGE } : toUserFacingError(err);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return;
      const st = snap.get("status");
      if (st === "ready" || st === "failed" || st === "canceled") return;
      const countApplied = snap.get("monthlyUsageApplied") === true;
      if (monthKey && (estimate > 0 || countApplied)) {
        const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
        const uSnap = await tx.get(usageRef);
        const u = uSnap.data();
        tx.set(
          usageRef,
          {
            ...estimate > 0 ? { cloudMinutesReserved: Math.max(0, (u?.cloudMinutesReserved ?? 0) - estimate) } : {},
            ...countApplied ? { exportsUsedThisMonth: Math.max(0, (u?.exportsUsedThisMonth ?? 0) - 1) } : {},
            updatedAt: Date.now()
          },
          { merge: true }
        );
      }
      tx.set(
        jobRef,
        {
          status: "failed",
          errorCode: friendly.code,
          errorMessage: friendly.message,
          ...countApplied ? { monthlyUsageApplied: false } : {},
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
    renderWatchdog?.stop();
    if (source) {
      await source.close().catch(() => {
      });
      log("local source server closed", { uid, jobId });
    }
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
