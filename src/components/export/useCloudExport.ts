"use client";

import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import {
  subscribeExportJobs,
  isJobStale,
  exportUiStage,
  type ExportJobView,
} from "@/lib/firebase/export-jobs";
import { downloadFile } from "@/lib/download";
import type {
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
  ExportUiStage,
  SourceCrop,
  VisualAnalysis,
} from "@/lib/firebase/schema";

/**
 * Server-export client hook (paid plans). Distinct from `ExportProvider`, which
 * owns the in-browser render machinery — server export just creates a Firestore
 * job and follows it.
 *
 * Key behaviors the dialog relies on:
 *   • Follows the EXACT job the user started (`currentJobId`, persisted per
 *     project) — an old/stuck job can never drive the UI or freeze it at a %.
 *   • Auto-downloads the MP4 ONCE, and ONLY for a job the user started or saw
 *     running during THIS page load (the `sessionExportJobIds` arming set). An
 *     old completed export sitting in Firestore is NEVER auto-downloaded on page
 *     load, dialog open, or Firestore hydration — it's offered as a manual
 *     "Download previous export" (`previousExport`) instead.
 *   • Enforces ONE active export per user (friendly block message) — backed up
 *     server-side.
 *   • Friendly stages (Queued → Preparing → Rendering → Uploading → Ready) and a
 *     heartbeat-based "stuck" state for retry/cancel.
 */
export interface StartCloudExportInput {
  projectId: string;
  projectTitle: string;
  resolution: "720p" | "1080p" | "4K";
  fps: 30 | 60;
  format: ExportFormat;
  sourceWidth: number;
  sourceHeight: number;
  sourceDuration: number;
  moments: DetectedMoment[];
  effects: EffectsSettings;
  sourceCrop?: SourceCrop | null;
  visualAnalysis?: VisualAnalysis;
}

export interface StartCloudExportResult {
  ok: boolean;
  jobId?: string;
  error?: string;
  /** "cloud_export_requires_paid" | "cloud_minutes_exhausted" | "export_already_running" | … */
  kind?: string;
  remaining?: number;
  requested?: number;
}

const ACTIVE_STATUSES: ExportJobView["status"][] = [
  "queued",
  "batch_submitted",
  "rendering",
  "uploading",
];

const ALREADY_RUNNING_MSG =
  "You already have an export running. Wait for it to finish or cancel it.";

/** Per-project sessionStorage key for the job the user is currently following. */
function currentKey(projectId: string): string {
  return `framevo.export.current.${projectId}`;
}

/**
 * Jobs the user actively STARTED or OBSERVED RUNNING during this page load.
 *
 * Module-level on purpose: it survives the dialog closing/reopening (the hook
 * remounts) but is wiped on a full page reload. This is the core guarantee —
 * auto-download is "armed" only for jobs in this set, so a completed export
 * loaded fresh from Firestore (page load / dialog open / hydration) is NEVER
 * armed and therefore NEVER auto-downloads.
 */
const sessionExportJobIds = new Set<string>();
/** Jobs already auto-downloaded once this page load (the spam guard). */
const autoDownloadedJobIds = new Set<string>();

/** Fetch + save the job's MP4 under a friendly filename. */
function downloadJobFile(j: ExportJobView): Promise<void> {
  if (!j.downloadUrl) return Promise.resolve();
  const filename = `${(j.projectTitle || "framevo-export").replace(/[^\w.-]+/g, "_")}.mp4`;
  return downloadFile(j.downloadUrl, filename);
}

export function useCloudExport(projectId: string) {
  const { user, getIdToken } = useAuth();
  const uid = user?.uid ?? null;

  const [jobs, setJobs] = React.useState<ExportJobView[]>([]);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The EXACT job the user started in/for this project. Persisted so reopening
  // the dialog keeps following the right job (not "the most recent for project",
  // which would let a stale older job hijack the UI).
  const [currentJobId, setCurrentJobId] = React.useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.sessionStorage.getItem(currentKey(projectId));
  });
  const setCurrent = React.useCallback(
    (id: string | null) => {
      setCurrentJobId(id);
      try {
        if (id) window.sessionStorage.setItem(currentKey(projectId), id);
        else window.sessionStorage.removeItem(currentKey(projectId));
      } catch {
        /* sessionStorage blocked — in-memory state still works this session */
      }
    },
    [projectId]
  );

  React.useEffect(() => {
    if (!uid) {
      setJobs([]);
      return;
    }
    return subscribeExportJobs(uid, setJobs);
  }, [uid]);

  // Tick a clock while anything is active so heartbeat-based `isStale` flips even
  // when Firestore stops updating (a dead worker never writes again).
  const [now, setNow] = React.useState(() => Date.now());
  const anyActive = React.useMemo(
    () => jobs.some((j) => ACTIVE_STATUSES.includes(j.status)),
    [jobs]
  );
  React.useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [anyActive]);

  // The followed job for the live STATUS view: the exact one we started, else
  // this project's most-recent ACTIVE job (so reopening shows an in-flight
  // export). We deliberately do NOT fall back to an old terminal job here — a
  // finished job we didn't start this session belongs in `previousExport`
  // (manual download), never the live status view.
  const job = React.useMemo(() => {
    if (currentJobId) {
      const exact = jobs.find((j) => j.id === currentJobId);
      if (exact) return exact;
    }
    const mine = jobs.filter((j) => j.projectId === projectId);
    return mine.find((j) => ACTIVE_STATUSES.includes(j.status)) ?? null;
  }, [jobs, currentJobId, projectId]);

  const isActive = !!job && ACTIVE_STATUSES.includes(job.status);
  const isStale = !!job && isJobStale(job, now);
  const uiStage: ExportUiStage | null = job ? exportUiStage(job) : null;
  const queuePosition =
    job?.status === "queued" && typeof job.queuePosition === "number" && job.queuePosition > 0
      ? job.queuePosition
      : null;

  // Jobs we watched go ACTIVE during THIS dialog mount. Auto-download fires only
  // for these — so a job that completed while the dialog was CLOSED shows
  // "Export ready" with a manual download on reopen, and never auto-downloads.
  // (Distinct from the module-level `sessionExportJobIds`, which survives
  // remounts and only decides fresh-result vs previous-export styling.)
  const seenActiveThisMount = React.useRef<Set<string>>(new Set());

  // ARM: any followed job we see RUNNING becomes eligible for a one-time
  // auto-download when it completes — but only while THIS dialog stays open.
  React.useEffect(() => {
    if (job && ACTIVE_STATUSES.includes(job.status)) {
      sessionExportJobIds.add(job.id); // survives remount → isSessionResult
      seenActiveThisMount.current.add(job.id); // this mount → auto-download
    }
  }, [job]);

  // A terminal followed job that we STARTED/observed this session = the fresh
  // result to surface in the status view ("Export ready"). A terminal job NOT in
  // the set (e.g. followed only via a persisted id after reload) is treated as a
  // previous export instead.
  const isSessionResult = !!job && !isActive && sessionExportJobIds.has(job.id);

  // ONE active export per user — a non-stale active job (any project) blocks a
  // new start. A stale active job does NOT block (the user can cancel & retry).
  const hasActiveExport = React.useMemo(
    () => jobs.some((j) => ACTIVE_STATUSES.includes(j.status) && !isJobStale(j, now)),
    [jobs, now]
  );

  // Most recent COMPLETED export for this project with a usable download URL,
  // for the manual "Download previous export" affordance. Excluded while it's
  // the fresh on-screen result (so it isn't offered twice).
  const previousExport = React.useMemo<ExportJobView | null>(() => {
    const ready = jobs.filter(
      (j) => j.projectId === projectId && j.status === "ready" && !!j.downloadUrl
    );
    const top = ready[0] ?? null; // subscription is createdAt desc
    if (!top) return null;
    if (job && job.id === top.id && isSessionResult) return null;
    return top;
  }, [jobs, projectId, job, isSessionResult]);

  // ── Frontend logs (poll/complete/error) keyed on the followed job ─────────
  const lastLog = React.useRef<string>("");
  React.useEffect(() => {
    if (!job) return;
    const sig = `${job.id}:${job.status}:${uiStage}:${Math.round((job.progress ?? 0) * 100)}`;
    if (sig === lastLog.current) return;
    lastLog.current = sig;
    if (job.status === "failed") {
      console.error("[export-ui:error]", {
        jobId: job.id,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
      });
    } else if (job.status !== "ready") {
      console.log("[export-ui:poll]", {
        jobId: job.id,
        status: job.status,
        stage: uiStage,
        pct: Math.round((job.progress ?? 0) * 100),
        queuePosition,
      });
    }
  }, [job, uiStage, queuePosition]);

  // ── Auto-download ONCE on completion — ONLY for this session's export ──────
  const [downloadStarted, setDownloadStarted] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);

  React.useEffect(() => {
    if (!job || job.status !== "ready" || !job.downloadUrl) return;
    // Gate strictly: only auto-download a job we watched go active→ready in THIS
    // open dialog. Never for old Firestore exports, hydration, or a job that
    // finished while the dialog was closed (those get a manual download).
    if (!seenActiveThisMount.current.has(job.id)) return;
    if (autoDownloadedJobIds.has(job.id)) {
      setDownloadStarted(true); // already handled — keep the "ready" copy honest
      return;
    }
    autoDownloadedJobIds.add(job.id);
    console.log("[export-ui:complete]", { jobId: job.id, auto: true });
    setDownloading(true);
    setDownloadStarted(true);
    void downloadJobFile(job).finally(() => setDownloading(false));
  }, [job]);

  // Manual re-download of the CURRENT result — spam-proof (disabled + "Preparing…"
  // while the bytes fetch).
  const downloadAgain = React.useCallback(() => {
    if (!job || !job.downloadUrl || downloading) return;
    setDownloading(true);
    setDownloadStarted(true);
    void downloadJobFile(job).finally(() => setDownloading(false));
  }, [job, downloading]);

  // Manual download of a PREVIOUS completed export — always manual, never auto.
  const [downloadingPrevious, setDownloadingPrevious] = React.useState(false);
  const downloadPrevious = React.useCallback(() => {
    if (!previousExport || !previousExport.downloadUrl || downloadingPrevious) return;
    setDownloadingPrevious(true);
    void downloadJobFile(previousExport).finally(() => setDownloadingPrevious(false));
  }, [previousExport, downloadingPrevious]);

  const startCloudExport = React.useCallback(
    async (input: StartCloudExportInput): Promise<StartCloudExportResult> => {
      setError(null);
      // Client-side single-flight guard (the server is authoritative too).
      if (hasActiveExport) {
        setError(ALREADY_RUNNING_MSG);
        return { ok: false, error: ALREADY_RUNNING_MSG, kind: "export_already_running" };
      }
      setStarting(true);
      // A fresh export starts a fresh download cycle.
      setDownloadStarted(false);
      try {
        const token = await getIdToken();
        if (!token) {
          const msg = "Sign in to export.";
          setError(msg);
          return { ok: false, error: msg };
        }
        const res = await fetch("/api/export/cloud", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(input),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          jobId?: string;
          error?: string;
          kind?: string;
          remaining?: number;
          requested?: number;
        };
        if (!res.ok || !data.ok) {
          const msg =
            data.kind === "cloud_export_requires_paid"
              ? "MP4 export needs a Pro or Creator plan."
              : data.kind === "cloud_minutes_exhausted"
                ? `Out of export minutes this month (need ${data.requested}, have ${data.remaining}).`
                : data.kind === "export_already_running"
                  ? ALREADY_RUNNING_MSG
                  : data.error || `Couldn't start the export (${res.status}).`;
          setError(msg);
          return {
            ok: false,
            error: msg,
            kind: data.kind,
            remaining: data.remaining,
            requested: data.requested,
          };
        }
        if (data.jobId) {
          console.log("[export-ui:create]", { jobId: data.jobId, projectId: input.projectId });
          // ARM this exact job for a one-time auto-download on completion (both
          // sets: module → "Export ready" styling, mount ref → auto-download).
          sessionExportJobIds.add(data.jobId);
          seenActiveThisMount.current.add(data.jobId);
          setCurrent(data.jobId); // FOLLOW exactly this job
        }
        return { ok: true, jobId: data.jobId };
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Couldn't reach the export service.";
        setError(msg);
        return { ok: false, error: msg };
      } finally {
        setStarting(false);
      }
    },
    [getIdToken, hasActiveExport, setCurrent]
  );

  const cancelCloudExport = React.useCallback(async () => {
    if (!job) return;
    try {
      const token = await getIdToken();
      if (!token) return;
      await fetch("/api/export/cancel", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jobId: job.id }),
      });
      // Stop following the canceled job so the dialog frees up for a fresh export.
      if (job.id === currentJobId) setCurrent(null);
    } catch (err) {
      console.warn("[export-ui:error] cancel failed", err);
    }
  }, [getIdToken, job, currentJobId, setCurrent]);

  return {
    job,
    uiStage,
    isActive,
    isStale,
    starting,
    error,
    queuePosition,
    hasActiveExport,
    /** True when the followed terminal job is THIS session's export (a fresh
     *  result to show as "Export ready") — vs an old completed export. */
    isSessionResult,
    /** Most recent completed export for this project (manual download only). */
    previousExport,
    alreadyRunningMessage: ALREADY_RUNNING_MSG,
    startCloudExport,
    cancelCloudExport,
    /** Stop following the current job (return the dialog to settings) without canceling it. */
    dismiss: React.useCallback(() => setCurrent(null), [setCurrent]),
    // download
    downloadStarted,
    downloading,
    downloadAgain,
    downloadingPrevious,
    downloadPrevious,
    clearError: React.useCallback(() => setError(null), []),
  };
}
