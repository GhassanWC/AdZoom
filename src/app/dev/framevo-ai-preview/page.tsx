"use client";

/**
 * DEV-ONLY preview of the Framevo AI panel states — the screenshot rig for the
 * unification work and a quick visual harness while iterating on the panel.
 * Renders the REAL components inside the REAL provider with fixture projects.
 * Returns 404 outside development.
 */
import * as React from "react";
import { notFound } from "next/navigation";
import { Zap, Scissors, Captions as CaptionsIcon, Sparkles } from "lucide-react";
import { EditorRealProvider } from "@/components/dashboard/real-editor/context";
import { EditorUnifiedControlBar } from "@/components/dashboard/real-editor/EditorUnifiedControlBar";
import { FramevoAIPanel } from "@/components/dashboard/real-editor/FramevoAIPanel";
import { FramevoAISetup } from "@/components/dashboard/real-editor/FramevoAISetup";
import { DEFAULT_EFFECTS_SETTINGS, type DetectedMoment, type ProjectDoc } from "@/lib/firebase/schema";

const NOW = Date.now();

function moment(
  id: string,
  startTime: number,
  endTime: number,
  effectType: DetectedMoment["effectType"],
  extra: Partial<DetectedMoment> = {}
): DetectedMoment {
  return {
    id,
    startTime,
    endTime,
    label: `Edit ${id}`,
    reason: "Fixture edit for the dev preview",
    focusRegion: { x: 0.35, y: 0.3, width: 0.3, height: 0.3 },
    effectType,
    source: "ai",
    provenance: "cv",
    ...extra,
  } as DetectedMoment;
}

function baseProject(over: Partial<ProjectDoc>): ProjectDoc {
  return {
    id: `preview-${over.status ?? "p"}`,
    userId: "preview",
    title: "Quarterly product walkthrough",
    originalVideoUrl: "https://example.com/preview.mp4",
    storagePath: "preview/preview.mp4",
    duration: 214,
    width: 1920,
    height: 1080,
    status: "uploaded",
    effectsSettings: { ...DEFAULT_EFFECTS_SETTINGS },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as ProjectDoc;
}

const SETUP_PROJECT = baseProject({
  selectedVideoType: "tutorial",
  editingTemplateId: "tutorial-step-clear",
  directorBrief: {
    prompt: "",
    form: { platform: "youtube", aspectRatio: "16:9", captionStyle: "clean", cta: "auto" },
    updatedAt: NOW,
  },
});

const WORKING_PROJECT = baseProject({
  status: "generating_timeline",
  selectedVideoType: "tutorial",
  editingTemplateId: "tutorial-step-clear",
  directorBrief: {
    prompt: "Keep it tight and clear for the docs page.",
    form: { platform: "youtube", aspectRatio: "16:9" },
    updatedAt: NOW,
  },
  analysis: {
    status: "analyzing",
    stage: "Building your edit",
    detectedMoments: [
      moment("cut-1", 20, 25, "cut"),
      moment("zoom-1", 40, 43, "zoom"),
      moment("zoom-2", 90, 93, "zoom"),
    ],
    boringSections: [],
    startedAt: NOW - 74_000,
    estimateSeconds: 140,
    activity: [
      { ts: NOW - 70_000, kind: "info", text: "Preparing AI analysis" },
      { ts: NOW - 55_000, kind: "ok", text: "Classified as talking tutorial · 4 narrative segments" },
      { ts: NOW - 40_000, kind: "ok", text: "Derived 9 moments from 14 interaction events" },
      { ts: NOW - 20_000, kind: "info", text: "Framevo AI is applying your instructions" },
    ],
    lastRunOptions: {
      generateCameraEdits: true,
      generateCut: true,
      generateSpeed: false,
      existingEditMode: "replace-selected",
      chunkMode: "balanced",
      chunkSizeSeconds: 30,
    },
  } as ProjectDoc["analysis"],
});

const DONE_PROJECT = baseProject({
  status: "analyzed",
  selectedVideoType: "talking-head",
  editingTemplateId: "talking-clean-pro",
  directorBrief: {
    prompt: "Clean this up for the team update.",
    form: { platform: "youtube", aspectRatio: "16:9", captionStyle: "clean", cta: "auto" },
    updatedAt: NOW,
  },
  analysis: {
    status: "complete",
    stage: "Complete",
    detectedMoments: [
      moment("cut-1", 18, 31, "cut"),
      moment("cut-2", 95, 121, "cut"),
      moment("cut-3", 180, 184, "cut"),
      moment("zoom-1", 59, 62, "zoom"),
      moment("zoom-2", 132, 135, "zoom"),
      moment("zoom-3", 168, 171, "zoom"),
      ...Array.from({ length: 14 }, (_, i) =>
        moment(`cap-${i}`, 6 + i * 14, 9 + i * 14, "captions")
      ),
      moment("hook-1", 0.2, 2.4, "hook-text"),
    ],
    boringSections: [],
    completedAt: NOW - 60_000,
    editorialPolicy: {
      templateId: "talking-clean-pro",
      templateVersion: 1,
      mode: "enforce",
      statuses: {
        zoom: "allowed",
        cut: "encouraged",
        captions: "encouraged",
        transition: "disabled-by-default",
        callout: "disabled-by-default",
        cursor_emphasis: "impossible",
        speed: "disabled-by-default",
      },
      reasons: {
        transition: "Clean Professional does not use this edit",
        callout: "Clean Professional does not use this edit",
        speed: "Clean Professional does not use this edit",
      },
    },
  } as ProjectDoc["analysis"],
});

function Frame({
  title,
  width = 480,
  height = 720,
  shot,
  children,
}: {
  title: string;
  width?: number;
  height?: number;
  shot: string;
  children: React.ReactNode;
}) {
  return (
    <div className="shrink-0">
      <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-white/50">
        {title}
      </p>
      <div
        data-shot={shot}
        style={{ width, height }}
        className="flex flex-col overflow-hidden rounded-xl border border-white/10 bg-surface shadow-2xl"
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/[0.06] px-3">
          <h2 className="text-[13px] font-semibold text-white">Framevo AI</h2>
          <span className="text-fog">×</span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

/** The timeline control bar, at a realistic editor width. */
function ControlBarPreview({ hiddenLayer }: { hiddenLayer: boolean }) {
  const noop = () => {};
  return (
    <EditorRealProvider uid={null} project={DONE_PROJECT} idTokenGetter={async () => null}>
      <div data-shot={hiddenLayer ? "control-bar" : "control-bar-clean"} className="w-[1400px]">
        <EditorUnifiedControlBar
          health="balanced"
          zoom={1}
          minZoom={0.5}
          maxZoom={8}
          onZoomIn={noop}
          onZoomOut={noop}
          onFit={noop}
          insightsOpen={false}
          onToggleInsights={noop}
          hasScenes
          layerRows={[
            { id: "camera", label: "Zooms & focus", count: 3, visible: true, Icon: Zap },
            { id: "cut", label: "Cuts", count: 3, visible: true, Icon: Scissors },
            { id: "captions", label: "Captions", count: 14, visible: !hiddenLayer, Icon: CaptionsIcon },
            { id: "hook-text", label: "Hook text", count: 1, visible: true, Icon: Sparkles },
          ]}
          onToggleLayer={noop}
          onShowAllLayers={noop}
          canUndo={false}
          canRedo={false}
          onUndo={noop}
          onRedo={noop}
          hasSelection={false}
          onAdd={noop}
          onDuplicate={noop}
          canSplit={false}
          onSplit={noop}
          onDelete={noop}
        />
      </div>
    </EditorRealProvider>
  );
}

export default function FramevoAIPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const noop = async () => null;

  return (
    <div className="min-h-dvh bg-ink p-8">
      <h1 className="mb-6 text-lg font-semibold text-white">
        Framevo AI — panel states (dev preview)
      </h1>

      <div className="mb-10 space-y-6">
        <div>
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-white/50">
            Timeline control bar — a layer hidden (undo/redo disabled)
          </p>
          <ControlBarPreview hiddenLayer />
        </div>
        <div>
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-white/50">
            Timeline control bar — all layers visible
          </p>
          <ControlBarPreview hiddenLayer={false} />
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-8">
        <Frame title="B · First-analysis setup" shot="setup" height={960}>
          <EditorRealProvider uid={null} project={SETUP_PROJECT} idTokenGetter={noop}>
            <FramevoAIPanel mode="instant" onModeChange={() => {}} />
          </EditorRealProvider>
        </Frame>

        <Frame title="E · Change setup" shot="setup-change" height={860}>
          <EditorRealProvider uid={null} project={SETUP_PROJECT} idTokenGetter={noop}>
            <FramevoAISetup
              mode="instant"
              onModeChange={() => {}}
              canAnalyze
              hasExistingEdits={false}
              initialChangeOpen
            />
          </EditorRealProvider>
        </Frame>

        <Frame title="F · Advanced" shot="setup-advanced" height={860}>
          <EditorRealProvider uid={null} project={SETUP_PROJECT} idTokenGetter={noop}>
            <FramevoAISetup
              mode="instant"
              onModeChange={() => {}}
              canAnalyze
              hasExistingEdits
              initialAdvancedOpen
            />
          </EditorRealProvider>
        </Frame>

        <Frame title="C · Working" shot="working">
          <EditorRealProvider uid={null} project={WORKING_PROJECT} idTokenGetter={noop}>
            <FramevoAIPanel mode="instant" onModeChange={() => {}} />
          </EditorRealProvider>
        </Frame>

        <Frame title="D · Conversation (completed)" shot="conversation">
          <EditorRealProvider uid={null} project={DONE_PROJECT} idTokenGetter={noop}>
            <FramevoAIPanel mode="instant" onModeChange={() => {}} />
          </EditorRealProvider>
        </Frame>
      </div>
    </div>
  );
}
