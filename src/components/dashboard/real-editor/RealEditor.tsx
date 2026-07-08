"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Sparkles, Loader2, AlertCircle } from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeProject } from "@/lib/firebase/projects";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { FREE_VIDEO_DURATION_LIMIT_MESSAGE } from "@/lib/usage/plan";
import { Button } from "@/components/ui/Button";
import { SidebarNav } from "@/components/dashboard/Sidebar";
import { EditorRealProvider, useEditorReal } from "./context";
import { RealVideoPlayer } from "./RealVideoPlayer";
import { EditorSplitWorkspace } from "./EditorSplitWorkspace";
import { RealTimeline } from "./RealTimeline";
import { MomentInspectorModal } from "./MomentInspectorModal";
import { ExportModal } from "./ExportModal";
import { AnalysisOptionsModal } from "./AnalysisOptionsModal";
import type { AnalysisOptions } from "@/lib/analysis/engine-layers";
import { useWorkspaceSettings } from "@/lib/firebase/workspace-settings";
import { RealProcessingOverlay } from "./RealProcessingOverlay";
import { ProcessingMiniPill } from "./ProcessingMiniPill";
import { DebugOverlay } from "./DebugOverlay";
import { EditorTopBar } from "./EditorTopBar";
import { EditorToolRail } from "./EditorToolRail";
import { EditorInspectorDock } from "./EditorInspectorDock";
import { EditorDrawer } from "./EditorDrawer";
import { disposeThumbnails } from "./timeline/thumbnails";
import { restoreEditorScrollLock } from "./scroll-lock";

export function RealEditorPage({ projectId }: { projectId: string }) {
  const { user, getIdToken } = useAuth();
  const [project, setProject] = React.useState<ProjectDoc | null>(null);
  const [notFound, setNotFound] = React.useState(false);

  React.useEffect(() => {
    if (!user) return;
    const unsub = subscribeProject(user.uid, projectId, (p) => {
      if (!p) {
        setNotFound(true);
      } else {
        setNotFound(false);
        setProject(p);
      }
    });
    return () => unsub();
  }, [user, projectId]);

  // Release decoded thumbnail frames + the hidden <video> when the editor
  // unmounts — keeps memory bounded across project navigations.
  React.useEffect(
    () => () => {
      disposeThumbnails();
      // Safety: never leave a leaked modal scroll-lock behind on navigation.
      restoreEditorScrollLock();
    },
    []
  );

  if (!user) return null;

  if (notFound) {
    return (
      <div className="grid min-h-dvh place-items-center px-4">
        <div className="glass w-full max-w-lg rounded-2xl p-8 text-center">
          <div className="mx-auto inline-flex size-12 items-center justify-center rounded-xl border border-rose-400/30 bg-rose-500/10 text-rose-300">
            <AlertCircle size={20} />
          </div>
          <h2 className="mt-4 font-display text-xl font-semibold text-white">
            Project not found
          </h2>
          <p className="mt-2 text-sm text-fog">
            This project doesn&apos;t exist or you don&apos;t have access to it.
          </p>
          <div className="mt-5 flex justify-center">
            <Button
              href="/dashboard"
              variant="ghost"
              size="sm"
              leftIcon={<ArrowLeft size={13} />}
            >
              Back to dashboard
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="flex items-center gap-2 text-sm text-fog">
          <Loader2 size={14} className="animate-spin text-violet-300" />
          Loading project…
        </div>
      </div>
    );
  }

  return (
    <EditorRealProvider uid={user.uid} project={project} idTokenGetter={getIdToken}>
      <Body />
      <RealProcessingOverlay />
      <ProcessingMiniPill />
      <MomentInspectorModal />
    </EditorRealProvider>
  );
}

/**
 * The fullscreen editing workspace — a fixed-height shell (no page scroll):
 *
 *   EditorTopBar        — sticky: menu (nav drawer) · back · title · undo/redo · Export
 *   workspace ROW       — a resizable vertical split (preview + playback controls
 *                         over an internally-scrolling timeline) fills the width;
 *                         a docked inspector panel + the narrow tool RAIL flank it
 *                         on the right, using horizontal space only.
 *
 * The old horizontal tools row is gone: Crop / Canvas / Effects / Captions /
 * Presets / Insights now live in the right rail and open a docked inspector
 * (one `activeTool` source of truth); Re-analyze + Export stay as modals; the
 * Previous/Next edit review nav moved into the timeline toolbar.
 */
function Body() {
  const {
    project,
    startAnalyze,
    analyzing,
    analyzeError,
    activeTool,
    cropEditing,
    closeCropEditor,
    selectedVideoType,
    setSelectedVideoType,
  } = useEditorReal();
  const hasAnalysis = (project.analysis?.detectedMoments?.length ?? 0) > 0;
  const isFailed = project.analysis?.status === "failed";
  // A draft is "missing" whenever there's nothing to edit — fresh upload,
  // failed run, or a completed run that produced zero moments. In every such
  // case the primary "Generate AI edit" CTA must be reachable.
  const isAnalyzingNow = analyzing || project.status === "analyzing";
  const canAnalyze = !isAnalyzingNow && !!project.originalVideoUrl;
  const [exportOpen, setExportOpen] = React.useState(false);
  const [analysisOptionsOpen, setAnalysisOptionsOpen] = React.useState(false);
  const [navOpen, setNavOpen] = React.useState(false);
  const { settings, save } = useWorkspaceSettings();

  // Crop has no dock panel — it edits directly on the preview. Opening any
  // OTHER tool exits crop mode (safety net; the rail's Crop button already
  // does this proactively) so the two editing surfaces never overlap.
  React.useEffect(() => {
    if (activeTool && cropEditing) closeCropEditor();
  }, [activeTool, cropEditing, closeCropEditor]);

  const analyzeTitle = isFailed
    ? "The previous analysis failed — try again."
    : !hasAnalysis && project.analysis?.status === "complete"
      ? "No moments were produced — re-run to try again."
      : undefined;

  // The project's LAST RUN toggles — passed to the dialog so Re-analyze respects
  // what the user turned off. The dialog owns the video type + recipe defaults now.
  const lastRun = project.analysis?.lastRunOptions as Partial<AnalysisOptions> | undefined;

  return (
    // Fixed-height editor shell — fills the viewport and does NOT page-scroll.
    // The header + transient strips are shrink-0; the split workspace fills the
    // rest, and only the timeline scrolls internally (overflow-hidden here keeps
    // the document body still while the preview stays permanently visible).
    // NB: all drawers/modals portal to document.body, so overflow-hidden never
    // clips them.
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      {/* ── 1. Editor top bar ─────────────────────────────────────────────── */}
      <EditorTopBar
        onOpenNav={() => setNavOpen(true)}
        onExport={() => setExportOpen(true)}
      />

      {/* ── 2. Transient strips (error / first-run CTA) — compact, shrink-0 ── */}
      {analyzeError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-rose-400/25 bg-rose-500/[0.06] px-4 py-2 text-[12.5px] text-rose-200">
          <AlertCircle size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={analyzeError}>
            {analyzeError}
          </span>
          {analyzeError === FREE_VIDEO_DURATION_LIMIT_MESSAGE && (
            <Link
              href="/pricing"
              className="shrink-0 rounded-md border border-rose-300/40 bg-rose-400/15 px-2.5 py-1 text-[11.5px] font-semibold text-rose-50 transition-colors hover:bg-rose-400/25"
            >
              Upgrade
            </Link>
          )}
        </div>
      )}

      {!hasAnalysis && (
        <PreAnalysisBanner
          analyzing={isAnalyzingNow}
          canAnalyze={canAnalyze}
          title={analyzeTitle}
          onGenerate={() => setAnalysisOptionsOpen(true)}
        />
      )}

      {/* ── 3. Workspace ROW — the vertical split (preview + timeline) fills the
             FULL width; the narrow tool rail sits flush on the right. Playback
             transport now lives INSIDE the timeline's unified control bar (no
             separate controls row) — see EditorUnifiedControlBar. The inspector
             panel (EditorInspectorDock) floats as an ABSOLUTE popup anchored
             just left of the rail — it overlays the workspace instead of
             squeezing it, so opening a tool never reflows or resizes the
             preview/timeline. `relative` here is what the dock's
             `absolute inset-y-0` positions against. ─────────────────────── */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <EditorSplitWorkspace
            preview={<RealVideoPlayer fill />}
            timeline={
              <div className="min-h-0 flex-1 overflow-hidden">
                <RealTimeline />
              </div>
            }
          />
        </div>

        {/* Floating inspector popup (renders only when a tool is active). */}
        <EditorInspectorDock />

        {/* Far-right tool rail — always visible. */}
        <EditorToolRail
          hasAnalysis={hasAnalysis}
          isAnalyzingNow={isAnalyzingNow}
          canAnalyze={canAnalyze}
          analyzeTitle={analyzeTitle}
          onReanalyze={() => setAnalysisOptionsOpen(true)}
        />
      </div>

      {/* ── Overlay drawers — temporary, never resize the preview. ────────── */}
      <EditorDrawer
        open={navOpen}
        onClose={() => setNavOpen(false)}
        side="left"
        ariaLabel="Framevo navigation"
        widthClass="w-72"
      >
        <SidebarNav onNavigate={() => setNavOpen(false)} />
      </EditorDrawer>

      {/* ── Editing dialogs (shared shell) ────────────────────────────────── */}
      <AnalysisOptionsModal
        open={analysisOptionsOpen}
        onClose={() => setAnalysisOptionsOpen(false)}
        hasExistingEdits={hasAnalysis}
        initialVideoType={selectedVideoType}
        onSelectVideoType={(t) => void setSelectedVideoType(t)}
        lastRunOptions={lastRun}
        corePrefs={settings.analysisEngines}
        onPersistCorePrefs={(core) => void save({ analysisEngines: core })}
        videoDuration={project.duration ?? 0}
        initialDetail={settings.analysisDetail}
        onPersistDetail={(detail) => void save({ analysisDetail: detail })}
        onConfirm={(opts) => {
          setAnalysisOptionsOpen(false);
          void startAnalyze(opts);
        }}
      />
      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />

      {/* Debug overlay — Ctrl+Shift+D in dev / ?debug=1 anywhere. */}
      <DebugOverlay />
    </div>
  );
}

/**
 * First-run call to action — a compact strip under the top bar (the old
 * full-size hero card would push the preview off-balance in the fullscreen
 * shell). Disappears as soon as a first draft exists.
 */
function PreAnalysisBanner({
  analyzing,
  canAnalyze,
  title,
  onGenerate,
}: {
  analyzing: boolean;
  canAnalyze: boolean;
  title?: string;
  onGenerate: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/[0.06] bg-violet-500/[0.04] px-4 py-2.5">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-200 ring-1 ring-violet-400/25">
        <Sparkles size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-white">
          Generate your AI edit
        </p>
        <p className="hidden truncate text-[11.5px] text-fog sm:block">
          Framevo builds a first-draft edit — cuts, zooms, speed changes, captions —
          that you refine on the timeline.
        </p>
      </div>
      <Button
        onClick={onGenerate}
        variant="primary"
        size="sm"
        disabled={!canAnalyze}
        title={title}
        leftIcon={
          analyzing ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Sparkles size={14} />
          )
        }
      >
        {analyzing ? "Analyzing…" : "Generate AI Edit"}
      </Button>
    </div>
  );
}
