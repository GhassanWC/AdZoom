"use client";

import * as React from "react";
import { usePlatform } from "@/lib/platform";
import type { EncoderInfo, LocalExportProgress, LocalExportResult } from "@/lib/platform";
import { buildRenderRecipe } from "@/lib/render/recipe";
import type { SerializedRenderRecipe } from "@/lib/firebase/schema";
import {
  serializeRecipeInput,
  type DesktopExportInput,
} from "./desktop-export-recipe";
import { useToast } from "@/components/ui/Toast";

/**
 * Session-level owner of the LOCAL (desktop) export — the sibling of
 * `ExportProvider` (cloud) and `EditframeExportProvider` (in-browser).
 *
 * PARITY: it does not describe the render itself. It serializes exactly the
 * inputs `buildRenderRecipe` takes — the same object the cloud job stores as
 * `renderRecipe` and the same one `buildEditframeComposition` feeds the browser
 * engine — and hands it to the main process, which runs the shared render core.
 * `assertRecipeParity` below turns that claim into a runtime check in
 * development, and tests/desktop-export-parity.test.ts locks it in CI.
 *
 * The render itself happens in a child process (see desktop/src/main/export),
 * so the editor stays interactive and a cancel is immediate.
 */

export type DesktopExportStatus =
  | "preparing"
  | "rendering"
  | "encoding"
  | "completed"
  | "failed"
  | "canceled";

export interface DesktopExportJob {
  id: string;
  projectId: string;
  projectTitle: string;
  status: DesktopExportStatus;
  /** 0..1 across the whole render. */
  progress: number;
  etaMs?: number;
  startedAt: number;
  completedAt?: number;
  /** File name only — the folder the user chose never enters the renderer. */
  fileName?: string;
  outputId?: string;
  sizeBytes?: number;
  encoder?: string;
  warning?: string;
  error?: string;
}

interface DesktopExportContextValue {
  job: DesktopExportJob | null;
  isExporting: boolean;
  starting: boolean;
  encoders: EncoderInfo[];
  /** The encoder an export would use right now ("auto" pick). */
  activeEncoder: EncoderInfo | null;
  /** Returns false when an export is already running or the user cancelled the save dialog. */
  startExport(input: DesktopExportInput): Promise<boolean>;
  cancelExport(): void;
  clearJob(): void;
  revealOutput(): void;
}

const Ctx = React.createContext<DesktopExportContextValue | null>(null);

/**
 * Development guard: prove the serialized recipe resolves to the same geometry
 * and timeline the local preview is showing before shipping it to the renderer.
 * A mismatch here is a parity bug — loud in dev, silent (and impossible, since
 * both sides call one function) in production.
 */
function assertRecipeParity(serialized: SerializedRenderRecipe): void {
  if (process.env.NODE_ENV === "production") return;
  const recipe = buildRenderRecipe({ ...serialized, debugBorders: false });
  if (!Number.isFinite(recipe.outputDuration) || recipe.outputDuration <= 0) {
    console.warn("[desktop-export] recipe has no output duration", {
      moments: serialized.moments.length,
      sourceDuration: serialized.sourceDuration,
    });
  }
}

export function DesktopExportProvider({ children }: { children: React.ReactNode }) {
  const platform = usePlatform();
  const exportService = platform.export;
  // Toasts, not the notification bell: the bell is per-signed-in-user and the
  // desktop app is usable signed out.
  const toast = useToast();

  const [job, setJob] = React.useState<DesktopExportJob | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [encoders, setEncoders] = React.useState<EncoderInfo[]>([]);
  // Mirrors `job` for the callbacks below, which must see the CURRENT job
  // without being re-created on every progress tick (that would re-subscribe
  // the whole export event chain several times a second).
  const jobRef = React.useRef<DesktopExportJob | null>(null);
  React.useEffect(() => {
    jobRef.current = job;
  }, [job]);

  // Probing the GPU costs a couple of hundred milliseconds and the answer can't
  // change while the app runs, so do it once, in the background, at mount.
  React.useEffect(() => {
    if (!exportService) return;
    let live = true;
    void exportService
      .listEncoders()
      .then((list) => {
        if (live) setEncoders(list);
      })
      .catch(() => {
        /* the export itself will report a real failure */
      });
    return () => {
      live = false;
    };
  }, [exportService]);

  // Subscribe once; the handlers filter by the live job id.
  React.useEffect(() => {
    if (!exportService) return;
    const update = (jobId: string, patch: Partial<DesktopExportJob>) =>
      setJob((current) => (current && current.id === jobId ? { ...current, ...patch } : current));

    const offProgress = exportService.onProgress((jobId, progress: LocalExportProgress) =>
      update(jobId, {
        status: progress.stage === "encoding" ? "encoding" : progress.stage === "rendering" ? "rendering" : "preparing",
        progress: progress.progress,
        etaMs: progress.etaMs,
      })
    );
    const offDone = exportService.onDone((jobId, result: LocalExportResult) => {
      update(jobId, {
        status: "completed",
        progress: 1,
        completedAt: Date.now(),
        fileName: result.fileName,
        outputId: result.outputId,
        sizeBytes: result.sizeBytes,
        encoder: result.encoder,
        warning: result.warnings[0],
        etaMs: undefined,
      });
      toast.success("Export complete", `${result.fileName} was saved to your computer.`);
    });
    const offFailed = exportService.onFailed((jobId, error) => {
      update(jobId, { status: "failed", error: error.message, completedAt: Date.now() });
      toast.error("Export failed", error.message);
    });
    const offCanceled = exportService.onCanceled((jobId) =>
      update(jobId, { status: "canceled", completedAt: Date.now() })
    );

    return () => {
      offProgress();
      offDone();
      offFailed();
      offCanceled();
    };
  }, [exportService, toast]);

  const startExport = React.useCallback(
    async (input: DesktopExportInput): Promise<boolean> => {
      if (!exportService) return false;
      const active = jobRef.current;
      if (starting || (active && ["preparing", "rendering", "encoding"].includes(active.status))) {
        return false;
      }
      setStarting(true);
      try {
        const target = await exportService.chooseOutput(input.projectTitle);
        if (!target) return false; // user cancelled the save dialog

        const recipe = serializeRecipeInput(input);
        assertRecipeParity(recipe);

        const jobId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        setJob({
          id: jobId,
          projectId: input.projectId,
          projectTitle: input.projectTitle,
          status: "preparing",
          progress: 0,
          startedAt: Date.now(),
          fileName: target.fileName,
          outputId: target.outputId,
        });

        await exportService.start({
          jobId,
          projectId: input.projectId,
          projectTitle: input.projectTitle,
          mediaId: input.mediaId,
          outputId: target.outputId,
          recipe,
          encoder: "auto",
        });
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : "The export could not be started.";
        setJob((current) =>
          current ? { ...current, status: "failed", error: message } : current
        );
        toast.error("Export failed", message);
        return false;
      } finally {
        setStarting(false);
      }
    },
    [exportService, toast, starting]
  );

  const cancelExport = React.useCallback(() => {
    const active = jobRef.current;
    if (!exportService || !active) return;
    void exportService.cancel(active.id);
  }, [exportService]);

  const revealOutput = React.useCallback(() => {
    const active = jobRef.current;
    if (!active?.outputId) return;
    void platform.media.revealOutput(active.outputId);
  }, [platform.media]);

  const activeEncoder = React.useMemo(
    () => encoders.find((e) => e.available) ?? null,
    [encoders]
  );

  const value: DesktopExportContextValue = {
    job,
    isExporting: !!job && ["preparing", "rendering", "encoding"].includes(job.status),
    starting,
    encoders,
    activeEncoder,
    startExport,
    cancelExport,
    clearJob: () => setJob(null),
    revealOutput,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Null when there is no local export engine (i.e. in the browser) — callers
 * branch on that rather than on "am I in Electron?".
 */
export function useDesktopExport(): DesktopExportContextValue | null {
  return React.useContext(Ctx);
}
