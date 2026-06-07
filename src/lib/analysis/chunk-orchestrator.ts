"use client";

import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { getFirebase } from "../firebase/client";
import { stripUndefined } from "../firebase/sanitize";
import type {
  AnalysisChunk,
  AnalysisJob,
  DetectedMoment,
  ProjectDoc,
  VisualAnalysis,
} from "../firebase/schema";
import type { Interaction } from "../recording/types";
import { momentsFromEvents } from "../attention/events";
import { CvTaintedError } from "../cv/types";
import { visualMomentsFromCv } from "../cv/visual-moments";
import { mergeVisualAnalysis, type VaChunk } from "../cv/merge";
import { selectCvEngine, cvConcurrencyFor } from "../cv/engine/select";
import { HiddenVideoCvEngine } from "../cv/engine/hidden-video";
import type { CvChunkEngine, CvSource } from "../cv/engine/types";
import {
  CHUNK_MAX_ATTEMPTS,
  CHUNK_PROGRESS_WRITE_MS,
  CHUNK_SIZE_S,
  chunkWindows,
} from "./chunk-config";
import {
  createAnalysisJob,
  createChunks,
  getActiveJobForProject,
  getChunks,
  subscribeAnalysisJob,
  updateAnalysisJob,
  updateChunk,
} from "../firebase/analysis-jobs";
import {
  enqueueProjectWrite,
  flushProjectWrites,
  setAnalysisActive,
} from "../firebase/project-writer";

/** A job updated within this window is treated as "actively driven" elsewhere. */
const ACTIVE_JOB_HEARTBEAT_MS = 45_000;

/** Per-chunk minimum spacing for the CV backstop (progressive draft only). */
const PROGRESSIVE_MIN_SPACING = 6;

export interface ChunkedRunArgs {
  uid: string;
  project: ProjectDoc;
  /** Loaded interaction stream (tab recordings) or null. */
  interactions: Interaction[] | null;
  idTokenGetter: () => Promise<string | null>;
  /** Aborts the whole run (driven by `cancelAnalyze`). */
  signal: AbortSignal;
  /** Optional progress sink (e.g. to mirror onto the editor overlay). */
  onJob?: (job: AnalysisJob) => void;
  /**
   * Resume an in-flight job after a refresh (reuse completed chunks). False =
   * a fresh user-initiated run that recreates chunks and clears the timeline.
   */
  resume?: boolean;
}

/**
 * Progressive chunked analysis orchestrator (client-owned).
 *
 * Splits the video into windows, runs CV per chunk (WebCodecs pool or
 * hidden-video fallback), derives deterministic event + CV moments per chunk
 * and appends them to `project.analysis.detectedMoments` the instant a chunk
 * finishes, persists job + chunk state for resume, then runs ONE whole-video AI
 * pass at the end via the existing analyze route (`mode: "finalize"`).
 *
 * Resumable: completed chunks (moments already in the project doc, window-VA in
 * the chunk doc) are skipped; only `queued`/`failed`/`cv-running` chunks re-run.
 */
export async function runChunkedAnalysis(args: ChunkedRunArgs): Promise<void> {
  const { uid, project, interactions, idTokenGetter, signal, onJob } = args;
  const resume = args.resume === true;
  const { db } = getFirebase();
  const pid = project.id;
  const projectRef = doc(db, "users", uid, "projects", pid);
  const duration = project.duration ?? 0;
  if (duration <= 0) throw new Error("Unknown duration — cannot chunk.");

  const windows = chunkWindows(duration);
  const jobId = `job_${project.id}`;

  // Every Firestore write for this project (moment appends, chunk/job status,
  // VA + terminal writes) funnels through one serialized queue so concurrent
  // commits can't trigger "Another write batch or compaction is already
  // active". `coalesceTag` lets superseded progress writes skip as stale.
  const qWrite = <T>(label: string, task: () => Promise<T>, coalesceTag?: string) =>
    enqueueProjectWrite(pid, label, task, coalesceTag ? { coalesceTag } : undefined);

  // Cross-tab guard: a FRESH run would reset `project.status` + clear the
  // timeline and re-create chunks. If another tab is already actively driving
  // this project's job (recent heartbeat), don't start a competing run — that
  // double-run is what leaves the overlay stuck "analyzing" after the first run
  // already finalized. Let the active run finish; just mirror its state.
  if (!resume) {
    const active = await getActiveJobForProject(uid, project.id);
    if (
      active &&
      active.status === "running" &&
      Date.now() - active.updatedAt < ACTIVE_JOB_HEARTBEAT_MS
    ) {
      onJob?.(active);
      return;
    }
  }

  // Engine selection (WebCodecs primary, hidden-video fallback). Held in a ref
  // so a probe failure can hot-swap to the proven engine without aborting.
  const source: CvSource = {
    url: project.originalVideoUrl,
    mimeType: project.mimeType,
  };
  const engineRef: { current: CvChunkEngine } = {
    current: await selectCvEngine(source),
  };

  // Resume reuses existing chunk docs; a fresh run ignores them (and the
  // createChunks batch below overwrites the old docs back to "queued").
  const existingChunks = resume ? await getChunks(uid, jobId) : [];
  const byIndex = new Map(existingChunks.map((c) => [c.index, c]));
  const resuming = resume && existingChunks.length === windows.length;

  // ── Job + chunk docs ──────────────────────────────────────────────────
  const job: AnalysisJob = {
    id: jobId,
    projectId: project.id,
    projectTitle: project.title || "Untitled",
    status: "running",
    engine: engineRef.current.kind,
    duration,
    chunkSize: CHUNK_SIZE_S,
    chunkCount: windows.length,
    queuedCount: windows.length,
    processingCount: 0,
    completedCount: existingChunks.filter((c) => c.status === "completed").length,
    failedCount: 0,
    progress: 0,
    momentsSoFar: existingChunks
      .filter((c) => c.status === "completed")
      .reduce((n, c) => n + c.moments.length, 0),
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await qWrite("create-job", () => createAnalysisJob(uid, job));
  onJob?.(job);

  if (!resuming) {
    const chunkDocs: AnalysisChunk[] = windows.map((w) => ({
      id: `c${w.index}`,
      index: w.index,
      startTime: w.startTime,
      endTime: w.endTime,
      status: "queued",
      progress: 0,
      moments: [],
      attempts: 0,
      updatedAt: Date.now(),
    }));
    await qWrite("create-chunks", () => createChunks(uid, jobId, chunkDocs));
    // Fresh run → clear any prior timeline so progressive appends accumulate.
    await qWrite("project-reset", () =>
      setDoc(
        projectRef,
        {
          status: "analyzing",
          analysis: {
            status: "analyzing",
            stage: "Analyzing in chunks",
            detectedMoments: [],
            startedAt: Date.now(),
            cancelRequested: false,
            errorKind: null,
            errorMessage: null,
          },
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      )
    );
  } else {
    await qWrite("project-resume", () =>
      setDoc(
        projectRef,
        {
          status: "analyzing",
          analysis: { status: "analyzing", stage: "Resuming chunked analysis" },
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      )
    );
  }

  // ── Cancellation: external signal OR job.cancelRequested in Firestore ──
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal.addEventListener("abort", onAbort);
  const unsubJob = subscribeAnalysisJob(uid, jobId, (j) => {
    if (j) {
      onJob?.(j);
      if (j.cancelRequested) ac.abort();
    }
  });

  // In-memory VA accumulator for the final merge (also persisted per chunk).
  const vaChunks: VaChunk[] = [];
  for (const c of existingChunks) {
    if (c.status === "completed" && c.va) {
      vaChunks.push({ startTime: c.startTime, va: c.va });
    }
  }

  const counters = {
    completed: job.completedCount,
    failed: 0,
    processing: 0,
    momentsSoFar: job.momentsSoFar,
  };
  const chunkTimes: number[] = [];

  // Partial counter patches — serialized, never coalesced (each carries
  // different fields; skipping one would drop a field).
  const writeJob = (patch: Partial<AnalysisJob>) =>
    qWrite("job-update", () => updateAnalysisJob(uid, jobId, patch));

  // ── Process one chunk (with retry) ────────────────────────────────────
  // `probe` makes engine errors propagate (instead of marking the chunk
  // failed) so the caller can hot-swap engines on the first chunk.
  const processChunk = async (
    w: { index: number; startTime: number; endTime: number },
    probe = false
  ): Promise<void> => {
    const chunkId = `c${w.index}`;
    const existing = byIndex.get(w.index);
    if (existing?.status === "completed") return; // resume skip

    counters.processing++;
    await Promise.all([
      qWrite("chunk-start", () =>
        updateChunk(uid, jobId, chunkId, { status: "cv-running", progress: 0 })
      ),
      writeJob({ processingCount: counters.processing }),
    ]);

    let lastProgressWrite = 0;
    const t0 = Date.now();

    for (let attempt = 1; attempt <= CHUNK_MAX_ATTEMPTS; attempt++) {
      if (ac.signal.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const va = await engineRef.current.analyzeChunk({
          startTime: w.startTime,
          endTime: w.endTime,
          duration,
          signal: ac.signal,
          onProgress: (p) => {
            const now = Date.now();
            if (now - lastProgressWrite < CHUNK_PROGRESS_WRITE_MS) return;
            lastProgressWrite = now;
            // Coalesced: a newer progress for this chunk supersedes a queued one.
            void qWrite(
              "chunk-progress",
              () => updateChunk(uid, jobId, chunkId, { progress: p }),
              `chunk-${w.index}-progress`
            );
          },
        });

        const moments = deterministicChunkMoments(w, va, interactions, project);

        // Persist chunk result + append to the live timeline (both serialized).
        await Promise.all([
          qWrite("chunk-complete", () =>
            updateChunk(uid, jobId, chunkId, {
              status: "completed",
              progress: 1,
              moments,
              va,
              attempts: attempt,
            })
          ),
          qWrite("append-moments", () => appendMoments(uid, pid, moments)),
        ]);

        vaChunks.push({ startTime: w.startTime, va });
        counters.processing--;
        counters.completed++;
        counters.momentsSoFar += moments.length;
        chunkTimes.push(Date.now() - t0);
        await writeJob({
          processingCount: counters.processing,
          completedCount: counters.completed,
          queuedCount: Math.max(
            0,
            windows.length - counters.completed - counters.failed
          ),
          momentsSoFar: counters.momentsSoFar,
          progress: counters.completed / windows.length,
          estimateRemainingMs: estimateRemaining(
            chunkTimes,
            windows.length - counters.completed - counters.failed
          ),
        });
        return;
      } catch (err) {
        if (ac.signal.aborted) throw err;
        // Tainted canvas (cross-origin, no CORS) can't be read on-device —
        // retrying won't help. Propagate so the caller falls back to the
        // server-side whole-video path.
        if (err instanceof CvTaintedError) throw err;
        // During the probe, surface the error so the caller can hot-swap the
        // engine rather than marking the chunk permanently failed.
        if (probe) throw err;
        if (attempt >= CHUNK_MAX_ATTEMPTS) {
          counters.processing--;
          counters.failed++;
          await Promise.all([
            qWrite("chunk-failed", () =>
              updateChunk(uid, jobId, chunkId, {
                status: "failed",
                attempts: attempt,
                errorMessage: err instanceof Error ? err.message : String(err),
              })
            ),
            writeJob({
              processingCount: counters.processing,
              failedCount: counters.failed,
              queuedCount: Math.max(
                0,
                windows.length - counters.completed - counters.failed
              ),
            }),
          ]);
          return; // a failed chunk does NOT fail the job
        }
        // else retry
      }
    }
  };

  // ── Run the pool, then finalize ───────────────────────────────────────
  // Mark active so the repair effect / any compaction defers while we append.
  setAnalysisActive(pid, true);
  try {
    const pending = windows.filter(
      (w) => byIndex.get(w.index)?.status !== "completed"
    );

    // Probe: validate the WebCodecs engine on the first chunk SERIALLY before
    // committing to parallel decode. Any non-abort/non-taint failure hot-swaps
    // to the proven hidden-video engine — so an untested codec path can never
    // break the run, only forgo the speedup.
    if (engineRef.current.kind === "webcodecs" && pending.length > 0) {
      try {
        await processChunk(pending[0], true);
        pending.shift();
      } catch (probeErr) {
        if (ac.signal.aborted || probeErr instanceof CvTaintedError) throw probeErr;
        try {
          engineRef.current.dispose();
        } catch {
          /* ignore */
        }
        engineRef.current = new HiddenVideoCvEngine(source);
        await writeJob({ engine: "hidden-video" });
        // reset the probe chunk so it re-runs on the fallback engine
        counters.processing = Math.max(0, counters.processing - 1);
        await qWrite("chunk-requeue", () =>
          updateChunk(uid, jobId, `c${pending[0].index}`, { status: "queued" })
        );
      }
    }

    await runPool(pending, cvConcurrencyFor(engineRef.current.kind), processChunk);

    if (ac.signal.aborted) {
      await qWrite("cancel", () => markCancelled(uid, jobId, projectRef));
      return;
    }

    // Merge window VAs → whole-video VA, persist, then the single AI pass.
    if (vaChunks.length > 0) {
      const mergedVa: VisualAnalysis = mergeVisualAnalysis(vaChunks, duration);
      await qWrite("project-va", () =>
        setDoc(
          projectRef,
          { visualAnalysis: mergedVa, updatedAt: serverTimestamp() },
          { merge: true }
        )
      );
    }

    // Requirement #3: finalize must wait until every queued chunk write has
    // landed, so the server reads the complete progressive timeline.
    await flushProjectWrites(pid);

    await writeJob({ status: "running", progress: 1 });
    await finalizeWithAi(project.id, idTokenGetter, {
      chunkCount: windows.length,
      progressiveCount: counters.momentsSoFar,
    });

    // Authoritative terminal write. The finalize route already writes
    // "analyzed"/"complete", but we re-assert it here (idempotent) so the
    // terminal state lands even if the route's write was raced — this is what
    // flips the processing overlay/pill off.
    await qWrite("project-terminal", () =>
      setDoc(
        projectRef,
        {
          status: "analyzed",
          analysis: {
            status: "complete",
            stage: "Complete",
            cancelRequested: false,
          },
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      )
    );
    await writeJob({ status: "complete", completedAt: Date.now(), progress: 1 });
  } catch (err) {
    if (ac.signal.aborted) {
      await qWrite("cancel", () => markCancelled(uid, jobId, projectRef));
      return;
    }
    // Taint → abandon chunking; caller retries on the server-side direct path.
    if (err instanceof CvTaintedError) {
      await qWrite("cancel", () => markCancelled(uid, jobId, projectRef));
      throw err;
    }
    await writeJob({
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    setAnalysisActive(pid, false);
    signal.removeEventListener("abort", onAbort);
    unsubJob();
    engineRef.current.dispose();
  }
}

// ── Deterministic per-chunk moments (event + CV) ───────────────────────────
function deterministicChunkMoments(
  w: { index: number; startTime: number; endTime: number },
  windowVa: VisualAnalysis,
  interactions: Interaction[] | null,
  project: ProjectDoc
): DetectedMoment[] {
  const duration = project.duration ?? 0;
  // Ownership: only emit moments inside this chunk's PRIMARY span so the 2s
  // overlap doesn't double-emit a boundary click (mirrors the VA merge).
  const primaryEnd = Math.min(duration, w.startTime + CHUNK_SIZE_S);

  // 1. Event moments (trusted tab coords only) — already absolute time.
  const trusted =
    project.interactionScope === "tab" && interactions
      ? interactions.filter(
          (e) => eventTime(e) >= w.startTime && eventTime(e) < w.endTime
        )
      : [];
  const eventMoments = trusted.length
    ? momentsFromEvents(trusted, {
        duration,
        scope: project.interactionScope ?? "tab",
      })
    : [];

  // 2. CV moments from the window-local VA → offset to absolute time.
  const localCv = visualMomentsFromCv(
    windowVa,
    w.endTime - w.startTime,
    PROGRESSIVE_MIN_SPACING
  );
  const cvMoments = localCv.map((m, i) => ({
    ...m,
    id: `j${w.index}cv${i}`,
    startTime: m.startTime + w.startTime,
    endTime: m.endTime + w.startTime,
  }));

  const all = [...eventMoments, ...cvMoments]
    .map((m, i) => ({ ...m, id: m.id?.startsWith("j") ? m.id : `j${w.index}e${i}` }))
    .filter((m) => m.startTime < primaryEnd)
    .sort((a, b) => a.startTime - b.startTime);

  return thinBySpacing(all, 1.0);
}

/** Drop moments that start within `minGap`s of an already-kept (higher-attention) one. */
function thinBySpacing(moments: DetectedMoment[], minGap: number): DetectedMoment[] {
  const kept: DetectedMoment[] = [];
  for (const m of moments) {
    const tooClose = kept.some((k) => Math.abs(k.startTime - m.startTime) < minGap);
    if (!tooClose) kept.push(m);
  }
  return kept;
}

function eventTime(e: Interaction): number {
  return e.t;
}

// ── Firestore helpers ──────────────────────────────────────────────────────
// Read-modify-write append. NOT a transaction: every caller funnels through the
// per-project write queue (`enqueueProjectWrite`), so there is never a
// concurrent client write to race — and a plain `setDoc` avoids the write-batch
// commit path that triggers "Another write batch or compaction is already
// active". The server only writes `detectedMoments` during finalize, which the
// orchestrator runs after `flushProjectWrites`, so there's no client/server
// overlap either.
async function appendMoments(
  uid: string,
  projectId: string,
  newMoments: DetectedMoment[]
): Promise<void> {
  if (newMoments.length === 0) return;
  const { db } = getFirebase();
  const ref = doc(db, "users", uid, "projects", projectId);
  const snap = await getDoc(ref);
  const analysis = (snap.data()?.analysis ?? {}) as {
    detectedMoments?: DetectedMoment[];
  };
  const cur = analysis.detectedMoments ?? [];
  const merged = [...cur, ...newMoments].sort((a, b) => a.startTime - b.startTime);
  await setDoc(
    ref,
    {
      analysis: { detectedMoments: stripUndefined(merged) },
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function markCancelled(
  uid: string,
  jobId: string,
  projectRef: ReturnType<typeof doc>
): Promise<void> {
  await updateAnalysisJob(uid, jobId, {
    status: "cancelled",
    cancelRequested: false,
  });
  await setDoc(
    projectRef,
    {
      status: "cancelled",
      analysis: { status: "cancelled", stage: "Cancelled", cancelRequested: false },
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * Trigger the NON-DESTRUCTIVE finalize pass: the progressive timeline is the
 * source of truth — the route preserves all of it and only labels / dedupes /
 * adds a few gap-fills / refreshes metadata. `chunkCount` + `progressiveCount`
 * are passed for the route's before/after diagnostics.
 */
async function finalizeWithAi(
  projectId: string,
  idTokenGetter: () => Promise<string | null>,
  diag: { chunkCount: number; progressiveCount: number }
): Promise<void> {
  const token = await idTokenGetter();
  if (!token) throw new Error("Not signed in.");
  const res = await fetch(`/api/projects/${projectId}/analyze`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      mode: "finalize",
      chunkCount: diag.chunkCount,
      progressiveCount: diag.progressiveCount,
    }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({ error: "Finalize failed" }));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
}

function estimateRemaining(times: number[], remaining: number): number | undefined {
  if (times.length === 0 || remaining <= 0) return undefined;
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return Math.round(avg * remaining);
}

// ── Tiny concurrency pool ──────────────────────────────────────────────────
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      await worker(item);
    }
  });
  await Promise.all(runners);
}
