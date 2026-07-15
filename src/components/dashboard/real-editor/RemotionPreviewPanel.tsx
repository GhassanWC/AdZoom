"use client";
/**
 * Flag-gated Remotion preview, shipped ALONGSIDE the canvas preview
 * (RealVideoPlayer) — never replacing it. When NEXT_PUBLIC_REMOTION_PREVIEW is
 * on, this renders the SAME <FramevoComposition> the cloud worker renders, fed a
 * `SerializedRenderRecipe` built from the live editor state (the exact shape
 * `createCloudExportJob` writes to the export job). That lets us compare the
 * Remotion render against the proven canvas preview for parity BEFORE the
 * Remotion path becomes the default preview. Default OFF → invisible in prod.
 */
import * as React from "react";
import { useEditorReal } from "./context";
import {
  RemotionPreview,
  REMOTION_PREVIEW_ENABLED,
} from "@/components/editor/RemotionPreview";
import type { SerializedRenderRecipe } from "@/lib/firebase/schema";
import { visibleMoments } from "@/lib/timeline/layers";

export function RemotionPreviewPanel() {
  const { project, videoRef, duration } = useEditorReal();

  // Source geometry: prefer the project's stored dims, fall back to the live
  // <video> element, then a 16:9 default. Duration prefers the live element
  // (the context `duration` is set from it) over the stored value.
  const srcW =
    (project.width && project.width > 0 ? project.width : 0) ||
    videoRef.current?.videoWidth ||
    1920;
  const srcH =
    (project.height && project.height > 0 ? project.height : 0) ||
    videoRef.current?.videoHeight ||
    1080;
  const srcDuration =
    (duration && duration > 0 ? duration : 0) ||
    (project.duration && project.duration > 0 ? project.duration : 0);

  const src = project.originalVideoUrl || "";

  // The recipe mirrors `createCloudExportJob`'s `serializedRecipe` so the preview
  // compiles identically to the export. fps/resolution/format are preview
  // defaults (1080p · 30 · Source); the Canvas-Fit output is driven entirely by
  // `effects.outputCanvas`, so these neutral values don't affect framing.
  const recipe = React.useMemo<SerializedRenderRecipe>(
    () => ({
      sourceWidth: srcW,
      sourceHeight: srcH,
      fps: 30,
      resolution: "1080p",
      format: "Source",
      sourceDuration: srcDuration > 0 ? srcDuration : 1,
      // Hidden layers are dropped, exactly as `createCloudExportJob` will drop
      // them — this panel exists to show what the export will look like.
      moments: visibleMoments(
        project.analysis?.detectedMoments ?? [],
        project.timelineLayers
      ),
      effects: project.effectsSettings,
      sourceCrop: project.sourceCrop ?? null,
      applyWatermark: false,
      ...(project.visualAnalysis != null
        ? { visualAnalysis: project.visualAnalysis }
        : {}),
    }),
    [
      srcW,
      srcH,
      srcDuration,
      project.analysis?.detectedMoments,
      project.timelineLayers,
      project.effectsSettings,
      project.sourceCrop,
      project.visualAnalysis,
    ]
  );

  if (!REMOTION_PREVIEW_ENABLED) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-200">
          Remotion preview
          <span className="rounded bg-violet-400/20 px-1.5 py-0.5 text-[9px] font-medium normal-case tracking-normal text-violet-100">
            experimental
          </span>
        </span>
        <span className="text-[11px] text-fog">
          Parity check — renders the same composition the cloud export uses.
        </span>
      </div>
      {src && srcDuration > 0 ? (
        <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-black shadow-cinematic">
          <RemotionPreview recipe={recipe} src={src} audioMode="source" />
        </div>
      ) : (
        <div className="grid place-items-center rounded-xl border border-white/[0.06] bg-white/[0.02] px-6 py-10 text-center text-[12px] text-fog">
          {src
            ? "Waiting for the source video to report its duration…"
            : "No source video loaded for the Remotion preview."}
        </div>
      )}
    </div>
  );
}
