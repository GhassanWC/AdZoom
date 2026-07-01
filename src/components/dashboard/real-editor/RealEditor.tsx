"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Sparkles,
  Loader2,
  AlertCircle,
  Pencil,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeProject, updateProject } from "@/lib/firebase/projects";
import { cn } from "@/lib/cn";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { FREE_VIDEO_DURATION_LIMIT_MESSAGE } from "@/lib/usage/plan";
import { Button } from "@/components/ui/Button";
import { EditorRealProvider, useEditorReal } from "./context";
import { RealVideoPlayer } from "./RealVideoPlayer";
import { RemotionPreviewPanel } from "./RemotionPreviewPanel";
import { RealTimeline } from "./RealTimeline";
import { MomentInspectorModal } from "./MomentInspectorModal";
import { EffectsModal } from "./EffectsModal";
import { ExportModal } from "./ExportModal";
import { CanvasModal } from "./CanvasModal";
import { AnalysisOptionsModal } from "./AnalysisOptionsModal";
import { VideoTypePicker } from "./VideoTypePicker";
import { RecipeSummary } from "./RecipeSummary";
import { DEFAULT_ANALYSIS_OPTIONS } from "@/lib/analysis/engine-layers";
import type { SelectedVideoType } from "@/lib/firebase/schema";
import { useWorkspaceSettings } from "@/lib/firebase/workspace-settings";
import { RealProcessingOverlay } from "./RealProcessingOverlay";
import { PresetsRail } from "./PresetsRail";
import { RecommendedPresets } from "./RecommendedPresets";
import { ProcessingMiniPill } from "./ProcessingMiniPill";
import { EditorActions } from "./EditorActions";
import { AIConfidencePanel } from "./AIConfidencePanel";
import { SuggestionsPanel } from "./SuggestionsPanel";
import { WorkflowStepper, type WorkflowStep } from "./WorkflowStepper";
import { DebugOverlay } from "./DebugOverlay";
import { ClickPipelinePanel } from "./ClickPipelinePanel";
import { EditDiagnosticsPanel } from "./EditDiagnosticsPanel";
import { CvDebugPanel } from "./CvDebugPanel";
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
      <div className="glass mx-auto max-w-lg rounded-2xl p-8 text-center">
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
    );
  }

  if (!project) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
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

function Body() {
  const {
    project,
    uid,
    startAnalyze,
    analyzing,
    analyzeError,
    canvasOpen,
    openCanvas,
    closeCanvas,
    cropEditing,
    openCropEditor,
    closeCropEditor,
    selectedVideoType,
    setSelectedVideoType,
  } = useEditorReal();
  const hasAnalysis = (project.analysis?.detectedMoments?.length ?? 0) > 0;
  const isFailed = project.analysis?.status === "failed";
  // A draft is "missing" whenever there's nothing to edit — fresh upload,
  // failed run, or a completed run that produced zero moments (e.g. a quiet
  // recording or a preset rebalance that dropped everything below the floor).
  // In every such case the primary "Analyze with AI" CTA must be reachable;
  // before the fix this button vanished after `project.status` moved off
  // "uploaded" yet `detectedMoments` stayed empty.
  const isAnalyzingNow = analyzing || project.status === "analyzing";
  const canAnalyze = !isAnalyzingNow && !!project.originalVideoUrl;
  const [effectsOpen, setEffectsOpen] = React.useState(false);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [analysisOptionsOpen, setAnalysisOptionsOpen] = React.useState(false);
  const { settings, save } = useWorkspaceSettings();

  const currentStep: WorkflowStep = !hasAnalysis
    ? "analyze"
    : project.status === "exported"
    ? "export"
    : "refine";

  const analyzeTitle = isFailed
    ? "The previous analysis failed — try again."
    : !hasAnalysis && project.analysis?.status === "complete"
      ? "No moments were produced — re-run to try again."
      : undefined;

  // One-click "Generate AI Edit": run analysis with the user's remembered engine
  // + detail prefs (all engines on by default). `startAnalyze` attaches the
  // selected video type. Advanced options remain a click away (the modal).
  const onGenerate = React.useCallback(() => {
    if (!canAnalyze) return;
    void startAnalyze({
      ...DEFAULT_ANALYSIS_OPTIONS,
      ...(settings.analysisEngines ?? {}),
      ...(settings.analysisDetail ?? {}),
      existingEditMode: "replace-selected",
    });
  }, [canAnalyze, startAnalyze, settings.analysisEngines, settings.analysisDetail]);

  return (
    <div className="space-y-6 pb-12">
      {/* ── 1. Top bar ───────────────────────────────────────────────────────
          A real editor top bar: back link + actions on one utility row, then
          the editable title, status, summary, and metadata chips. Export is
          the single primary action; all project tools live in one grouped,
          visually-secondary cluster (`EditorActions`). */}
      <header className="space-y-4">
        {/* Utility row — back link (left) + actions (right). */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/dashboard/projects"
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-fog transition-colors duration-200 hover:text-white"
          >
            <ArrowLeft size={13} />
            All projects
          </Link>

          <EditorActions
            hasAnalysis={hasAnalysis}
            isAnalyzingNow={isAnalyzingNow}
            canAnalyze={canAnalyze}
            analyzeTitle={analyzeTitle}
            cropEditing={cropEditing}
            onAnalyze={() => setAnalysisOptionsOpen(true)}
            onToggleCrop={cropEditing ? closeCropEditor : openCropEditor}
            onCanvas={openCanvas}
            onEffects={() => setEffectsOpen(true)}
            onExport={() => setExportOpen(true)}
          />
        </div>

        {/* Title + lightweight status, then summary + chips. */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <EditableProjectTitle
              uid={uid}
              projectId={project.id}
              title={project.title}
            />
            <StatusBadge status={headerStatus(project, hasAnalysis)} />
          </div>

          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-fog">
            {summaryLine(project)}
          </p>

          {project.analysis?.videoType && (
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-violet-400/25 bg-violet-500/[0.08] px-2.5 py-1 text-[11.5px] font-medium tracking-tight text-violet-200">
                <Sparkles size={11} className="text-violet-300" />
                {prettyVideoType(project.analysis.videoType)}
              </span>
              {(project.analysis.narrativeStructure?.length ?? 0) > 0 && (
                <span className="inline-flex items-center rounded-md border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-[11.5px] font-medium tracking-tight text-fog">
                  {project.analysis.narrativeStructure!.length}-act narrative
                </span>
              )}
              {(project.analysis.detectedMoments?.length ?? 0) > 0 && (
                <span className="inline-flex items-center rounded-md border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-[11.5px] font-medium tracking-tight text-fog">
                  {project.analysis.detectedMoments!.length} cinematic moments
                </span>
              )}
            </div>
          )}

          {project.analysis?.editRecipe && (
            <RecipeSummary
              recipe={project.analysis.editRecipe}
              moments={project.analysis.detectedMoments ?? []}
            />
          )}
        </div>
      </header>

      {/* ── 2. Workflow stepper ──────────────────────────────────────────── */}
      <WorkflowStepper current={currentStep} />

      {analyzeError && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-200">
          <AlertCircle size={14} className="shrink-0" />
          <span className="flex-1">{analyzeError}</span>
          {analyzeError === FREE_VIDEO_DURATION_LIMIT_MESSAGE && (
            <Link
              href="/pricing"
              className="shrink-0 rounded-md border border-rose-300/40 bg-rose-400/15 px-2.5 py-1 text-[12px] font-semibold text-rose-50 transition-colors hover:bg-rose-400/25"
            >
              Upgrade
            </Link>
          )}
        </div>
      )}

      {/* ── 3. Pre-analysis hero — the first-run call to action. Export is the
              header's primary, so Analyze gets a prominent home in the work
              area until a first-draft edit exists. */}
      {!hasAnalysis && (
        <PreAnalysisHero
          analyzing={isAnalyzingNow}
          canAnalyze={canAnalyze}
          title={analyzeTitle}
          selectedVideoType={selectedVideoType}
          onSelectType={(t) => void setSelectedVideoType(t)}
          onGenerate={onGenerate}
          onAdvanced={() => setAnalysisOptionsOpen(true)}
        />
      )}

      {/* ── 4. Preview — full width, centered, owns the row. Moment editing
              opens in the centered floating inspector (no backdrop), so the
              player stays large and visible while you edit. */}
      <div className="space-y-4">
        <RealVideoPlayer />
        {/* Flag-gated Remotion preview, alongside (never replacing) the canvas
            preview above — visible only when NEXT_PUBLIC_REMOTION_PREVIEW is on. */}
        <RemotionPreviewPanel />
      </div>

      {/* ── 5. Full-width timeline ───────────────────────────────────────── */}
      <RealTimeline />

      {/* ── 5b. AI analysis — directly under the timeline, full width: the
              engagement summary + the accept/dismiss suggestions, on every
              screen. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AIConfidencePanel />
        <SuggestionsPanel />
      </div>

      {/* ── 6. Click pipeline diagnostics — dev-visible; in production
              hidden unless ?debug=1 / Ctrl+Shift+D. ─────────────────────── */}
      <ClickPipelinePanel />

      {/* ── 6b. Edit-coverage funnel — internal/dev-only (?debug=1). ────── */}
      <EditDiagnosticsPanel />

      {/* ── 6c. CV tuning panel — internal/dev-only (?debug=1). ─────────── */}
      <CvDebugPanel />

      {/* ── 7. Presets — recommended hero + full rail ─────────────────────── */}
      <RecommendedPresets />
      <PresetsRail />

      {/* ── 6. Sheets: Effects + Export are now modal dialogs ──────────────── */}
      <AnalysisOptionsModal
        open={analysisOptionsOpen}
        onClose={() => setAnalysisOptionsOpen(false)}
        hasExistingEdits={hasAnalysis}
        initialEnginePrefs={settings.analysisEngines}
        onPersistEnginePrefs={(prefs) => void save({ analysisEngines: prefs })}
        videoDuration={project.duration ?? 0}
        initialDetail={settings.analysisDetail}
        onPersistDetail={(detail) => void save({ analysisDetail: detail })}
        onConfirm={(opts) => {
          setAnalysisOptionsOpen(false);
          void startAnalyze(opts);
        }}
      />
      <EffectsModal open={effectsOpen} onClose={() => setEffectsOpen(false)} />
      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
      <CanvasModal open={canvasOpen} onClose={closeCanvas} />

      {/* Debug overlay — Ctrl+Shift+D in dev / ?debug=1 anywhere. */}
      <DebugOverlay />
    </div>
  );
}

/**
 * First-run hero. Export owns the header's single primary slot, so the
 * Analyze call-to-action gets a prominent, self-explanatory home in the work
 * area until a first-draft edit exists.
 */
function PreAnalysisHero({
  analyzing,
  canAnalyze,
  title,
  selectedVideoType,
  onSelectType,
  onGenerate,
  onAdvanced,
}: {
  analyzing: boolean;
  canAnalyze: boolean;
  title?: string;
  selectedVideoType: SelectedVideoType;
  onSelectType: (t: SelectedVideoType) => void;
  onGenerate: () => void;
  onAdvanced: () => void;
}) {
  return (
    <div className="glass relative overflow-hidden rounded-2xl p-6 sm:p-7">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-14 h-48 w-72 bg-[radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.18),transparent_65%)] blur-2xl"
      />
      <div className="relative">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-200 ring-1 ring-violet-400/25 shadow-[0_8px_24px_-12px_rgba(139,92,246,0.6)]">
            <Sparkles size={20} />
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold tracking-tight text-white">
              What kind of video is this?
            </h2>
            <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-fog">
              Pick a type so Framevo applies the best edit recipe — or let it Auto
              Detect. You can refine every zoom, cut, and speed change on the
              timeline afterward.
            </p>
          </div>
        </div>

        <div className="mt-5">
          <VideoTypePicker
            value={selectedVideoType}
            onChange={onSelectType}
            disabled={analyzing}
          />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <Button
            onClick={onGenerate}
            variant="primary"
            size="md"
            disabled={!canAnalyze}
            title={title}
            leftIcon={
              analyzing ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Sparkles size={16} />
              )
            }
          >
            {analyzing ? "Analyzing…" : "Generate AI Edit"}
          </Button>
          <Button onClick={onAdvanced} variant="ghost" size="md" disabled={analyzing}>
            Advanced options
          </Button>
        </div>
      </div>
    </div>
  );
}

function prettyVideoType(t: string): string {
  switch (t) {
    case "coding-tutorial":
      return "Coding tutorial";
    case "saas-demo":
      return "SaaS demo";
    case "talking-tutorial":
      return "Talking tutorial";
    case "presentation":
      return "Presentation";
    case "vertical-short":
      return "Vertical short";
    case "onboarding-flow":
      return "Onboarding flow";
    default:
      return t;
  }
}

function summaryLine(p: ProjectDoc): string {
  if (p.status === "analyzing") return "AI is analyzing this recording…";
  if (p.status === "uploading") return "Uploading…";
  if (p.status === "failed")
    return p.analysis?.errorMessage || "Something went wrong. Try re-analyzing.";
  const a = p.analysis;
  if (a && a.status === "complete") {
    return "Your first-draft edit is ready — drag, retime, and reframe any moment.";
  }
  return "Ready for AI analysis — it'll give you a first-draft edit to refine.";
}

/* ── Header building blocks ────────────────────────────────────────────────
   Small, self-contained pieces for the redesigned header: a lightweight
   status pill and an inline-editable project title. */

type HeaderStatus = {
  label: string;
  dotClass: string;
  textClass: string;
  /** Animate the dot while work is in flight. */
  pulse?: boolean;
};

function headerStatus(p: ProjectDoc, hasAnalysis: boolean): HeaderStatus {
  switch (p.status) {
    case "analyzing":
      return { label: "Analyzing", dotClass: "bg-amber-400", textClass: "text-amber-200/90", pulse: true };
    case "uploading":
      return { label: "Uploading", dotClass: "bg-sky-400", textClass: "text-sky-200/90", pulse: true };
    case "failed":
      return { label: "Needs attention", dotClass: "bg-rose-400", textClass: "text-rose-200/90" };
    case "exported":
      return { label: "Exported", dotClass: "bg-emerald-400", textClass: "text-emerald-200/90" };
    default:
      return hasAnalysis
        ? { label: "Draft", dotClass: "bg-violet-400", textClass: "text-violet-200/90" }
        : { label: "New", dotClass: "bg-white/40", textClass: "text-fog" };
  }
}

function StatusBadge({ status }: { status: HeaderStatus }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.02] px-2 py-0.5 text-[11px] font-medium">
      <span className="relative flex size-1.5">
        {status.pulse && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
              status.dotClass
            )}
          />
        )}
        <span className={cn("relative inline-flex size-1.5 rounded-full", status.dotClass)} />
      </span>
      <span className={status.textClass}>{status.label}</span>
    </span>
  );
}

/**
 * Inline-editable project title. Renders as a heading-styled button; clicking
 * it (or its pencil affordance) swaps in an input that visually matches the
 * heading, so renaming happens in place. Enter / blur commits via
 * `updateProject`; Escape reverts. The realtime `subscribeProject` listener
 * pushes the saved title back down as `project.title`.
 */
function EditableProjectTitle({
  uid,
  projectId,
  title,
}: {
  uid: string;
  projectId: string;
  title: string;
}) {
  const toast = useToast();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(title);
  const [saving, setSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Keep the field in sync when the title changes elsewhere (other tab,
  // realtime update) and we're not mid-edit.
  React.useEffect(() => {
    if (!editing) setValue(title);
  }, [title, editing]);

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = React.useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === title) {
      setValue(title);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await updateProject(uid, projectId, { title: trimmed });
      setEditing(false);
    } catch (err) {
      toast.error(
        "Couldn't rename project",
        err instanceof Error ? err.message : undefined
      );
      setValue(title);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [value, title, uid, projectId, toast]);

  // Shared type scale so the input reads as the heading it replaces.
  const titleType =
    "font-display text-2xl font-semibold leading-tight tracking-tight text-white sm:text-[28px]";

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        disabled={saving}
        maxLength={120}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setValue(title);
            setEditing(false);
          }
        }}
        aria-label="Project title"
        className={cn(
          titleType,
          "-mx-2.5 w-full max-w-xl rounded-lg border border-violet-400/40 bg-white/[0.03] px-2.5 py-0.5 outline-none transition-colors duration-150 focus:border-violet-400/70 disabled:opacity-60"
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Rename project"
      className="group/title -mx-2.5 inline-flex min-w-0 max-w-full items-center gap-2 rounded-lg px-2.5 py-0.5 text-left transition-colors duration-150 hover:bg-white/[0.03] focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-400/40"
    >
      <span className={cn(titleType, "truncate")}>{title}</span>
      <Pencil
        size={14}
        className="shrink-0 text-fog opacity-0 transition-opacity duration-150 group-hover/title:opacity-100"
      />
    </button>
  );
}
