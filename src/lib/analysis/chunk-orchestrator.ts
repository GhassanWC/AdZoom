"use client";

import {
  arrayUnion,
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
  AudioAnalysis,
  DetectedMoment,
  ProjectDoc,
  SelectedVideoType,
  VisualAnalysis,
} from "../firebase/schema";
import { analyzeAudio } from "../audio/analyze-audio";
import {
  resolveEditRecipe,
  editGenerationControls,
  disablesAllImplementedEdits,
  type CategoryControl,
} from "./edit-recipe";
import type { Interaction } from "../recording/types";
import { momentsFromEvents } from "../attention/events";
import { CvTaintedError } from "../cv/types";
import { visualMomentsFromCv } from "../cv/visual-moments";
import { mergeVisualAnalysis, type VaChunk } from "../cv/merge";
import { selectCvEngine, cvConcurrencyFor } from "../cv/engine/select";
import { HiddenVideoCvEngine } from "../cv/engine/hidden-video";
import type { CvChunkEngine, CvChunkRequest, CvSource } from "../cv/engine/types";
import {
  CHUNK_CV_NO_PROGRESS_MS,
  CHUNK_MAX_ATTEMPTS,
  CHUNK_PROGRESS_WRITE_MS,
  CHUNK_SIZE_S,
  type ChunkWindow,
  chunkWindows,
  clampChunkSize,
} from "./chunk-config";
import { cutSectionsForChunk } from "./cut-engine";
import { speedSectionsForChunk } from "./speed-engine";
import {
  type AnalysisOptions,
  aiLayersPresent,
  DEFAULT_ANALYSIS_OPTIONS,
  shouldRunLayer,
} from "./engine-layers";
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
import { logFramevoEvent } from "../firebase/analytics";
import { EVENTS } from "../analytics/events";

/** A job updated within this window is treated as "actively driven" elsewhere. */
const ACTIVE_JOB_HEARTBEAT_MS = 45_000;

/** Per-chunk minimum spacing for the CV backstop (progressive draft only). */
const PROGRESSIVE_MIN_SPACING = 6;

/**
 * Which phase of a chunked run a failure came from.
 *
 * `start` is everything before the chunk pool (duration, engine selection, job
 * creation) — those throw raw Errors, so an UNTAGGED throw is a start failure.
 * The caller renders this verbatim: a finalize-stage 404 once surfaced as
 * "Chunked analysis failed to start", which points debugging at the wrong end
 * of the pipeline entirely.
 */
export type ChunkedPhase = "start" | "chunking" | "finalizing";

/** A chunked-run failure tagged with the phase it actually happened in. */
export class ChunkedAnalysisError extends Error {
  readonly phase: ChunkedPhase;
  constructor(message: string, phase: ChunkedPhase) {
    super(message);
    this.name = "ChunkedAnalysisError";
    this.phase = phase;
  }
}

/**
 * Outcome of a chunked run. `finalizeError` is a DEGRADE, not a failure: the
 * progressive CV timeline is the source of truth and is already on screen, so
 * the run still completes — the caller decides whether the degrade is worth
 * telling the user about (see `momentsAdded`).
 */
export interface ChunkedRunResult {
  outcome: "completed" | "cancelled" | "mirrored";
  /**
   * Moments THIS run appended. Explicitly NOT the timeline total: carry-over
   * from earlier runs is seeded straight into the project doc and never counted
   * here, so a full-looking timeline can still report 0 added.
   */
  momentsAdded: number;
  /** Set when the best-effort server refinement pass failed. */
  finalizeError?: string;
}

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
  /** Which engines to run + how to treat existing edits (from the dialog). */
  options: AnalysisOptions;
  /**
   * Moments to PRESERVE on a fresh run — seeds the reset write instead of
   * clearing to []. Ignored on resume (the reset is skipped).
   */
  carryOver?: DetectedMoment[];
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
export async function runChunkedAnalysis(
  args: ChunkedRunArgs
): Promise<ChunkedRunResult> {
  const { uid, project, interactions, idTokenGetter, signal, onJob } = args;
  const resume = args.resume === true;
  const options = args.options ?? DEFAULT_ANALYSIS_OPTIONS;
  const chunkSize = clampChunkSize(options.chunkSizeSeconds ?? CHUNK_SIZE_S);
  const carryOver = args.carryOver ?? [];
  // Which layers already hold AI edits — drives "keep" mode (only fill empty
  // layers). In "keep" mode carryOver is the full current timeline; otherwise
  // it has had the regenerated layers stripped, so fall back to the live doc.
  const existingAiLayers = aiLayersPresent(
    carryOver.length ? carryOver : project.analysis?.detectedMoments ?? []
  );

  // ── Edit Recipe Engine → real generation controls ─────────────────────────
  // Resolve the recipe for the selected type (missing → "auto"), reduce it to
  // gate + intensity knobs for the IMPLEMENTED engines, and FOLD its gating into
  // the engine options so both the per-chunk engines below AND the server
  // finalize (via shouldRunLayer) honor it. A missing plan → baseline controls
  // (old behavior). Never lets the recipe disable EVERY edit (fallback → cuts).
  const selectedVideoType: SelectedVideoType = options.selectedVideoType ?? "auto";
  const recipePlan = resolveEditRecipe({
    selectedVideoType,
    signals: {
      // The orchestrator resolves the recipe BEFORE audio/transcript run — it
      // only gates the audio-independent cut/zoom/speed engines. The finalize
      // route re-resolves with the REAL transcript + audio signals (that plan is
      // the stored one that drives captions / silence).
      hasTranscript: false,
      hasAudioAnalysis: false,
      hasUsableSpeech: false,
      silenceSegmentCount: 0,
      hasSceneData: true, // CV produces scene changes
      hasVisualMoments: true, // CV produces zoom/callout targets
      hasInteractionData:
        project.interactionScope === "tab" || (interactions?.length ?? 0) > 0,
      isScreenRecording:
        selectedVideoType === "screen-recording" || project.interactionScope === "tab",
      durationSeconds: project.duration ?? undefined,
    },
  });
  let controls = editGenerationControls(recipePlan);
  let recipeFallback = false;
  if (disablesAllImplementedEdits(controls)) {
    // Fallback protection — never produce an empty timeline: keep safe cuts.
    recipeFallback = true;
    controls = {
      ...controls,
      cut: {
        enabled: true,
        intensity: 0.5,
        reason: "fallback: recipe disabled all edits — keeping safe cuts",
      },
    };
  }
  const recipeOptions: AnalysisOptions = {
    ...options,
    generateCameraEdits: options.generateCameraEdits && controls.zoom.enabled,
    generateCut: options.generateCut && controls.cut.enabled,
    generateSpeed: options.generateSpeed && controls.speed.enabled,
  };

  const runCamera = shouldRunLayer("camera", recipeOptions, existingAiLayers);
  const runCut = shouldRunLayer("cut", recipeOptions, existingAiLayers);
  const runSpeed = shouldRunLayer("speed", recipeOptions, existingAiLayers);
  const skippedPlanned = recipePlan.operations.filter((o) => o.planned).map((o) => o.category);
  console.info("[edit-recipe:generation]", {
    projectId: project.id,
    requestedVideoType: controls.requestedVideoType,
    effectiveVideoType: controls.effectiveVideoType,
    recipe: controls.recipeName,
    fromRecipe: controls.fromRecipe,
    cut: { enabled: runCut, intensity: controls.cut.intensity, reason: controls.cut.reason },
    zoom: { enabled: runCamera, intensity: controls.zoom.intensity, reason: controls.zoom.reason },
    speed: { enabled: runSpeed, intensity: controls.speed.intensity, reason: controls.speed.reason },
    skippedPlanned,
    fallback: recipeFallback,
  });
  const { db } = getFirebase();
  const pid = project.id;
  const projectRef = doc(db, "users", uid, "projects", pid);
  const duration = project.duration ?? 0;
  if (duration <= 0) throw new Error("Unknown duration — cannot chunk.");

  const windows = chunkWindows(duration, chunkSize);
  const jobId = `job_${project.id}`;

  // ── Phase 4: audio intelligence (silence / loudness) ──────────────────────
  // Kicked off concurrently with the CV chunks (Web Audio, no API key). Result
  // is handed to the finalize pass, which stores it + uses it for the caption /
  // silence-removal recipe signals. Best-effort: `analyzeAudio` NEVER throws, so
  // this can't break the analysis pipeline.
  const audioAnalysisPromise = analyzeAudio(project.originalVideoUrl, duration, signal);

  // Production-safe diagnostics (console.* ships to prod). The resolved chunk
  // config makes a mis-routed run obvious end-to-end without devtools setup.
  console.info("[chunk-config]", {
    projectId: project.id,
    duration,
    chunkSize,
    chunkMode: options.chunkMode,
    chunkCount: windows.length,
    resume,
    runCamera,
    runCut,
    runSpeed,
  });

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
      // Another tab is already driving this job — mirror its state, don't start
      // a competing run. Logged so this isn't mistaken for a real start.
      console.info("[chunk-mirror]", { projectId: project.id, jobId: active.id });
      onJob?.(active);
      return { outcome: "mirrored", momentsAdded: active.momentsSoFar };
    }
  }

  // Engine selection (WebCodecs primary, hidden-video fallback). Held in a ref
  // so a probe failure can hot-swap to the proven engine without aborting.
  const source: CvSource = {
    url: project.originalVideoUrl,
    mimeType: project.mimeType,
    sourceCrop: project.sourceCrop,
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
    chunkSize,
    chunkMode: options.chunkMode,
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

  // The run has truly started (job doc created, engine resolved, not a mirror).
  console.info("[chunk-start]", {
    projectId: project.id,
    jobId,
    engine: job.engine,
    chunkSize: job.chunkSize,
    chunkMode: job.chunkMode,
    chunkCount: job.chunkCount,
    duration: job.duration,
    resume: resuming,
  });
  logFramevoEvent(EVENTS.CHUNKED_ANALYSIS_STARTED, {
    engine: job.engine,
    chunkMode: job.chunkMode ?? null,
    chunkSize: job.chunkSize,
    chunkCount: job.chunkCount,
    duration: Math.round(job.duration),
    resume: resuming,
  });

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
    // Fresh run → seed the timeline with the carry-over set (per the chosen
    // existingEditMode) so progressive appends accumulate ON TOP of preserved
    // edits. `appendMoments` concats onto this, so disabled/non-selected layers
    // and all user edits survive the run.
    await qWrite("project-reset", () =>
      setDoc(
        projectRef,
        {
          status: "analyzing",
          analysis: {
            status: "analyzing",
            stage: "Analyzing in chunks",
            detectedMoments: stripUndefined(carryOver),
            // Recipe-gated options so the finalize pass + timeline labels reflect
            // which layers the recipe actually enabled for this run.
            lastRunOptions: recipeOptions,
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
    // Per-layer totals for the one-line [chunk-summary] (prod-safe diagnostics).
    cameraMoments: 0,
    cutMoments: 0,
    speedMoments: 0,
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
    w: ChunkWindow,
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
        // Bounded by a no-progress watchdog so an undecodable video (unsupported
        // codec, metadata that never loads, a silent WebCodecs worker) can't hang
        // the whole analysis at chunk 1 / 0% forever — it throws, and the retry /
        // probe-fallback / mark-failed path below takes over.
        const va = await analyzeChunkBounded(
          engineRef.current,
          {
            startTime: w.startTime,
            endTime: w.endTime,
            duration,
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
          },
          ac.signal,
          CHUNK_CV_NO_PROGRESS_MS
        );

        // Three engines per chunk: zoom/focus (camera) + cut + speed. Each is
        // gated on the user's selection (`runCamera/runCut/runSpeed`); a
        // disabled engine is skipped entirely (no empty moments). The VA above
        // always runs — it's needed for the whole-video merge + finalize.
        // Order matters: camera → cut → speed. Cut claims the deadest ranges and
        // is fed to speed so a range is never both cut AND sped. Both cut and
        // speed carve protective buffers around the camera edits.
        // Recipe intensity tunes each engine (0.5 = baseline). Zoom density is
        // tuned in deterministicChunkMoments; cut/speed pass intensity through.
        const zoom = runCamera
          ? deterministicChunkMoments(w, va, interactions, project, controls.zoom.intensity)
          : [];
        const primaryEnd = w.primaryEnd;
        const cutRes = runCut
          ? cutSectionsForChunk(va, w, project, zoom, primaryEnd, controls.cut.intensity)
          : { sections: [] as DetectedMoment[], diag: undefined };
        const speedRes = runSpeed
          ? speedSectionsForChunk(va, w, project, zoom, cutRes.sections, primaryEnd, controls.speed.intensity)
          : { sections: [] as DetectedMoment[], diag: undefined };
        // Stamp recipe provenance (additive — keeps existing source/provenance)
        // so every generated edit explains which recipe + category produced it.
        const moments = controls.fromRecipe
          ? [
              ...stampRecipe(zoom, "zoom", controls.effectiveVideoType, controls.zoom),
              ...stampRecipe(cutRes.sections, "cut", controls.effectiveVideoType, controls.cut),
              ...stampRecipe(speedRes.sections, "speed", controls.effectiveVideoType, controls.speed),
            ]
          : [...zoom, ...cutRes.sections, ...speedRes.sections];
        if (process.env.NODE_ENV !== "production") {
          const cell = (run: boolean, n: number) => (run ? String(n) : "skipped");
          console.info(
            `[chunk ${w.index}] camera: ${cell(runCamera, zoom.length)} | cut: ${cell(
              runCut,
              cutRes.sections.length
            )} | speed: ${cell(runSpeed, speedRes.sections.length)}`,
            { cut: cutRes.diag, speed: speedRes.diag }
          );
        }

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
        counters.cameraMoments += zoom.length;
        counters.cutMoments += cutRes.sections.length;
        counters.speedMoments += speedRes.sections.length;
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
  // Tracks what we're doing so the outer catch can attribute a failure to the
  // right phase instead of blaming the start of the run. Everything before this
  // point is the "start" phase and throws untagged.
  let phase: ChunkedPhase = "chunking";
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
        // Legitimate, silent degrade (NOT a failure): the probe couldn't drive
        // WebCodecs for this codec/browser, so we fall back to the proven
        // hidden-video engine and keep going. Logged for visibility only.
        console.info("[chunk-engine-swap] webcodecs → hidden-video", {
          projectId: project.id,
          jobId,
          reason: probeErr instanceof Error ? probeErr.message : String(probeErr),
        });
        // reset the probe chunk so it re-runs on the fallback engine
        counters.processing = Math.max(0, counters.processing - 1);
        await qWrite("chunk-requeue", () =>
          updateChunk(uid, jobId, `c${pending[0].index}`, { status: "queued" })
        );
      }
    }

    await runPool(pending, cvConcurrencyFor(engineRef.current.kind), processChunk);

    // One prod-safe summary line per run (engine actually used, per-layer
    // totals, wall time) — replaces the dev-only per-chunk log for prod.
    console.info("[chunk-summary]", {
      projectId: project.id,
      jobId,
      engine: engineRef.current.kind,
      chunkCount: windows.length,
      completed: counters.completed,
      failed: counters.failed,
      momentsTotal: counters.momentsSoFar,
      camera: counters.cameraMoments,
      cut: counters.cutMoments,
      speed: counters.speedMoments,
      durationMs: chunkTimes.reduce((a, b) => a + b, 0),
      aborted: ac.signal.aborted,
    });

    if (ac.signal.aborted) {
      await qWrite("cancel", () => markCancelled(uid, jobId, projectRef));
      return { outcome: "cancelled", momentsAdded: counters.momentsSoFar };
    }

    // Every chunk is in. From here on it's wrap-up (VA merge, audio, the
    // best-effort server refinement, terminal writes) — a failure in any of it
    // is a LATE failure, not a failure to start.
    phase = "finalizing";

    // Merge window VAs → whole-video VA, persist, then the single AI pass.
    if (vaChunks.length > 0) {
      const mergedVa: VisualAnalysis = mergeVisualAnalysis(vaChunks, duration, chunkSize);
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
    // Await the audio pass (already running); pass it to finalize so the server
    // stores it + gates captions / silence removal. Never throws.
    const audioAnalysis = await audioAnalysisPromise;
    console.info("[audio:analysis]", {
      projectId: project.id,
      status: audioAnalysis.status,
      hasUsableSpeech: audioAnalysis.hasUsableSpeech,
      silenceSegments: audioAnalysis.silenceSegments?.length ?? 0,
      longPauses: audioAnalysis.longPauses?.length ?? 0,
      totalSilenceSeconds: audioAnalysis.totalSilenceSeconds ?? 0,
    });
    // Finalize (the server-side Gemini refinement: classification, labels,
    // gap-fill) is BEST-EFFORT and NEVER fatal — the progressive CV timeline is
    // already the source of truth and is already on the user's screen. A
    // failure here costs AI labels / gap-fill, not the run, so it DEGRADES:
    // recorded as a `warn` activity event (the same channel the analyze route
    // uses for its own partial degrades, e.g. a failed gap-fill call) and
    // returned to the caller. It is deliberately NOT rethrown on a zero-edit
    // run: that made a late refinement failure look like the whole analysis had
    // failed to start, which is the opposite of where the fault was. The caller
    // decides whether a zero-edit outcome is worth surfacing.
    let finalizeError: string | undefined;
    try {
      await finalizeWithAi(project.id, idTokenGetter, {
        chunkCount: windows.length,
        progressiveCount: counters.momentsSoFar,
        // Recipe-gated so the server's gap-fill can't re-add a recipe-disabled layer.
        options: recipeOptions,
        audioAnalysis,
      });
    } catch (finalizeErr) {
      finalizeError =
        finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr);
      console.warn("[chunk-finalize] refinement failed — completing with progressive edits", {
        projectId: project.id,
        momentsSoFar: counters.momentsSoFar,
        error: finalizeError,
      });
      // Persisted so the degrade is inspectable after the fact (Firestore
      // `analysis.activity[]`) without devtools open at the time. Deep-merges
      // onto `analysis` — it must not touch any other field of that map.
      const warnText = `AI refinement skipped — ${finalizeError}`;
      await qWrite("finalize-warn", () =>
        setDoc(
          projectRef,
          {
            analysis: {
              activity: arrayUnion({ ts: Date.now(), kind: "warn", text: warnText }),
            },
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        )
      ).catch(() => {
        /* the warning is diagnostics — never let it fail the run it describes */
      });
    }

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
    logFramevoEvent(EVENTS.CHUNKED_ANALYSIS_COMPLETED, {
      chunkCount: job.chunkCount,
      chunkMode: job.chunkMode ?? null,
      duration: Math.round(job.duration),
    });
    return {
      outcome: "completed",
      momentsAdded: counters.momentsSoFar,
      ...(finalizeError ? { finalizeError } : {}),
    };
  } catch (err) {
    if (ac.signal.aborted) {
      await qWrite("cancel", () => markCancelled(uid, jobId, projectRef));
      return { outcome: "cancelled", momentsAdded: counters.momentsSoFar };
    }
    // Taint → abandon chunking; caller retries on the server-side direct path.
    // Rethrown UNWRAPPED so `instanceof CvTaintedError` checks upstream still
    // fire (the caller maps it to the chunking phase itself).
    if (err instanceof CvTaintedError) {
      await qWrite("cancel", () => markCancelled(uid, jobId, projectRef));
      throw err;
    }
    await writeJob({
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    // Tag with the phase we died in so the caller can say WHERE it broke.
    throw err instanceof ChunkedAnalysisError
      ? err
      : new ChunkedAnalysisError(
          err instanceof Error ? err.message : String(err),
          phase
        );
  } finally {
    setAnalysisActive(pid, false);
    signal.removeEventListener("abort", onAbort);
    unsubJob();
    engineRef.current.dispose();
  }
}

// ── Deterministic per-chunk moments (event + CV) ───────────────────────────
function deterministicChunkMoments(
  w: ChunkWindow,
  windowVa: VisualAnalysis,
  interactions: Interaction[] | null,
  project: ProjectDoc,
  /** Recipe zoom intensity (0..1). 0.5 = baseline spacing. Higher → denser
   *  (more punch-in zooms); lower → sparser (subtler). */
  zoomIntensity = 0.5
): DetectedMoment[] {
  const duration = project.duration ?? 0;
  // Ownership: only emit moments inside this chunk's PRIMARY span so the 2s
  // overlap doesn't double-emit a boundary click (mirrors the VA merge).
  const primaryEnd = w.primaryEnd;

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

  // Zoom density from recipe intensity: baseline 1.0s spacing at 0.5; denser
  // (down to ~0.4s) at high intensity, sparser (up to ~1.6s) at low.
  const i = zoomIntensity < 0 ? 0 : zoomIntensity > 1 ? 1 : zoomIntensity;
  const spacing = 1.6 - 1.2 * i;
  return thinBySpacing(all, spacing);
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

/** Stamp recipe provenance on generated moments (additive — keeps `source`/`provenance`). */
function stampRecipe(
  moments: DetectedMoment[],
  category: "cut" | "zoom" | "speed",
  recipeType: string,
  control: CategoryControl
): DetectedMoment[] {
  return moments.map((m) => ({
    ...m,
    recipe: {
      source: "recipe" as const,
      recipeType,
      category,
      reason: control.reason,
      intensity: control.intensity,
    },
  }));
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
  diag: {
    chunkCount: number;
    progressiveCount: number;
    options: AnalysisOptions;
    audioAnalysis?: AudioAnalysis;
  }
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
      // So the finalize pass can't re-introduce a disabled layer via gap-fill.
      analysisOptions: diag.options,
      // Phase 4 — client-computed audio intelligence for the finalize recipe +
      // caption/silence gates (the server has no Web Audio).
      audioAnalysis: diag.audioAnalysis ?? null,
    }),
  });
  if (!res.ok) {
    // Surface the REAL server error. The route returns `{ error }` JSON on a
    // handled failure; on an unhandled 500 / timeout the body may be HTML, so
    // read it as text and include a snippet instead of a useless "Finalize failed".
    const bodyText = await res.text().catch(() => "");
    let serverMsg = "";
    try {
      serverMsg = (JSON.parse(bodyText) as { error?: string }).error ?? "";
    } catch {
      /* non-JSON (HTML error page) — fall back to the raw snippet */
    }
    const detail = serverMsg || bodyText.replace(/\s+/g, " ").trim().slice(0, 300) || `HTTP ${res.status}`;
    // WARN, not error: the caller (runChunkedAnalysis) catches this and completes
    // with the progressive edits, so it's a handled, non-fatal degrade — a
    // console.error here would trip Next.js's dev error overlay for a recovered case.
    console.warn("[finalize] failed", { projectId, status: res.status, detail });
    throw new Error(`Finalize failed (${res.status}): ${detail}`);
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

/**
 * Run one chunk's CV pass with a sliding NO-PROGRESS watchdog. If the engine
 * makes no progress within `noProgressMs` — a decode/demux/metadata hang on a
 * video the on-device decoder can't handle (unsupported codec, HEVC, metadata
 * that never loads, a silent WebCodecs worker) — abort it (which terminates the
 * worker / cancels the seek) and REJECT, so `processChunk`'s retry /
 * probe-fallback / mark-failed logic runs instead of hanging the whole analysis
 * forever. The per-run `runSignal` (cancel) still aborts too. Any engine
 * `onProgress` re-arms the watchdog, so a slow-but-progressing chunk isn't killed.
 */
async function analyzeChunkBounded(
  engine: CvChunkEngine,
  req: Omit<CvChunkRequest, "signal">,
  runSignal: AbortSignal,
  noProgressMs: number
): Promise<VisualAnalysis> {
  const chunkAc = new AbortController();
  const onRunAbort = () => chunkAc.abort();
  if (runSignal.aborted) chunkAc.abort();
  else runSignal.addEventListener("abort", onRunAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectWatchdog: ((e: Error) => void) | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      chunkAc.abort();
      rejectWatchdog?.(new Error("chunk_cv_no_progress_timeout"));
    }, noProgressMs);
  };
  const watchdog = new Promise<never>((_, rej) => {
    rejectWatchdog = rej;
  });
  arm();
  try {
    return await Promise.race([
      engine.analyzeChunk({
        ...req,
        signal: chunkAc.signal,
        onProgress: (p: number) => {
          arm();
          req.onProgress?.(p);
        },
      }),
      watchdog,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    runSignal.removeEventListener("abort", onRunAbort);
  }
}
