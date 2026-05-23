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
} from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeProject } from "@/lib/firebase/projects";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { Button } from "@/components/ui/Button";
import { EditorRealProvider, useEditorReal } from "./context";
import { RealVideoPlayer } from "./RealVideoPlayer";
import { RealTimeline } from "./RealTimeline";
import { MomentInspectorModal } from "./MomentInspectorModal";
import { EffectsModal } from "./EffectsModal";
import { ExportModal } from "./ExportModal";
import { RealProcessingOverlay } from "./RealProcessingOverlay";
import { PresetsRail } from "./PresetsRail";
import { RecommendedPresets } from "./RecommendedPresets";
import { ProcessingMiniPill } from "./ProcessingMiniPill";
import { WorkflowStepper, type WorkflowStep } from "./WorkflowStepper";
import { EditorToolbar } from "./EditorToolbar";
import { DebugOverlay } from "./DebugOverlay";
import { disposeThumbnails } from "./timeline/thumbnails";

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
  const { project, startAnalyze, analyzing, analyzeError } = useEditorReal();
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
      {/* ── 1. Title row ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <Link
            href="/dashboard/projects"
            className="inline-flex items-center gap-1.5 text-xs text-fog transition-colors duration-200 hover:text-white"
          >
            <ArrowLeft size={12} />
            All projects
          </Link>
          <h1 className="mt-2 font-display text-[34px] font-semibold leading-[1.05] tracking-tight text-white sm:text-[42px]">
            {project.title}
          </h1>
          <p className="mt-2.5 max-w-2xl text-[14.5px] leading-relaxed text-fog">
            {summaryLine(project)}
          </p>
          {project.analysis?.videoType && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-gradient-to-r from-violet-500/15 to-violet-500/[0.04] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-violet-100 shadow-[0_6px_20px_-14px_rgba(139,92,246,0.7)]">
                <Sparkles size={11} />
                {prettyVideoType(project.analysis.videoType)}
              </span>
              {(project.analysis.narrativeStructure?.length ?? 0) > 0 && (
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-fog">
                  {project.analysis.narrativeStructure!.length}-act narrative
                </span>
              )}
              {(project.analysis.detectedMoments?.length ?? 0) > 0 && (
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-fog">
                  {project.analysis.detectedMoments!.length} cinematic moments
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!hasAnalysis ? (
            <Button
              onClick={startAnalyze}
              variant="primary"
              size="md"
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
              size="md"
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
            onClick={() => setEffectsOpen(true)}
            variant="ghost"
            size="md"
            leftIcon={<SlidersHorizontal size={14} />}
          >
            Effects
          </Button>
          <Button
            onClick={() => setExportOpen(true)}
            variant="primary"
            size="md"
            leftIcon={<Download size={14} />}
          >
            Export
          </Button>
        </div>
      </div>

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
      <div className="min-w-0 space-y-4">
        <RealVideoPlayer />
        {/* Toolbar is always available — manual editing shouldn't require
            running AI analysis first. */}
        <EditorToolbar />
      </div>

      {/* ── 4. Full-width timeline ───────────────────────────────────────── */}
      <RealTimeline />

      {/* ── 5. Presets — recommended hero + full rail ─────────────────────── */}
      <RecommendedPresets />
      <PresetsRail />

      {/* ── 6. Sheets: Effects + Export are now modal dialogs ──────────────── */}
      <EffectsModal open={effectsOpen} onClose={() => setEffectsOpen(false)} />
      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />

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
    const n = a.detectedMoments?.length ?? 0;
    return `AI drafted ${n} edit${n === 1 ? "" : "s"} — drag, retime, reframe, and refine them. The timeline is yours now.`;
  }
  return "Ready for AI analysis — it'll give you a first-draft edit to refine.";
}
