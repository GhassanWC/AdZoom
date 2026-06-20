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
 *   • Enforces ONE active export per user (friendly block message) — backed up
 *     server-side.
 *   • Auto-downloads the MP4 ONCE on completion, with a spam-proof "Download
 *     again" (disabled + "Preparing…" while the bytes fetch).
 *   • Friendly stages (Queued → Preparing → Rendering → Uploading → Ready) and a
 *     heartbeat-based "stuck" state for retry/cancel.
 */
export interface StartCloudExportInput {
  projectId: string;
  projectTitle: string;
  resolution: "1080p" | "4K";
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

const ACTIVE_STATUSES: ExportJobView["status"][] = ["queued", "rendering", "uploading"];

const ALREADY_RUNNING_MSG =
  "You already have an export running. Wait for it to finish or cancel it.";

/** Per-project sessionStorage key for the job the user is currently following. */
function currentKey(projectId: string): string {
  return `framevo.export.current.${projectId}`;
}

/** Once-guards for auto-download, so a completed job downloads exactly once even
 *  across dialog reopens (component remounts). */
function wasAutoDownloaded(jobId: string): boolean {
  try {
    return window.sessionStorage.getItem(`framevo.export.autodl.${jobId}`) === "1";
  } catch {
    return false;
  }
}
function markAutoDownloaded(jobId: string): void {
  try {
    window.sessionStorage.setItem(`framevo.export.autodl.${jobId}`, "1");
  } catch {
    /* ignore */
  }
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

  // The followed job: the exact one we started, else the most recent ACTIVE job
  // for this project (so reopening shows an in-flight export), else the most
  // recent job for the project (to show the last result). A terminal followed
  // job is fine — it shows the result and never blocks a new export.
  const job = React.useMemo(() => {
    if (currentJobId) {
      const exact = jobs.find((j) => j.id === currentJobId);
      if (exact) return exact;
    }
    const mine = jobs.filter((j) => j.projectId === projectId);
    return mine.find((j) => ACTIVE_STATUSES.includes(j.status)) ?? mine[0] ?? null;
  }, [jobs, currentJobId, projectId]);

  const isActive = !!job && ACTIVE_STATUSES.includes(job.status);
  const isStale = !!job && isJobStale(job, now);
  const uiStage: ExportUiStage | null = job ? exportUiStage(job) : null;
  const queuePosition =
    job?.status === "queued" && typeof job.queuePosition === "number" && job.queuePosition > 0
      ? job.queuePosition
      : null;

  // ONE active export per user — a non-stale active job (any project) blocks a
  // new start. A stale active job does NOT block (the user can cancel & retry).
  const hasActiveExport = React.useMemo(
    () => jobs.some((j) => ACTIVE_STATUSES.includes(j.status) && !isJobStale(j, now)),
    [jobs, now]
  );

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

  // ── Auto-download ONCE on completion ──────────────────────────────────────
  const [downloadStarted, setDownloadStarted] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const autoDownloadedFor = React.useRef<string | null>(null);

  const runDownload = React.useCallback(
    async (j: ExportJobView) => {
      if (!j.downloadUrl) return;
      setDownloading(true);
      const filename = `${(j.projectTitle || "framevo-export").replace(/[^\w.-]+/g, "_")}.mp4`;
      try {
        await downloadFile(j.downloadUrl, filename);
        setDownloadStarted(true);
      } finally {
        setDownloading(false);
      }
    },
    []
  );

  React.useEffect(() => {
    if (!job || job.status !== "ready" || !job.downloadUrl) return;
    if (autoDownloadedFor.current === job.id) return;
    // Guard across dialog reopens (remounts) so a completed job auto-downloads
    // EXACTLY once, never every time the panel reopens.
    if (wasAutoDownloaded(job.id)) {
      autoDownloadedFor.current = job.id;
      setDownloadStarted(true);
      return;
    }
    autoDownloadedFor.current = job.id;
    markAutoDownloaded(job.id);
    console.log("[export-ui:complete]", { jobId: job.id, downloadUrl: "(set)" });
    void runDownload(job);
  }, [job, runDownload]);

  // Manual re-download — spam-proof (disabled + "Preparing…" while it runs).
  const downloadAgain = React.useCallback(() => {
    if (!job || downloading) return;
    void runDownload(job);
  }, [job, downloading, runDownload]);

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
          autoDownloadedFor.current = null; // allow auto-download for the new job
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
    /** True when the user is FOLLOWING a specific job for this project (started
     *  it this session or has a persisted current job) — vs a passive fallback. */
    following: currentJobId != null,
    alreadyRunningMessage: ALREADY_RUNNING_MSG,
    startCloudExport,
    cancelCloudExport,
    /** Stop following the current job (return the dialog to settings) without canceling it. */
    dismiss: React.useCallback(() => setCurrent(null), [setCurrent]),
    // download
    downloadStarted,
    downloading,
    downloadAgain,
    clearError: React.useCallback(() => setError(null), []),
  };
}
