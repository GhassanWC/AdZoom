/**
 * Process ONE export job, end to end. Designed to be safely retried by Cloud
 * Tasks: terminal jobs short-circuit, and an in-flight job is leased (by
 * `startedAt`) so a duplicate delivery doesn't double-render or double-charge.
 *
 *   claim (txn) → download source → render (canvas parity + ffmpeg) →
 *   upload mp4 → settle minutes → status "ready"
 *
 * Any failure releases the minute reservation and marks the job "failed";
 * a cancel (flag polled mid-render) releases + marks "canceled".
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join, extname } from "node:path";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { getAdmin, bucket } from "./firebase.js";
import { loadConfig, type WorkerConfig } from "./config.js";
import { renderToMp4, CanceledError } from "./render.js";
import { normalizeSource, probeSource, isUnsupportedAudioCodec } from "./ffmpeg.js";
import { computePreflight, AUDIO_UNSUPPORTED_WARNING } from "./preflight.js";
import { toUserFacingError } from "./errors.js";
import type { ExportJobDoc, ProjectDoc } from "@/lib/firebase/schema";

/** Identity of THIS worker process, stamped on every job it touches (so a failed
 *  row can name the worker + build that produced it). */
const WORKER_ID = process.env.EXPORT_WORKER_ID || hostname() || "worker";
const BUILD_VERSION = process.env.BUILD_VERSION ?? "unknown";

/**
 * A claimed job is "owned" only while its owner is HEARTBEATING. The worker bumps
 * `updatedAt` every 60s (plus on every progress write), so a non-terminal job
 * whose `updatedAt` is older than this is an ABANDONED job (the instance crashed
 * / was OOM-killed / recycled) and may be re-claimed by a Cloud Tasks retry.
 * 3 missed heartbeats ⇒ dead. Keeping this short (vs. a fixed 30-min lease from
 * `startedAt`) is what lets a retry RESUME a crashed render in minutes instead of
 * being told "leased" for half an hour. It must stay below the reconciler's
 * stale window (10 min) so a retry gets a chance to resume before the job is failed.
 */
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

type ClaimResult =
  | { action: "missing" }
  | { action: "terminal" }
  | { action: "leased" }
  | { action: "canceled" }
  | { action: "claimed"; job: ExportJobDoc };

function toMs(v: unknown): number {
  const t = v as { toMillis?: () => number } | undefined;
  return t?.toMillis?.() ?? 0;
}

async function claimJob(
  db: Firestore,
  uid: string,
  jobId: string
): Promise<ClaimResult> {
  const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) return { action: "missing" };
    const job = snap.data() as ExportJobDoc;

    // Terminal — incl. a job the cancel route already canceled (it sets
    // status="canceled" atomically with releasing the reservation), so there's
    // nothing left for the worker to do.
    if (job.status === "ready" || job.status === "failed" || job.status === "canceled") {
      return { action: "terminal" };
    }

    // In-flight AND recently heartbeated ⇒ a live worker owns it; skip (the
    // server returns a RETRYABLE status so Cloud Tasks tries again later — by
    // which point the owner has either finished (→ terminal) or gone stale
    // (→ re-claimable here)).
    const inFlight = job.status === "rendering" || job.status === "uploading";
    if (inFlight && Date.now() - toMs(job.updatedAt) < HEARTBEAT_STALE_MS) {
      return { action: "leased" };
    }
    // Otherwise: queued, or an abandoned in-flight job (stale heartbeat) — claim
    // it and (re-)render from scratch. The minute reservation persists across the
    // crash, so re-rendering reuses it (no double reserve); the success txn is
    // idempotent against a resurrected original owner.
    if (inFlight) {
      console.warn("[worker] re-claiming abandoned job (stale heartbeat)", {
        uid,
        jobId,
        status: job.status,
        updatedAtAgeMs: Date.now() - toMs(job.updatedAt),
      });
    }

    tx.update(jobRef, {
      status: "rendering",
      stage: "downloading",
      progress: 0,
      workerId: WORKER_ID,
      buildVersion: BUILD_VERSION,
      startedAt: FieldValue.serverTimestamp(),
      claimedAt: FieldValue.serverTimestamp(),
      lastHeartbeatAt: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { action: "claimed", job };
  });
}

interface PreparedSource {
  /** Local path the render should read (the original, or a normalized copy). */
  renderSourcePath: string;
  /** True when unsupported audio was stripped (apac etc.) — drives the warning. */
  audioDropped: boolean;
  /** Warnings the preparation step itself produced (audio-dropped notice). */
  warnings: string[];
  /** Summary recorded on the job for observability. */
  preflight: { videoCodec: string; audioCodec: string; risky: boolean; normalized: boolean };
}

/**
 * Preflight the downloaded source and, when normalization is enabled AND the
 * source is "risky" (non-H.264 video / non-AAC / undecodable audio), transcode
 * it to a worker-safe H.264+AAC MP4 — cached per project and reused across
 * exports. A non-risky source (or a disabled flag) renders the original
 * untouched; the render's own `canDecodeAudio` guard remains the fallback.
 */
async function prepareSource(args: {
  db: Firestore;
  uid: string;
  jobId: string;
  job: ExportJobDoc;
  cfg: WorkerConfig;
  srcPath: string;
  workDir: string;
  signal: AbortSignal;
  patch: (data: Record<string, unknown>) => Promise<unknown>;
}): Promise<PreparedSource> {
  const { db, uid, jobId, job, cfg, srcPath, workDir, signal, patch } = args;

  const pf = await computePreflight(srcPath);

  // Fast-fail: an undecodable source can't be normalized OR rendered — bail now
  // with a clear decode error (the handler releases the reserved minutes)
  // instead of attempting a doomed normalize/render that would only stall.
  if (!pf.videoDecodable) {
    throw new Error("preflight: source video could not be decoded");
  }

  const summary = {
    videoCodec: pf.info.videoCodec,
    audioCodec: pf.info.audioCodec,
    risky: pf.risky,
    normalized: false,
  };

  // Not risky, or the feature is off → render the original. The render's
  // canDecodeAudio guard still drops undecodable audio (defense in depth).
  if (!pf.risky || !cfg.normalizeEnabled) {
    if (pf.risky) {
      console.warn("[worker:preflight] risky source, normalization disabled", {
        jobId,
        reasons: pf.reasons,
      });
    }
    return { renderSourcePath: srcPath, audioDropped: false, warnings: [], preflight: summary };
  }

  console.info("[worker:preflight] risky source — normalizing", { jobId, reasons: pf.reasons });

  const projRef = db.doc(`users/${uid}/projects/${job.projectId}`);
  const proj = (await projRef.get()).data() as ProjectDoc | undefined;
  const normStoragePath = `users/${uid}/projects/${job.projectId}/normalized/source.mp4`;
  const normPath = join(workDir, "normalized.mp4");

  // Identity of the ORIGINAL object: re-uploading the source changes its
  // generation (and md5Hash), which invalidates this cache key automatically.
  let key = "";
  try {
    const [meta] = await bucket().file(job.sourceStoragePath).getMetadata();
    key = `${meta.generation ?? ""}:${meta.md5Hash ?? ""}`;
  } catch {
    key = ""; // metadata unreadable → treat as a miss (re-normalize)
  }

  // Cache hit: reuse the project's normalized copy when it matches the current
  // source AND still exists in Storage.
  if (key && proj?.normalizedSourcePath && proj.normalizedSourceKey === key) {
    const [exists] = await bucket().file(proj.normalizedSourcePath).exists();
    if (exists) {
      await bucket().file(proj.normalizedSourcePath).download({ destination: normPath });
      const audioDropped = !!proj.normalizedAudioDropped;
      console.info("[worker:normalize] cache hit", { jobId, path: proj.normalizedSourcePath });
      return {
        renderSourcePath: normPath,
        audioDropped,
        warnings: audioDropped ? [AUDIO_UNSUPPORTED_WARNING] : [],
        preflight: { ...summary, normalized: true },
      };
    }
  }

  // Cache miss: transcode now (honoring cancel), upload, record the cache. The
  // normalizer selects ONE clean audio stream and falls back to silent on bad
  // audio — it never fails the export for an audio problem.
  await patch({ stage: "normalizing", progress: 0 });
  let audioDropped = false;
  try {
    const norm = await normalizeSource({
      sourcePath: srcPath,
      outputPath: normPath,
      crf: cfg.normalizeCrf,
      preset: cfg.normalizePreset,
      signal,
    });
    audioDropped = norm.audioStatus === "removed";
  } catch (err) {
    if (signal.aborted) throw new CanceledError();
    // Tag so the failed job records a precise `normalize_failed` code (the raw
    // ffmpeg detail still goes to the worker logs via the handler's catch).
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[worker:normalize] failed", { jobId, detail: detail.slice(-2000) });
    throw new Error(`normalize_failed: ${detail}`);
  }
  if (signal.aborted) throw new CanceledError();

  await bucket().upload(normPath, {
    destination: normStoragePath,
    metadata: { contentType: "video/mp4" },
  });
  // Best-effort cache write — a failure just means the next export re-normalizes.
  await projRef
    .set(
      {
        normalizedSourcePath: normStoragePath,
        normalizedSourceKey: key,
        normalizedAudioDropped: audioDropped,
        updatedAt: Date.now(),
      },
      { merge: true }
    )
    .catch(() => {});

  console.info("[worker:normalize] done", { jobId, audioDropped });
  return {
    renderSourcePath: normPath,
    audioDropped,
    warnings: audioDropped ? [AUDIO_UNSUPPORTED_WARNING] : [],
    preflight: { ...summary, normalized: true },
  };
}

export async function processJob(uid: string, jobId: string): Promise<string> {
  const cfg = loadConfig();
  const { db, bucketName } = getAdmin();
  const jobRef = db.doc(`users/${uid}/exportJobs/${jobId}`);

  const claim = await claimJob(db, uid, jobId);
  if (claim.action !== "claimed") {
    console.info("[worker] skip", { uid, jobId, reason: claim.action });
    return claim.action;
  }
  const job = claim.job;
  const estimate = job.estimatedExportMinutes ?? 0;
  const monthKey = job.monthlyBucket;

  // Cancellation is owned by the API (`/api/export/cancel`), which atomically
  // sets status="canceled" + releases the reservation. This background poll
  // just watches that flag and ABORTS the render (killing ffmpeg, which unblocks
  // any hung decode/encode) — it never touches Firestore or minutes itself.
  const controller = new AbortController();
  let polling = false;
  const cancelPoll = setInterval(() => {
    if (polling) return;
    polling = true;
    void jobRef
      .get()
      .then((snap) => {
        const st = snap.exists ? (snap.get("status") as string | undefined) : undefined;
        if (
          !snap.exists ||
          snap.get("cancelRequested") === true ||
          st === "canceled" ||
          st === "failed"
        ) {
          controller.abort();
          clearInterval(cancelPoll);
        }
      })
      .catch(() => {
        /* transient — retry next tick */
      })
      .finally(() => {
        polling = false;
      });
  }, 1000);

  const patch = (data: Record<string, unknown>) =>
    jobRef.set(
      { ...data, lastHeartbeatAt: Date.now(), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

  // Heartbeat: bump `updatedAt` every 60s while THIS instance is alive, so the
  // stale-job reconciler (which fails jobs whose updatedAt is too old) only ever
  // fires for a genuinely dead/crashed worker — not for a long-but-healthy
  // download or normalization pass that writes no progress of its own. (A wedged
  // render is handled separately by renderToMp4's 90s stall watchdog.)
  const heartbeat = setInterval(() => {
    void patch({}).catch(() => {});
  }, 60_000);

  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), `framevo-job-${jobId}-`));
    const srcPath = join(workDir, `source${extname(job.sourceStoragePath) || ".mp4"}`);
    const outPath = join(workDir, `${jobId}.mp4`);

    // ── Download source ──────────────────────────────────────────────────
    await patch({ stage: "downloading", progress: 0.02 });
    const dlStart = Date.now();
    await bucket().file(job.sourceStoragePath).download({ destination: srcPath });
    console.info("[worker:timing] download", { jobId, ms: Date.now() - dlStart });

    // ── Preflight + (conditional) normalization ─────────────────────────
    // Risky sources (exotic video codec / non-AAC / undecodable audio) are
    // transcoded to a worker-safe H.264+AAC MP4 first, cached per project.
    const prepStart = Date.now();
    const prepared = await prepareSource({
      db,
      uid,
      jobId,
      job,
      cfg,
      srcPath,
      workDir,
      signal: controller.signal,
      patch,
    });
    console.info("[worker:timing] prepare", {
      jobId,
      ms: Date.now() - prepStart,
      normalized: prepared.preflight.normalized,
    });

    // ── Render (canvas parity + ffmpeg) ─────────────────────────────────
    let lastPct = -1;
    const result = await renderToMp4({
      serialized: job.renderRecipe,
      sourcePath: prepared.renderSourcePath,
      outputPath: outPath,
      crf: cfg.crf,
      preset: cfg.preset,
      signal: controller.signal,
      // Normalization already stripped unsupported audio — tell the render so it
      // emits the right warning (not "source has no audio").
      audioAlreadyDropped: prepared.audioDropped,
      onProgress: ({ stage, progress }) => {
        const pct = Math.round(progress * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        void patch({ stage, progress });
      },
    });

    // Preparation warnings (audio-dropped) + render warnings, de-duplicated.
    const warnings = Array.from(new Set([...prepared.warnings, ...result.warnings]));

    // ── Audio-integrity check ───────────────────────────────────────────
    // If the RENDER SOURCE had a usable audio track that we did NOT intentionally
    // drop (unsupported codec → silent fallback + warning), the output MUST carry
    // audio. A silent output here is a real bug — fail explicitly rather than
    // ship a video the user expected to have sound.
    const audioIntentionallyDropped =
      prepared.audioDropped || warnings.includes(AUDIO_UNSUPPORTED_WARNING);
    if (!audioIntentionallyDropped) {
      const [srcInfo, outInfo] = await Promise.all([
        probeSource(prepared.renderSourcePath).catch(() => null),
        probeSource(outPath).catch(() => null),
      ]);
      const expectedAudio =
        !!srcInfo?.hasAudio &&
        !isUnsupportedAudioCodec(srcInfo.audioCodec, srcInfo.audioCodecTag);
      if (expectedAudio && outInfo && !outInfo.hasAudio) {
        throw new Error(
          "audio_missing_after_render: source has audio but rendered output has none"
        );
      }
    }

    // ── Upload + Firebase download URL ──────────────────────────────────
    await patch({ stage: "uploading", progress: 0.98 });
    const token = randomUUID();
    try {
      await bucket().upload(outPath, {
        destination: job.outputPath,
        metadata: {
          contentType: "video/mp4",
          metadata: { firebaseStorageDownloadTokens: token },
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`upload_failed: ${detail}`);
    }
    const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(
      job.outputPath
    )}?alt=media&token=${token}`;

    // ── Settle minutes + mark ready (atomic, guarded against a late cancel) ─
    const finalized = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return false;
      const st = snap.get("status") as string | undefined;
      // Don't double-settle. The cancel route may have finalized this during
      // upload (canceled/failed → it released the reservation), OR another worker
      // that re-claimed this job after a stale heartbeat already settled it
      // (ready) — settling again would double-spend `cloudMinutesConsumed`.
      if (st === "canceled" || st === "failed" || st === "ready") return false;

      const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
      const usageSnap = await tx.get(usageRef);
      const u =
        (usageSnap.data() as
          | { cloudMinutesReserved?: number; cloudMinutesConsumed?: number }
          | undefined) ?? {};
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
          progress: 1,
          downloadUrl,
          consumedExportMinutes: estimate,
          warnings,
          preflight: prepared.preflight,
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return true;
    });

    if (!finalized) {
      console.info("[worker] canceled during upload — skipping ready", { uid, jobId });
      return "canceled";
    }

    // Surface the latest export on the parent project, like the browser path.
    await db
      .doc(`users/${uid}/projects/${job.projectId}`)
      .set({ exportUrl: downloadUrl, updatedAt: Date.now() }, { merge: true })
      .catch(() => {});

    console.info("[worker] done", { uid, jobId, minutes: estimate });
    return "ready";
  } catch (err) {
    // Cancel: the route already released minutes + set status="canceled". The
    // worker must NOT release again or it would double-spend the ledger.
    if (err instanceof CanceledError) {
      console.info("[worker] canceled", { uid, jobId });
      return "canceled";
    }
    // Genuine failure (render/stall/upload). Finalize in ONE transaction that
    // re-checks status first — exactly like the success settle — so it can't:
    //   • clobber a `ready` status (a retry that re-claimed this job after a
    //     stale heartbeat may have already settled it), nor
    //   • double-release the reservation (cancel route / reconciler may have
    //     released it), which on the shared usage doc could wipe a SIBLING job's
    //     reservation.
    // The user sees a CLEAN one-liner; raw ffmpeg/stack detail stays in the logs.
    const raw = err instanceof Error ? err.message : "Render failed.";
    const friendly = toUserFacingError(err);
    await db
      .runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        if (!snap.exists) return;
        const st = snap.get("status") as string | undefined;
        if (st === "ready" || st === "failed" || st === "canceled") return; // already terminal
        if (estimate > 0 && monthKey) {
          const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
          const uSnap = await tx.get(usageRef);
          const reserved =
            (uSnap.data() as { cloudMinutesReserved?: number } | undefined)
              ?.cloudMinutesReserved ?? 0;
          tx.set(
            usageRef,
            { cloudMinutesReserved: Math.max(0, reserved - estimate), updatedAt: Date.now() },
            { merge: true }
          );
        }
        tx.set(
          jobRef,
          {
            status: "failed",
            errorCode: friendly.code,
            errorMessage: friendly.message,
            workerId: WORKER_ID,
            buildVersion: BUILD_VERSION,
            failedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      })
      .catch((e) => console.error("[worker] failed-finalize txn error", { uid, jobId, e }));
    console.error("[worker] failed", { uid, jobId, errorCode: friendly.code, error: raw });
    return "failed";
  } finally {
    clearInterval(cancelPoll);
    clearInterval(heartbeat);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
