"use client";

import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import {
  subscribeExportJobs,
  type ExportJobView,
} from "@/lib/firebase/export-jobs";
import type {
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
  SourceCrop,
  VisualAnalysis,
} from "@/lib/firebase/schema";

/**
 * Cloud-export client hook (paid plans). Distinct from `ExportProvider`, which
 * owns the browser render machinery (offscreen <video>, rAF, AbortController) —
 * cloud export has none of that: it POSTs a job and watches Firestore.
 *
 * For the given project it surfaces the MOST RECENT cloud job (in-flight or
 * done) from `users/{uid}/exportJobs`, so the panel reflects live status even
 * after the modal is closed + reopened. `startCloudExport` creates a job;
 * `cancelCloudExport` flags it for the worker to stop.
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
  /** "cloud_export_requires_paid" | "cloud_minutes_exhausted" | "dispatch_failed" | … */
  kind?: string;
  remaining?: number;
  requested?: number;
}

const ACTIVE_STATUSES: ExportJobView["status"][] = ["queued", "rendering", "uploading"];

export function useCloudExport(projectId: string) {
  const { user, getIdToken } = useAuth();
  const uid = user?.uid ?? null;

  const [jobs, setJobs] = React.useState<ExportJobView[]>([]);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!uid) {
      setJobs([]);
      return;
    }
    return subscribeExportJobs(uid, setJobs);
  }, [uid]);

  // Most recent cloud job for THIS project (the list is createdAt desc).
  const job = React.useMemo(
    () => jobs.find((j) => j.projectId === projectId) ?? null,
    [jobs, projectId]
  );
  const isActive = !!job && ACTIVE_STATUSES.includes(job.status);

  const startCloudExport = React.useCallback(
    async (input: StartCloudExportInput): Promise<StartCloudExportResult> => {
      setError(null);
      setStarting(true);
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
              ? "Cloud MP4 export needs a Pro or Creator plan."
              : data.kind === "cloud_minutes_exhausted"
                ? `Out of cloud export minutes this month (need ${data.requested}, have ${data.remaining}).`
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
    [getIdToken]
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
    } catch (err) {
      console.warn("[cloud-export] cancel failed", err);
    }
  }, [getIdToken, job]);

  return {
    job,
    isActive,
    starting,
    error,
    startCloudExport,
    cancelCloudExport,
    clearError: React.useCallback(() => setError(null), []),
  };
}
