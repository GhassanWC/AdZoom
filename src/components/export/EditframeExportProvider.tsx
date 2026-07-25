"use client";

import * as React from "react";
import { useNotifications } from "@/lib/notifications/store";
import { trackEvent } from "@/lib/analytics/trackEvent";
import { EVENTS } from "@/lib/analytics/events";
import { logExportHistory } from "@/lib/export/history-log";
import type {
  EditframeProgress,
  EditframeProjectInput,
  EditframeResolution,
  EditframeTimelineInput,
} from "@/lib/export/editframe/types";

/**
 * Session-level owner of the Editframe BETA export (mirrors `ExportProvider`).
 *
 * Fully client-side: the render runs in the background so it survives the export
 * dialog closing, and it makes NO billing/permit/usage/Firestore-job calls — so
 * a failed or cancelled Editframe export deducts nothing, and it can never create
 * a cloud export job. The heavy engine (mediabunny + the frame loop) is
 * `import()`-ed lazily on start, keeping it out of the main/cloud bundle.
 */

export type EditframeStatus =
  | "preparing"
  | "rendering"
  | "completed"
  | "failed"
  | "canceled";

export interface EditframeJob {
  id: string;
  projectId: string;
  projectTitle: string;
  status: EditframeStatus;
  /** 0..1 for the active stage. */
  progress: number;
  outputFormat: string;
  resolution: EditframeResolution;
  startedAt: number;
  completedAt?: number;
  /** In-memory blob URL for an instant download this session. */
  localBlobUrl?: string;
  error?: string;
  /** Non-fatal renderer notice (silent audio / pitch-correct fallback). */
  warning?: string;
  videoDurationSec?: number;
}

export interface EditframeStartParams {
  project: EditframeProjectInput;
  timeline: EditframeTimelineInput;
  /** Billing plan tier — analytics only (this path never touches usage). */
  plan?: string | null;
  /** Push a user-facing "export failed" notification on failure. Default true.
   *  Set false when a server backup will run automatically (silent fallback). */
  notifyOnFailure?: boolean;
}

interface EditframeExportContextValue {
  job: EditframeJob | null;
  isExporting: boolean;
  /** True between click and the first render tick (button "Starting…" state). */
  starting: boolean;
  /** Returns false if an Editframe export is already running (single-flight). */
  startExport: (params: EditframeStartParams) => boolean;
  cancelExport: () => void;
  clearJob: () => void;
  downloadCurrent: () => void;
}

const Ctx = React.createContext<EditframeExportContextValue | null>(null);

const ACTIVE: EditframeStatus[] = ["preparing", "rendering"];

export function EditframeExportProvider({ children }: { children: React.ReactNode }) {
  const notifications = useNotifications();

  const [job, setJob] = React.useState<EditframeJob | null>(null);
  const [starting, setStarting] = React.useState(false);
  const controllerRef = React.useRef<AbortController | null>(null);
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
    async (params: EditframeStartParams) => {
      const controller = new AbortController();
      controllerRef.current = controller;
      revokeBlobUrl();

      const { project, timeline } = params;
      const notifyOnFailure = params.notifyOnFailure !== false;
      const startedAt = Date.now();
      const baseMeta = {
        resolution: timeline.resolution,
        fps: timeline.fps,
        engine: "editframe" as const,
      };

      // Log every in-browser export to the user's Export history so a canceled /
      // failed / completed render is never invisible (see history-log.ts). Stable
      // id → the start + terminal calls merge into one row. Best-effort.
      const historyId = `ef-${startedAt}`;
      let outW: number | undefined;
      let outH: number | undefined;
      const logHistory = (
        status: "exporting" | "ready" | "failed" | "canceled",
        errorMessage?: string
      ) =>
        void logExportHistory({
          exportId: historyId,
          startedAt,
          projectId: project.id,
          projectTitle: project.title,
          status,
          engine: "editframe",
          container: "mp4",
          resolution: timeline.resolution,
          fps: timeline.fps,
          outputWidth: outW,
          outputHeight: outH,
          errorMessage,
        });

      setJob({
        id: `editframe:${startedAt}`,
        projectId: project.id,
        projectTitle: project.title,
        status: "preparing",
        progress: 0,
        outputFormat: timeline.outputFormat,
        resolution: timeline.resolution,
        startedAt,
      });
      console.info("[editframe-start]", {
        projectId: project.id,
        resolution: timeline.resolution,
        fps: timeline.fps,
        momentsCount: timeline.moments.length,
        sourceDuration: timeline.sourceDuration,
      });
      void trackEvent(EVENTS.EDITFRAME_EXPORT_STARTED, baseMeta, {
        projectId: project.id,
        plan: params.plan,
      });

      try {
        const engine = await import("@/lib/export/editframe/engine");
        const plan = engine.buildEditframeComposition(project, timeline);
        outW = plan.recipe.canvasW;
        outH = plan.recipe.canvasH;

        // Capability + source-codec preflight — blocks ONLY this engine.
        const support = await engine.detectEditframeSupport({
          sourceUrl: plan.sourceUrl,
          canvasW: plan.recipe.canvasW,
          canvasH: plan.recipe.canvasH,
          resolution: plan.resolution,
          fps: plan.fps,
        });
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (!support.ok) {
          const reason =
            support.reason ?? "Your browser can’t render this export. Try Chrome or Edge.";
          console.warn("[editframe] unsupported", { projectId: project.id, reason });
          void trackEvent(
            EVENTS.EDITFRAME_UNSUPPORTED_BROWSER,
            { ...baseMeta, reason },
            { projectId: project.id, plan: params.plan }
          );
          setJob((j) => (j ? { ...j, status: "failed", error: reason } : j));
          // Only surface the failure in history when NO server backup will run —
          // otherwise the cloud job represents this export and a "failed" row here
          // would be misleading (the user still gets their video).
          if (notifyOnFailure) logHistory("failed", reason);
          return;
        }

        setStarting(false);
        setJob((j) => (j ? { ...j, status: "rendering", progress: 0 } : j));

        const result = await engine.runEditframeExport(plan, {
          signal: controller.signal,
          onProgress: (p: EditframeProgress) =>
            setJob((j) =>
              j && j.status === "rendering" ? { ...j, progress: p.percent } : j
            ),
        });

        const blobUrl = URL.createObjectURL(result.blob);
        blobUrlRef.current = blobUrl;
        setJob((j) =>
          j
            ? {
                ...j,
                status: "completed",
                progress: 1,
                completedAt: Date.now(),
                localBlobUrl: blobUrl,
                warning: result.warning,
                videoDurationSec: result.videoDurationSec,
              }
            : j
        );
        logHistory("ready");
        console.info("[editframe] completed", {
          projectId: project.id,
          bytes: result.blob.size,
          renderDurationMs: Date.now() - startedAt,
        });
        void trackEvent(
          EVENTS.EDITFRAME_EXPORT_COMPLETED,
          {
            ...baseMeta,
            renderDurationMs: Date.now() - startedAt,
            videoDurationSec: result.videoDurationSec,
            bytes: result.blob.size,
          },
          { projectId: project.id, plan: params.plan }
        );
        notifications.push({
          id: `editframe-completed:${project.id}:${startedAt}`,
          kind: "export-completed",
          title: "Export ready",
          body: `${project.title || "Untitled"} · ${timeline.outputFormat}`,
        });
      } catch (err) {
        const aborted =
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError");
        if (aborted) {
          console.info("[editframe] canceled", { projectId: project.id });
          setJob((j) => (j ? { ...j, status: "canceled" } : j));
          logHistory("canceled");
          void trackEvent(EVENTS.EDITFRAME_EXPORT_CANCELLED, baseMeta, {
            projectId: project.id,
            plan: params.plan,
          });
        } else {
          const reason = err instanceof Error ? err.message : "Export failed.";
          console.error("[editframe-failed]", { projectId: project.id, reason, error: err });
          setJob((j) => (j ? { ...j, status: "failed", error: reason } : j));
          // See the preflight branch above — skip the history row when a server
          // backup will run and stand in for this export.
          if (notifyOnFailure) logHistory("failed", reason);
          void trackEvent(
            EVENTS.EDITFRAME_EXPORT_FAILED,
            { ...baseMeta, reason: reason.slice(0, 200) },
            { projectId: project.id, plan: params.plan }
          );
          // Stay quiet when a server backup will run automatically — only the final
          // result (from the backup) should reach the user.
          if (notifyOnFailure) {
            notifications.push({
              id: `editframe-failed:${project.id}:${Date.now()}`,
              kind: "export-failed",
              title: "Export failed",
              body: `${project.title || "Untitled"} — ${reason}`,
            });
          }
        }
      } finally {
        controllerRef.current = null;
        setStarting(false);
      }
    },
    [notifications, revokeBlobUrl]
  );

  const startExport = React.useCallback(
    (params: EditframeStartParams): boolean => {
      if (runningRef.current) return false; // single-flight
      runningRef.current = true;
      setStarting(true);
      void run(params).finally(() => {
        runningRef.current = false;
      });
      return true;
    },
    [run]
  );

  const cancelExport = React.useCallback(() => {
    console.info("[editframe] cancel-requested");
    controllerRef.current?.abort();
  }, []);

  const clearJob = React.useCallback(() => {
    revokeBlobUrl();
    setJob(null);
  }, [revokeBlobUrl]);

  const downloadCurrent = React.useCallback(() => {
    const url = blobUrlRef.current;
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${job?.projectTitle || "framevo-export"}.mp4`;
    a.click();
    void trackEvent(
      EVENTS.EXPORT_DOWNLOADED,
      { engine: "editframe", source: "local", resolution: job?.resolution },
      { projectId: job?.projectId }
    );
  }, [job?.projectTitle, job?.projectId, job?.resolution]);

  // Warn before leaving while an Editframe render is in flight.
  React.useEffect(() => {
    if (!isExporting) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isExporting]);

  const value: EditframeExportContextValue = {
    job,
    isExporting,
    starting,
    startExport,
    cancelExport,
    clearJob,
    downloadCurrent,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEditframeExport(): EditframeExportContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error("useEditframeExport must be used inside <EditframeExportProvider>");
  }
  return ctx;
}
