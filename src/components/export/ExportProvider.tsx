"use client";

import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { useNotifications } from "@/lib/notifications/store";
import {
  renderProjectClientSide,
  uploadExport,
  pickedMimeExt,
} from "@/components/dashboard/real-editor/export";
import type {
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
  VisualAnalysis,
} from "@/lib/firebase/schema";

/**
 * Session-level export lifecycle owner.
 *
 * Mounted at the Shell level (like `RecordingProvider`) so an export OUTLIVES
 * the export modal AND page navigation. It owns its OWN offscreen `<video>`
 * (built from the project's source URL) so the render is fully decoupled from
 * the editor preview — the user can keep editing or move around the app while
 * the export runs. One export at a time (single-flight). Cancellation flows
 * through the renderer's `AbortSignal`, which now tears the whole pipeline down
 * (recorder + tracks + rAF + AudioContext) — see `export.ts`.
 */

export type ExportStatusUI =
  | "preparing"
  | "rendering"
  | "uploading"
  | "completed"
  | "failed"
  | "canceled";

export interface ExportJob {
  id: string;
  projectId: string;
  projectTitle: string;
  status: ExportStatusUI;
  /** 0..1 for the active stage. */
  progress: number;
  /** Human label, e.g. "9:16 · Fit · 4K · 60fps". */
  outputFormat: string;
  startedAt: number;
  completedAt?: number;
  /** Persistent Storage URL (set once the upload finishes). */
  downloadUrl?: string;
  /** In-memory blob URL for an instant download this session. */
  localBlobUrl?: string;
  error?: string;
  /** Non-fatal renderer notice (e.g. "this export will be silent"). */
  warning?: string;
}

/** Everything the renderer needs, snapshotted so it's project-context-free. */
export interface ExportRenderParams {
  projectId: string;
  projectTitle: string;
  originalVideoUrl: string;
  duration: number;
  moments: DetectedMoment[];
  effects: EffectsSettings;
  visualAnalysis?: VisualAnalysis;
  resolution: "1080p" | "4K";
  fps: 30 | 60;
  format: ExportFormat;
  /** Human label for the job/pill. */
  outputFormat: string;
}

interface ExportContextValue {
  job: ExportJob | null;
  isExporting: boolean;
  /** Returns false if an export is already running (single-flight). */
  startExport: (params: ExportRenderParams) => boolean;
  cancelExport: () => void;
  clearJob: () => void;
  downloadCurrent: () => void;
}

const Ctx = React.createContext<ExportContextValue | null>(null);

const ACTIVE: ExportStatusUI[] = ["preparing", "rendering", "uploading"];

/** Load the offscreen video for export; resolves once a frame is decodable. */
function loadExportVideo(
  video: HTMLVideoElement,
  url: string,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const cleanup = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not load the source video for export."));
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort);

    if (video.src !== url) {
      video.crossOrigin = "anonymous";
      video.src = url;
      video.load();
    } else if (video.readyState >= 2 /* HAVE_CURRENT_DATA */) {
      cleanup();
      resolve();
    }
  });
}

export function ExportProvider({ children }: { children: React.ReactNode }) {
  const { user, getIdToken } = useAuth();
  const notifications = useNotifications();

  const [job, setJob] = React.useState<ExportJob | null>(null);
  const controllerRef = React.useRef<AbortController | null>(null);
  const offscreenVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const blobUrlRef = React.useRef<string | null>(null);
  const runningRef = React.useRef(false);

  const isExporting = !!job && ACTIVE.includes(job.status);

  const revokeBlobUrl = React.useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const run = React.useCallback(
    async (params: ExportRenderParams) => {
      const uid = user?.uid;
      const controller = new AbortController();
      controllerRef.current = controller;
      revokeBlobUrl();

      setJob({
        id: "pending",
        projectId: params.projectId,
        projectTitle: params.projectTitle,
        status: "preparing",
        progress: 0,
        outputFormat: params.outputFormat,
        startedAt: Date.now(),
      });
      console.info("[export] started", {
        projectId: params.projectId,
        outputFormat: params.outputFormat,
      });

      try {
        if (!uid) throw new Error("Sign in to export.");
        if (!params.originalVideoUrl) {
          throw new Error("Project has no source video.");
        }

        // ── 1. Server permit (plan + monthly cap; locks resolution/watermark) ──
        const token = await getIdToken();
        if (!token) throw new Error("Sign in to export.");
        const permitRes = await fetch("/api/billing/export-permit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            projectId: params.projectId,
            projectTitle: params.projectTitle,
            resolution: params.resolution,
            format: params.format,
            fps: params.fps,
          }),
        });
        const permitJson = (await permitRes.json()) as {
          ok?: boolean;
          exportId?: string;
          uploadPath?: string;
          applyWatermark?: boolean;
          error?: string;
          kind?: "plan_required" | "limit_reached";
          used?: number;
          limit?: number;
        };
        if (!permitRes.ok || !permitJson.ok) {
          const friendly =
            permitJson.kind === "plan_required"
              ? "Pro plan required for 4K export. Upgrade in /pricing."
              : permitJson.kind === "limit_reached"
                ? `Export limit reached (${permitJson.used}/${permitJson.limit}). Upgrade to keep exporting.`
                : permitJson.error || `Export blocked (${permitRes.status})`;
          throw new Error(friendly);
        }
        const { exportId, uploadPath, applyWatermark } = permitJson;
        if (!exportId || !uploadPath) {
          throw new Error("Permit was missing exportId or uploadPath.");
        }
        setJob((j) => (j ? { ...j, id: exportId } : j));

        // ── 2. Render on the provider's OWN offscreen video (decoupled) ──
        const video = offscreenVideoRef.current;
        if (!video) throw new Error("Export video element not ready.");
        await loadExportVideo(video, params.originalVideoUrl, controller.signal);

        setJob((j) => (j ? { ...j, status: "rendering", progress: 0 } : j));
        const blob = await renderProjectClientSide({
          uid,
          projectId: params.projectId,
          projectTitle: params.projectTitle,
          video,
          duration: params.duration,
          moments: params.moments,
          effects: params.effects,
          resolution: params.resolution,
          fps: params.fps,
          format: params.format,
          visualAnalysis: params.visualAnalysis,
          applyWatermark: !!applyWatermark,
          onProgress: (p) =>
            setJob((j) =>
              j && j.status !== "canceled"
                ? {
                    ...j,
                    progress: p.pct,
                    status: p.stage === "uploading" ? "uploading" : "rendering",
                    ...(p.warning ? { warning: p.warning } : {}),
                  }
                : j
            ),
          signal: controller.signal,
        });

        // Keep the rendered blob for an instant, in-session download.
        const blobUrl = URL.createObjectURL(blob);
        blobUrlRef.current = blobUrl;
        setJob((j) =>
          j ? { ...j, status: "uploading", progress: 0, localBlobUrl: blobUrl } : j
        );

        // ── 3. Upload to the path the permit blessed (persistent download) ──
        const { downloadURL } = await uploadExport({
          uid,
          projectId: params.projectId,
          exportId,
          uploadPath,
          blob,
          signal: controller.signal,
          onProgress: (pct) =>
            setJob((j) => (j ? { ...j, progress: pct } : j)),
        });

        setJob((j) =>
          j
            ? {
                ...j,
                status: "completed",
                progress: 1,
                completedAt: Date.now(),
                downloadUrl: downloadURL,
              }
            : j
        );
        console.info("[export] completed", { exportId });
        notifications.push({
          id: `export-completed:${exportId}`,
          kind: "export-completed",
          title: "Export ready",
          body: `${params.projectTitle || "Untitled"} · ${params.outputFormat}`,
          href: "/dashboard/exports",
        });
      } catch (err) {
        if (controller.signal.aborted) {
          console.info("[export] canceled", { projectId: params.projectId });
          setJob((j) => (j ? { ...j, status: "canceled" } : j));
        } else {
          const msg = err instanceof Error ? err.message : "Export failed.";
          console.info("[export] failed", { projectId: params.projectId, msg });
          setJob((j) => (j ? { ...j, status: "failed", error: msg } : j));
          notifications.push({
            id: `export-failed:${params.projectId}:${Date.now()}`,
            kind: "export-failed",
            title: "Export failed",
            body: `${params.projectTitle || "Untitled"} — ${msg}`,
            href: `/dashboard/projects/${params.projectId}`,
          });
        }
      } finally {
        controllerRef.current = null;
      }
    },
    [user?.uid, getIdToken, notifications, revokeBlobUrl]
  );

  const startExport = React.useCallback(
    (params: ExportRenderParams): boolean => {
      if (runningRef.current) return false; // single-flight: no duplicate render
      runningRef.current = true;
      void run(params).finally(() => {
        runningRef.current = false;
      });
      return true;
    },
    [run]
  );

  const cancelExport = React.useCallback(() => {
    console.info("[export] cancel-requested");
    controllerRef.current?.abort();
  }, []);

  const clearJob = React.useCallback(() => {
    revokeBlobUrl();
    setJob(null);
  }, [revokeBlobUrl]);

  const downloadCurrent = React.useCallback(() => {
    const localUrl = blobUrlRef.current;
    const url = localUrl ?? job?.downloadUrl;
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${job?.projectTitle || "framevo-export"}.${pickedMimeExt()}`;
    if (!localUrl) {
      // Remote Storage URL — open in a new tab so the browser handles it.
      a.target = "_blank";
      a.rel = "noreferrer";
    }
    a.click();
  }, [job?.downloadUrl, job?.projectTitle]);

  // Warn before leaving while a render/upload is in flight (mirrors recording).
  React.useEffect(() => {
    if (!isExporting) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isExporting]);

  const value: ExportContextValue = {
    job,
    isExporting,
    startExport,
    cancelExport,
    clearJob,
    downloadCurrent,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Offscreen render source — kept tiny + transparent (NOT display:none, so
          the browser still decodes frames for `drawImage`). Lives at Shell level
          so the export survives navigation. */}
      <video
        ref={offscreenVideoRef}
        playsInline
        aria-hidden
        tabIndex={-1}
        style={{
          position: "fixed",
          left: -10000,
          top: 0,
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
      />
    </Ctx.Provider>
  );
}

export function useExport(): ExportContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error("useExport must be used inside <ExportProvider>");
  }
  return ctx;
}
