"use client";

import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebase } from "./client";
import { stripUndefined } from "./sanitize";
import type {
  AnalysisChunk,
  AnalysisChunkStatus,
  AnalysisJob,
  AnalysisJobStatus,
  CvEngineKind,
  DetectedMoment,
  VisualAnalysis,
} from "./schema";

/**
 * Firestore access for the progressive chunked analysis engine.
 *
 *   users/{uid}/analysisJobs/{jobId}
 *   users/{uid}/analysisJobs/{jobId}/chunks/{chunkId}
 *
 * Jobs are stored per-user (not under the project) so the Processing page can
 * list every active job with a single collection subscription. Each job
 * carries `projectId` to link back. Timestamps are plain epoch-ms numbers
 * (`Date.now()`) — the orchestrator runs client-side, so server timestamps
 * would only add coercion overhead.
 */

function jobsCol(uid: string) {
  const { db } = getFirebase();
  return collection(db, "users", uid, "analysisJobs");
}
function jobDoc(uid: string, jobId: string) {
  const { db } = getFirebase();
  return doc(db, "users", uid, "analysisJobs", jobId);
}
function chunksCol(uid: string, jobId: string) {
  const { db } = getFirebase();
  return collection(db, "users", uid, "analysisJobs", jobId, "chunks");
}
function chunkDoc(uid: string, jobId: string, chunkId: string) {
  const { db } = getFirebase();
  return doc(db, "users", uid, "analysisJobs", jobId, "chunks", chunkId);
}

/** `job_<projectId>` → `<projectId>` (best-effort, for the log breadcrumb). */
function projectIdFromJobId(jobId: string): string | null {
  return jobId.startsWith("job_") ? jobId.slice("job_".length) : null;
}

/**
 * Wrap a chunked-analysis Firestore op so a permission denial (or any failure)
 * is logged with the EXACT operation + path BEFORE re-throwing. The orchestrator
 * surfaces the re-thrown error as a hard failure; this breadcrumb names which
 * read/write was denied — e.g. prod rules not deployed for `analysisJobs`.
 * Prod-safe: console.* ships to prod (next.config.ts has no removeConsole).
 */
async function withPermCheck<T>(
  operation: string,
  pathStr: string,
  uid: string,
  projectId: string | null,
  task: () => Promise<T>
): Promise<T> {
  try {
    return await task();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error("[firestore-permission-check]", {
      operation,
      path: pathStr,
      uid,
      projectId,
      errorCode: e?.code ?? null,
      errorMessage: e?.message ?? String(err),
    });
    throw err;
  }
}

export async function createAnalysisJob(uid: string, job: AnalysisJob): Promise<void> {
  await withPermCheck(
    "analysisJobs.create",
    `users/${uid}/analysisJobs/${job.id}`,
    uid,
    job.projectId ?? projectIdFromJobId(job.id),
    () => setDoc(jobDoc(uid, job.id), stripUndefined({ ...job, updatedAt: Date.now() }))
  );
}

export async function updateAnalysisJob(
  uid: string,
  jobId: string,
  patch: Partial<AnalysisJob>
): Promise<void> {
  await withPermCheck(
    "analysisJobs.update",
    `users/${uid}/analysisJobs/${jobId}`,
    uid,
    projectIdFromJobId(jobId),
    () =>
      setDoc(
        jobDoc(uid, jobId),
        stripUndefined({ ...patch, updatedAt: Date.now() }),
        { merge: true }
      )
  );
}

/** Create all chunk docs for a job in one batched write (queued state). */
export async function createChunks(
  uid: string,
  jobId: string,
  chunks: AnalysisChunk[]
): Promise<void> {
  await withPermCheck(
    "chunks.batchCreate",
    `users/${uid}/analysisJobs/${jobId}/chunks/* (${chunks.length})`,
    uid,
    projectIdFromJobId(jobId),
    async () => {
      const { db } = getFirebase();
      const batch = writeBatch(db);
      for (const c of chunks) {
        batch.set(chunkDoc(uid, jobId, c.id), stripUndefined({ ...c, updatedAt: Date.now() }));
      }
      await batch.commit();
    }
  );
}

export async function updateChunk(
  uid: string,
  jobId: string,
  chunkId: string,
  patch: Partial<AnalysisChunk>
): Promise<void> {
  await withPermCheck(
    "chunks.update",
    `users/${uid}/analysisJobs/${jobId}/chunks/${chunkId}`,
    uid,
    projectIdFromJobId(jobId),
    () =>
      setDoc(
        chunkDoc(uid, jobId, chunkId),
        stripUndefined({ ...patch, updatedAt: Date.now() }),
        { merge: true }
      )
  );
}

/**
 * Find an in-flight job for a project (for resume-on-mount). Single-field
 * equality query (no composite index needed); status filtered + newest picked
 * client-side.
 */
export async function getActiveJobForProject(
  uid: string,
  projectId: string
): Promise<AnalysisJob | null> {
  const snap = await withPermCheck(
    "analysisJobs.query",
    `users/${uid}/analysisJobs?projectId=${projectId}`,
    uid,
    projectId,
    () => getDocs(query(jobsCol(uid), where("projectId", "==", projectId)))
  );
  const active = snap.docs
    .map((d) => materializeJob(d.id, d.data()))
    .filter((j) => j.status === "queued" || j.status === "running")
    .sort((a, b) => b.startedAt - a.startedAt);
  return active[0] ?? null;
}

/** Log a denied/failed realtime listener (onSnapshot errors don't throw). */
function logListenerError(operation: string, pathStr: string, uid: string, jobId: string | null) {
  return (err: { code?: string; message?: string }) => {
    console.error("[firestore-permission-check]", {
      operation,
      path: pathStr,
      uid,
      projectId: jobId ? projectIdFromJobId(jobId) : null,
      errorCode: err?.code ?? null,
      errorMessage: err?.message ?? String(err),
    });
  };
}

export function subscribeAnalysisJobs(
  uid: string,
  onChange: (jobs: AnalysisJob[]) => void
): Unsubscribe {
  return onSnapshot(
    query(jobsCol(uid), orderBy("startedAt", "desc")),
    (snap) => onChange(snap.docs.map((d) => materializeJob(d.id, d.data()))),
    logListenerError("analysisJobs.subscribe", `users/${uid}/analysisJobs`, uid, null)
  );
}

export function subscribeAnalysisJob(
  uid: string,
  jobId: string,
  onChange: (job: AnalysisJob | null) => void
): Unsubscribe {
  return onSnapshot(
    jobDoc(uid, jobId),
    (snap) => onChange(snap.exists() ? materializeJob(snap.id, snap.data()) : null),
    logListenerError("analysisJob.subscribe", `users/${uid}/analysisJobs/${jobId}`, uid, jobId)
  );
}

export function subscribeChunks(
  uid: string,
  jobId: string,
  onChange: (chunks: AnalysisChunk[]) => void
): Unsubscribe {
  return onSnapshot(
    query(chunksCol(uid, jobId), orderBy("index", "asc")),
    (snap) => onChange(snap.docs.map((d) => materializeChunk(d.id, d.data()))),
    logListenerError("chunks.subscribe", `users/${uid}/analysisJobs/${jobId}/chunks`, uid, jobId)
  );
}

export async function getChunks(uid: string, jobId: string): Promise<AnalysisChunk[]> {
  const snap = await withPermCheck(
    "chunks.query",
    `users/${uid}/analysisJobs/${jobId}/chunks`,
    uid,
    projectIdFromJobId(jobId),
    () => getDocs(query(chunksCol(uid, jobId), orderBy("index", "asc")))
  );
  return snap.docs.map((d) => materializeChunk(d.id, d.data()));
}

// ── materializers (defensive coercion) ──────────────────────────────────────
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function materializeJob(id: string, data: Record<string, unknown>): AnalysisJob {
  return {
    id,
    projectId: (data.projectId as string) ?? "",
    projectTitle: (data.projectTitle as string) ?? "Untitled",
    status: (data.status as AnalysisJobStatus) ?? "queued",
    engine: (data.engine as CvEngineKind) ?? "hidden-video",
    duration: num(data.duration),
    chunkSize: num(data.chunkSize),
    chunkMode: data.chunkMode as AnalysisJob["chunkMode"],
    chunkCount: num(data.chunkCount),
    queuedCount: num(data.queuedCount),
    processingCount: num(data.processingCount),
    completedCount: num(data.completedCount),
    failedCount: num(data.failedCount),
    progress: num(data.progress),
    momentsSoFar: num(data.momentsSoFar),
    estimateRemainingMs:
      typeof data.estimateRemainingMs === "number" ? data.estimateRemainingMs : undefined,
    cancelRequested: data.cancelRequested === true,
    errorMessage: typeof data.errorMessage === "string" ? data.errorMessage : undefined,
    startedAt: num(data.startedAt),
    completedAt: typeof data.completedAt === "number" ? data.completedAt : undefined,
    updatedAt: num(data.updatedAt),
  };
}

function materializeChunk(id: string, data: Record<string, unknown>): AnalysisChunk {
  return {
    id,
    index: num(data.index),
    startTime: num(data.startTime),
    endTime: num(data.endTime),
    status: (data.status as AnalysisChunkStatus) ?? "queued",
    progress: num(data.progress),
    moments: Array.isArray(data.moments) ? (data.moments as DetectedMoment[]) : [],
    va: (data.va as VisualAnalysis) ?? undefined,
    attempts: num(data.attempts),
    errorMessage: typeof data.errorMessage === "string" ? data.errorMessage : undefined,
    updatedAt: num(data.updatedAt),
  };
}
