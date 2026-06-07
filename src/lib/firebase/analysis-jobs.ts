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

export async function createAnalysisJob(uid: string, job: AnalysisJob): Promise<void> {
  await setDoc(jobDoc(uid, job.id), stripUndefined({ ...job, updatedAt: Date.now() }));
}

export async function updateAnalysisJob(
  uid: string,
  jobId: string,
  patch: Partial<AnalysisJob>
): Promise<void> {
  await setDoc(
    jobDoc(uid, jobId),
    stripUndefined({ ...patch, updatedAt: Date.now() }),
    { merge: true }
  );
}

/** Create all chunk docs for a job in one batched write (queued state). */
export async function createChunks(
  uid: string,
  jobId: string,
  chunks: AnalysisChunk[]
): Promise<void> {
  const { db } = getFirebase();
  const batch = writeBatch(db);
  for (const c of chunks) {
    batch.set(chunkDoc(uid, jobId, c.id), stripUndefined({ ...c, updatedAt: Date.now() }));
  }
  await batch.commit();
}

export async function updateChunk(
  uid: string,
  jobId: string,
  chunkId: string,
  patch: Partial<AnalysisChunk>
): Promise<void> {
  await setDoc(
    chunkDoc(uid, jobId, chunkId),
    stripUndefined({ ...patch, updatedAt: Date.now() }),
    { merge: true }
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
  const snap = await getDocs(query(jobsCol(uid), where("projectId", "==", projectId)));
  const active = snap.docs
    .map((d) => materializeJob(d.id, d.data()))
    .filter((j) => j.status === "queued" || j.status === "running")
    .sort((a, b) => b.startedAt - a.startedAt);
  return active[0] ?? null;
}

export function subscribeAnalysisJobs(
  uid: string,
  onChange: (jobs: AnalysisJob[]) => void
): Unsubscribe {
  return onSnapshot(query(jobsCol(uid), orderBy("startedAt", "desc")), (snap) => {
    onChange(snap.docs.map((d) => materializeJob(d.id, d.data())));
  });
}

export function subscribeAnalysisJob(
  uid: string,
  jobId: string,
  onChange: (job: AnalysisJob | null) => void
): Unsubscribe {
  return onSnapshot(jobDoc(uid, jobId), (snap) => {
    onChange(snap.exists() ? materializeJob(snap.id, snap.data()) : null);
  });
}

export function subscribeChunks(
  uid: string,
  jobId: string,
  onChange: (chunks: AnalysisChunk[]) => void
): Unsubscribe {
  return onSnapshot(query(chunksCol(uid, jobId), orderBy("index", "asc")), (snap) => {
    onChange(snap.docs.map((d) => materializeChunk(d.id, d.data())));
  });
}

export async function getChunks(uid: string, jobId: string): Promise<AnalysisChunk[]> {
  const snap = await getDocs(query(chunksCol(uid, jobId), orderBy("index", "asc")));
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
