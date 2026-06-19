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
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { getAdmin, bucket } from "./firebase.js";
import { loadConfig } from "./config.js";
import { releaseMinutes } from "./minutes.js";
import { renderToMp4, CanceledError } from "./render.js";
import { toUserFacingError } from "./errors.js";
import type { ExportJobDoc } from "@/lib/firebase/schema";

/** How long a claimed-but-unfinished job is considered owned by an instance. */
const LEASE_MS = 30 * 60 * 1000;

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

    if (job.status === "rendering" && Date.now() - toMs(job.startedAt) < LEASE_MS) {
      return { action: "leased" };
    }

    tx.update(jobRef, {
      status: "rendering",
      stage: "downloading",
      progress: 0,
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { action: "claimed", job };
  });
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
    jobRef.set({ ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), `framevo-job-${jobId}-`));
    const srcPath = join(workDir, `source${extname(job.sourceStoragePath) || ".mp4"}`);
    const outPath = join(workDir, `${jobId}.mp4`);

    // ── Download source ──────────────────────────────────────────────────
    await bucket().file(job.sourceStoragePath).download({ destination: srcPath });

    // ── Render (canvas parity + ffmpeg) ─────────────────────────────────
    let lastPct = -1;
    const result = await renderToMp4({
      serialized: job.renderRecipe,
      sourcePath: srcPath,
      outputPath: outPath,
      crf: cfg.crf,
      preset: cfg.preset,
      signal: controller.signal,
      onProgress: ({ stage, progress }) => {
        const pct = Math.round(progress * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        void patch({ stage, progress });
      },
    });

    // ── Upload + Firebase download URL ──────────────────────────────────
    await patch({ stage: "uploading", progress: 0.98 });
    const token = randomUUID();
    await bucket().upload(outPath, {
      destination: job.outputPath,
      metadata: {
        contentType: "video/mp4",
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });
    const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(
      job.outputPath
    )}?alt=media&token=${token}`;

    // ── Settle minutes + mark ready (atomic, guarded against a late cancel) ─
    const finalized = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return false;
      const st = snap.get("status") as string | undefined;
      // The cancel route may have finalized this job during upload — don't
      // resurrect it or double-spend the reservation it already released.
      if (st === "canceled" || st === "failed") return false;

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
          warnings: result.warnings,
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
    // Genuine failure (render/stall/upload) — the worker owns release + status.
    await releaseMinutes(db, uid, monthKey, estimate).catch(() => {});
    // The user sees a CLEAN one-liner; the raw ffmpeg/stack detail stays in the
    // worker logs only (never persisted to Firestore / shown in the UI).
    const raw = err instanceof Error ? err.message : "Render failed.";
    const friendly = toUserFacingError(err);
    await patch({
      status: "failed",
      errorCode: friendly.code,
      errorMessage: friendly.message,
      completedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
    console.error("[worker] failed", { uid, jobId, errorCode: friendly.code, error: raw });
    return "failed";
  } finally {
    clearInterval(cancelPoll);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
