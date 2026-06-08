"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Sparkles,
  Loader2,
  AlertCircle,
  RefreshCcw,
  Download,
  SlidersHorizontal,
  Frame,
  Pencil,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeProject, updateProject } from "@/lib/firebase/projects";
import { cn } from "@/lib/cn";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { Button } from "@/components/ui/Button";
import { EditorRealProvider, useEditorReal } from "./context";
import { RealVideoPlayer } from "./RealVideoPlayer";
import { RealTimeline } from "./RealTimeline";
import { MomentInspectorModal } from "./MomentInspectorModal";
import { EffectsModal } from "./EffectsModal";
import { ExportModal } from "./ExportModal";
import { CanvasModal } from "./CanvasModal";
import { RealProcessingOverlay } from "./RealProcessingOverlay";
import { PresetsRail } from "./PresetsRail";
import { RecommendedPresets } from "./RecommendedPresets";
import { ProcessingMiniPill } from "./ProcessingMiniPill";
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

  const currentStep: WorkflowStep = !hasAnalysis
    ? "analyze"
    : project.status === "exported"
    ? "export"
    : "refine";

  return (
    <div className="space-y-7 pb-12">
      {/* ── 1. Header ────────────────────────────────────────────────────────
          Four calm rows inside one block: a thin utility bar (back link +
          actions), the editable title with a lightweight status, the AI
          summary, then metadata chips. Open layout (no card) keeps it
          compact and premium — structure comes from spacing, not borders. */}
      <header className="space-y-4">
        {/* Utility bar — back link (left) + page actions (right). */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/dashboard/projects"
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-fog transition-colors duration-200 hover:text-white"
          >
            <ArrowLeft size={13} />
            All projects
          </Link>

          <div className="flex flex-wrap items-center gap-2">
            {!hasAnalysis ? (
              <Button
                onClick={startAnalyze}
                variant="primary"
                size="sm"
                leftIcon={
                  isAnalyzingNow ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Sparkles size={14} />
                  )
                }
                disabled={!canAnalyze}
                title={
                  isFailed
                    ? "The previous analysis failed — try again."
                    : project.analysis?.status === "complete"
                      ? "No moments were produced — re-run to try again."
                      : undefined
                }
              >
                {isAnalyzingNow ? "Analyzing…" : "Analyze with AI"}
              </Button>
            ) : (
              <Button
                onClick={startAnalyze}
                variant="ghost"
                size="sm"
                leftIcon={
                  isAnalyzingNow ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <RefreshCcw size={13} />
                  )
                }
                disabled={isAnalyzingNow}
              >
                Re-analyze
              </Button>
            )}
            <Button
              onClick={openCanvas}
              variant="ghost"
              size="sm"
              leftIcon={<Frame size={14} />}
            >
              Canvas
            </Button>
            <Button
              onClick={() => setEffectsOpen(true)}
              variant="ghost"
              size="sm"
              leftIcon={<SlidersHorizontal size={14} />}
            >
              Effects
            </Button>
            <Button
              onClick={() => setExportOpen(true)}
              variant="primary"
              size="sm"
              leftIcon={<Download size={14} />}
            >
              Export
            </Button>
          </div>
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
        </div>
      </header>

      {/* ── 2. Workflow stepper ──────────────────────────────────────────── */}
      <WorkflowStepper current={currentStep} />

      {analyzeError && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-200">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{analyzeError}</span>
        </div>
      )}

      {/* ── 3. Hero: cinematic preview spanning full width ──────────────── */}
      {!hasAnalysis && (
        <p className="text-sm text-fog">
          Run <strong className="text-white">Analyze with AI</strong> to generate a
          first-draft edit you can refine.
        </p>
      )}
      {/* ── 3b. Preview (full width) ─────────────────────────────────────
          The video preview gets the full content width — no reserved side
          rail. Moment settings open in a compact floating dialog
          (`MomentInspectorModal`) on Edit, so the player stays large and the
          crop box stays visible while editing. */}
      <div className="space-y-4">
        <RealVideoPlayer />
      </div>

      {/* ── 4. Full-width timeline ───────────────────────────────────────── */}
      <RealTimeline />

      {/* ── 4b. Click pipeline diagnostics — dev-visible; in production
              hidden unless ?debug=1 / Ctrl+Shift+D. ─────────────────────── */}
      <ClickPipelinePanel />

      {/* ── 4c. Edit-coverage funnel — internal/dev-only (?debug=1). ────── */}
      <EditDiagnosticsPanel />

      {/* ── 4d. CV tuning panel — internal/dev-only (?debug=1). ─────────── */}
      <CvDebugPanel />

      {/* ── 5. Presets — recommended hero + full rail ─────────────────────── */}
      <RecommendedPresets />
      <PresetsRail />

      {/* ── 6. Sheets: Effects + Export are now modal dialogs ──────────────── */}
      <EffectsModal open={effectsOpen} onClose={() => setEffectsOpen(false)} />
      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
      <CanvasModal open={canvasOpen} onClose={closeCanvas} />

      {/* Debug overlay — Ctrl+Shift+D in dev / ?debug=1 anywhere. */}
      <DebugOverlay />
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
