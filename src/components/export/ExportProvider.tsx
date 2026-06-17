"use client";

import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { useNotifications } from "@/lib/notifications/store";
import {
  renderProjectClientSide,
  uploadExport,
  pickedMimeExt,
  pickedMimeType,
} from "@/components/dashboard/real-editor/export";
import {
  ExportError,
  describeError,
  isAbortError,
  type ExportStage,
} from "@/components/dashboard/real-editor/export-error";
import type {
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
  SourceCrop,
  VisualAnalysis,
} from "@/lib/firebase/schema";
import { trackEvent } from "@/lib/analytics/trackEvent";
import { EVENTS } from "@/lib/analytics/events";

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

/**
 * NON-SECRET diagnostic snapshot attached to a failed (or completed) job,
 * surfaced in the export panel's collapsible "Details" section and the
 * `[export-failed]` console log. Deliberately excludes anything sensitive —
 * no tokens, no signed URLs, no auth headers.
 */
export interface ExportDebug {
  /** Which pipeline stage threw. */
  stage?: ExportStage;
  /** Underlying error name (e.g. "SecurityError", "FirebaseError"). */
  name?: string;
  /** SDK error code (e.g. "storage/unauthorized"). */
  code?: string;
  /** Recorder MIME the browser would use. */
  mimeType?: string | null;
  /** Rendered byte size when known (e.g. an upload-stage failure). */
  outputSize?: number;
  /** Short UA string for the bug report. */
  browser?: string;
  /** Full stack — shown collapsed, copy-able. */
  stack?: string;
}

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
  /** Which stage failed — drives the UI hint + Details panel. */
  errorStage?: ExportStage;
  /** Non-secret diagnostics for the Details panel + bug reports. */
  debug?: ExportDebug;
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
  /** Global source-frame crop — sampled off the source rect at render. */
  sourceCrop?: SourceCrop;
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

/** Origin + path of a URL with the query string (and any token) stripped. */
function safeUrlInfo(url: string | undefined): {
  exists: boolean;
  origin?: string;
  ext?: string;
} {
  if (!url) return { exists: false };
  try {
    const u = new URL(url);
    const ext = u.pathname.split(".").pop()?.toLowerCase();
    return { exists: true, origin: u.origin, ext };
  } catch {
    return { exists: true };
  }
}

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
      const moms = params.moments ?? [];
      const cutsCount = moms.filter(
        (m) => m.effectType === "cut" && m.cut?.active !== false
      ).length;
      const speedCount = moms.filter((m) => m.effectType === "speed-up").length;
      const cameraEditCount = moms.filter(
        (m) =>
          m.effectType === "zoom" ||
          m.effectType === "cursor-focus" ||
          m.effectType === "crop" ||
          m.effectType === "click-highlight"
      ).length;
      const src = safeUrlInfo(params.originalVideoUrl);
      console.info("[export-start]", {
        projectId: params.projectId,
        userId: uid ?? null,
        duration: params.duration,
        sourceUrlExists: src.exists,
        sourceOrigin: src.origin, // origin only — never the token-bearing URL
        sourceType: src.ext,
        resolution: params.resolution,
        fps: params.fps,
        format: params.format,
        outputFormat: params.outputFormat,
        canvasFit: params.effects.outputCanvas
          ? `${params.effects.outputCanvas.aspectRatio}/${params.effects.outputCanvas.fitMode}`
          : "source",
        sourceCrop: params.sourceCrop?.enabled
          ? { reason: params.sourceCrop.reason ?? "manual" }
          : "none",
        momentsCount: moms.length,
        cutsCount,
        speedCount,
        cameraEditCount,
        mimeType: pickedMimeType(),
      });
      void trackEvent(
        EVENTS.EXPORT_STARTED,
        { format: params.outputFormat },
        { projectId: params.projectId }
      );

      // Captured for the [export-failed] log even when the throw happens deep in
      // a stage (block-scoped consts aren't reachable from the catch).
      let exportIdForLog: string | undefined;
      let outputSizeForLog: number | undefined;

      try {
        if (!uid) throw new ExportError("permit", "Sign in to export.");
        if (!params.originalVideoUrl) {
          throw new ExportError("load-video", "This project has no source video to export.");
        }

        // ── 1. Server permit (plan + monthly cap; locks resolution/watermark) ──
        const { exportId, uploadPath, applyWatermark } = await (async () => {
          // `getIdToken()` hits Firebase Auth and can throw a raw, opaque error
          // ("auth/internal-error", network) — a prime source of the bare
          // "Internal Error" report. Tag it to the permit stage so the user gets
          // an actionable message, not the SDK string.
          let token: string | null;
          try {
            token = await getIdToken();
          } catch (tokErr) {
            throw new ExportError(
              "permit",
              "Couldn't verify your session for export. Sign out and back in, then retry.",
              { cause: tokErr }
            );
          }
          if (!token) throw new ExportError("permit", "Sign in to export.");
          let permitRes: Response;
          try {
            permitRes = await fetch("/api/billing/export-permit", {
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
          } catch (netErr) {
            throw new ExportError(
              "permit",
              "Couldn't reach the export service. Check your connection and retry.",
              { cause: netErr }
            );
          }
          // The server returns JSON on success AND on its handled errors; a raw
          // 500 (function crash) can return HTML, so guard the parse.
          let permitJson: {
            ok?: boolean;
            exportId?: string;
            uploadPath?: string;
            applyWatermark?: boolean;
            error?: string;
            kind?: "plan_required" | "limit_reached";
            used?: number;
            limit?: number;
          };
          try {
            permitJson = await permitRes.json();
          } catch (parseErr) {
            throw new ExportError(
              "permit",
              `The export service returned an unexpected response (${permitRes.status}). Please retry.`,
              { cause: parseErr, detail: { status: permitRes.status } }
            );
          }
          console.info("[export-permit]", {
            started: true,
            status: permitRes.status,
            success: permitRes.ok && !!permitJson.ok,
            kind: permitJson.kind,
            message: permitJson.error,
          });
          if (!permitRes.ok || !permitJson.ok) {
            const friendly =
              permitJson.kind === "plan_required"
                ? "Pro plan required for 4K export. Upgrade in /pricing."
                : permitJson.kind === "limit_reached"
                  ? `Export limit reached (${permitJson.used}/${permitJson.limit}). Upgrade to keep exporting.`
                  : permitJson.error || `Export blocked (${permitRes.status})`;
            throw new ExportError("permit", friendly, {
              detail: { status: permitRes.status, kind: permitJson.kind },
            });
          }
          if (!permitJson.exportId || !permitJson.uploadPath) {
            throw new ExportError(
              "permit",
              "The export permit was incomplete (missing id or upload path). Please retry."
            );
          }
          return {
            exportId: permitJson.exportId,
            uploadPath: permitJson.uploadPath,
            applyWatermark: permitJson.applyWatermark,
          };
        })();
        exportIdForLog = exportId;
        setJob((j) => (j ? { ...j, id: exportId } : j));

        // ── 2. Render on the provider's OWN offscreen video (decoupled) ──
        const video = offscreenVideoRef.current;
        if (!video) {
          throw new ExportError("load-video", "The export video element isn't ready. Reload and retry.");
        }
        console.info("[export-load-video]", {
          started: true,
          sourceOrigin: src.origin,
          sourceType: src.ext,
        });
        try {
          await loadExportVideo(video, params.originalVideoUrl, controller.signal);
        } catch (loadErr) {
          if (controller.signal.aborted) throw loadErr; // cancel — handled below
          const d = describeError(loadErr);
          throw new ExportError(
            "load-video",
            "The source video couldn't be loaded for export. It may have expired or be unavailable — reopen the project and try again.",
            { cause: loadErr, detail: { name: d.name, mediaErrorCode: video.error?.code } }
          );
        }

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
          sourceCrop: params.sourceCrop,
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
        outputSizeForLog = blob.size;
        const blobUrl = URL.createObjectURL(blob);
        blobUrlRef.current = blobUrl;
        // Record the rendered byte size so an upload-stage failure's Details
        // panel can show "the render succeeded, the save failed".
        setJob((j) =>
          j
            ? {
                ...j,
                status: "uploading",
                progress: 0,
                localBlobUrl: blobUrl,
                debug: { ...j.debug, outputSize: blob.size },
              }
            : j
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
        void trackEvent(
          EVENTS.EXPORT_COMPLETED,
          { exportId, format: params.outputFormat },
          { projectId: params.projectId }
        );
        notifications.push({
          id: `export-completed:${exportId}`,
          kind: "export-completed",
          title: "Export ready",
          body: `${params.projectTitle || "Untitled"} · ${params.outputFormat}`,
          href: "/dashboard/exports",
        });
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) {
          console.info("[export] canceled", { projectId: params.projectId });
          setJob((j) => (j ? { ...j, status: "canceled" } : j));
          void trackEvent(
            EVENTS.EXPORT_CANCELLED,
            { format: params.outputFormat },
            { projectId: params.projectId }
          );
        } else {
          // Stage-tagged, human reason for the UI; full detail for the console.
          const stage: ExportStage =
            err instanceof ExportError ? err.stage : "unknown";
          const d = describeError(err);
          const reason = d.message || "Export failed.";
          const debug: ExportDebug = {
            stage,
            name: d.name,
            code: d.code,
            mimeType: pickedMimeType(),
            outputSize: outputSizeForLog,
            browser:
              typeof navigator !== "undefined"
                ? navigator.userAgent.slice(0, 180)
                : undefined,
            stack: d.stack,
          };
          // Full failure object to the console — stage, name, code, message,
          // stack, cause — so production failures are diagnosable end to end.
          console.error("[export-failed]", {
            projectId: params.projectId,
            exportId: exportIdForLog,
            stage,
            name: d.name,
            code: d.code,
            message: reason,
            outputSize: outputSizeForLog,
            mimeType: debug.mimeType,
            browser: debug.browser,
            stack: d.stack,
            cause: err instanceof ExportError ? err.cause : err,
          });
          setJob((j) =>
            j
              ? {
                  ...j,
                  status: "failed",
                  error: reason,
                  errorStage: stage,
                  debug: { ...j.debug, ...debug },
                }
              : j
          );
          void trackEvent(
            EVENTS.EXPORT_FAILED,
            {
              format: params.outputFormat,
              stage,
              code: d.code,
              message: reason.slice(0, 200),
            },
            { projectId: params.projectId }
          );
          notifications.push({
            id: `export-failed:${params.projectId}:${Date.now()}`,
            kind: "export-failed",
            title: "Export failed",
            body: `${params.projectTitle || "Untitled"} — ${reason}`,
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
    void trackEvent(
      EVENTS.EXPORT_DOWNLOADED,
      { format: job?.outputFormat, source: localUrl ? "local" : "storage" },
      { projectId: job?.projectId }
    );
  }, [job?.downloadUrl, job?.projectTitle, job?.outputFormat, job?.projectId]);

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
