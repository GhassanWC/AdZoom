"use client";

import * as React from "react";
import { X as XIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useEditorReal, type RightTool } from "./context";
import { readPersistedNumber, writePersistedNumber } from "./timeline/utils";
import { RealCanvasPanel } from "./RealCanvasPanel";
import { RealCaptionsPanel } from "./RealCaptionsPanel";
import { ClipsPanel } from "./ClipsPanel";
import { PresetBrowserPanel } from "./PresetBrowserPanel";
import { RecipeSummary } from "./RecipeSummary";
import { AIConfidencePanel } from "./AIConfidencePanel";
import { SuggestionsPanel } from "./SuggestionsPanel";
import { RemotionPreviewPanel } from "./RemotionPreviewPanel";
import { ClickPipelinePanel } from "./ClickPipelinePanel";
import { EditDiagnosticsPanel } from "./EditDiagnosticsPanel";
import { CvDebugPanel } from "./CvDebugPanel";

// v2 key: the default width jumped from a fixed 340px to ~60% of the viewport —
// bump the storage key so returning users pick up the new default instead of
// being stuck at an old narrow persisted value.
const WIDTH_KEY = "framevo:editor-dock-width-v2";
const MIN_W = 320;
/** Absolute ceiling so ultra-wide monitors don't get a silly-wide panel. */
const MAX_W_CEILING = 1400;
/** The requested default open width: ~60% of the viewport. */
const DEFAULT_FRACTION = 0.6;
/** Must match EditorToolRail's fixed width (`w-14` = 56px) — the popup anchors
 *  flush against the rail's left edge. */
const RAIL_WIDTH = 56;

const TOOL_TITLE: Record<RightTool, string> = {
  canvas: "Canvas",
  captions: "Captions",
  // One presets surface: the library AND the whole-recording Looks (a tab in it).
  "presets-library": "Presets",
  insights: "Insights",
  clips: "Clips",
};

/** Resize ceiling — leaves at least ~15% of the viewport (minus the rail)
 *  visible for the center preview/timeline pane, capped at MAX_W_CEILING. */
function maxWidthPx(): number {
  if (typeof window === "undefined") return MAX_W_CEILING;
  return Math.max(
    MIN_W,
    Math.min(MAX_W_CEILING, Math.round(window.innerWidth * 0.85) - RAIL_WIDTH)
  );
}

function clampW(w: number): number {
  return Math.max(MIN_W, Math.min(maxWidthPx(), w));
}

/** Default open width — ~60% of the viewport, clamped to the usual bounds. */
function defaultWidthPx(): number {
  if (typeof window === "undefined") return 480;
  return clampW(Math.round(window.innerWidth * DEFAULT_FRACTION));
}

/**
 * The inspector panel — a floating POPUP anchored just left of the tool rail,
 * spanning the full workspace height. It overlays the preview + timeline
 * instead of squeezing them: opening/closing a tool never resizes or reflows
 * the workspace. Renders only when a tool is active; its own title + close
 * button; scrolls internally; closes on Escape; horizontally resizable via the
 * left-edge handle (persisted). Content reuses the existing panels — one
 * source of truth, no duplicated state.
 */

/** How long the exit animation runs — must match `.fv-panel-out` in globals.css. */
const CLOSE_MS = 140;

export function EditorInspectorDock() {
  const { activeTool, setActiveTool, project } = useEditorReal();
  const [width, setWidth] = React.useState<number>(() =>
    clampW(readPersistedNumber(WIDTH_KEY, defaultWidthPx()))
  );
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<{ startX: number; startW: number; live: number } | null>(null);

  /**
   * The panel has to outlive `activeTool` by one animation so it can animate OUT
   * — unmounting immediately is what made closing feel like the panel was
   * deleted rather than dismissed. `shownTool` is what we actually render;
   * `closing` swaps the enter animation for the (faster) exit one.
   *
   * Switching directly from one tool to another does NOT animate: it's the same
   * panel changing contents, and sliding it out and back in would be noise.
   */
  const [shownTool, setShownTool] = React.useState<RightTool | null>(activeTool);
  const [closing, setClosing] = React.useState(false);

  React.useEffect(() => {
    if (activeTool) {
      setShownTool(activeTool);
      setClosing(false);
      return;
    }
    // Tool cleared → play the exit, then unmount.
    setClosing(true);
    const t = setTimeout(() => {
      setShownTool(null);
      setClosing(false);
    }, CLOSE_MS);
    return () => clearTimeout(t);
  }, [activeTool]);

  React.useEffect(() => {
    if (!activeTool) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveTool(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTool, setActiveTool]);

  const onResizeDown = React.useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const el = panelRef.current;
      if (!el) return;
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startW: el.offsetWidth, live: width };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: PointerEvent) => {
        const d = dragRef.current;
        const node = panelRef.current;
        if (!d || !node) return;
        // Dragging LEFT (negative dx) widens the dock.
        const w = clampW(d.startW - (ev.clientX - d.startX));
        d.live = w;
        node.style.width = `${w}px`;
      };
      const onUp = () => {
        const d = dragRef.current;
        dragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (d) {
          setWidth(d.live);
          writePersistedNumber(WIDTH_KEY, d.live);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [width]
  );

  if (!shownTool) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`${TOOL_TITLE[shownTool]} panel`}
      // Hold region: selecting timeline items / editing here must not dismiss
      // the floating moment inspector.
      data-editor-dialog-hold
      // Floating popup — absolute + inset-y-0 (relative to the workspace row)
      // takes it OUT of flex flow, so it never resizes the preview/timeline.
      // Opaque background + shadow give it clear elevation over the video.
      //
      // Motion: slides in from the rail it's anchored to (12px, not off-screen —
      // a full-width slide would be theatre for a panel opened dozens of times a
      // session). Exit is quicker than enter.
      className={cn(
        "absolute inset-y-0 z-40 flex flex-col border-l border-white/[0.08] bg-surface shadow-[-16px_0_40px_-12px_rgba(0,0,0,0.6)]",
        closing ? "fv-panel-out" : "fv-panel-in"
      )}
      style={{ width, right: RAIL_WIDTH }}
    >
      {/* Left-edge resize handle. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector panel"
        onPointerDown={onResizeDown}
        className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
      >
        <div className="mx-auto h-full w-px bg-transparent transition-colors duration-150 group-hover:bg-violet-400/40" />
      </div>

      {/* Header — title + close. */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3">
        <h2 className="truncate text-[13px] font-semibold text-white">
          {TOOL_TITLE[shownTool]}
        </h2>
        <button
          type="button"
          onClick={() => setActiveTool(null)}
          aria-label="Close panel"
          title="Close"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
        >
          <XIcon size={15} />
        </button>
      </div>

      {/* Body — scrolls internally. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {shownTool === "clips" && <ClipsPanel />}
        {shownTool === "canvas" && <RealCanvasPanel />}
        {shownTool === "captions" && <RealCaptionsPanel />}
        {shownTool === "presets-library" && <PresetBrowserPanel />}
        {shownTool === "insights" && (
          <div className="space-y-4 p-4">
            {project.analysis?.editRecipe && (
              <RecipeSummary
                recipe={project.analysis.editRecipe}
                moments={project.analysis.detectedMoments ?? []}
                transcript={project.analysis.transcript}
                audioAnalysis={project.analysis.audioAnalysis}
                onGenerateCaptions={() => setActiveTool("captions")}
              />
            )}
            <AIConfidencePanel />
            <SuggestionsPanel />
            {/* Flag / ?debug=1 gated — render null in normal use. */}
            <RemotionPreviewPanel />
            <ClickPipelinePanel />
            <EditDiagnosticsPanel />
            <CvDebugPanel />
          </div>
        )}
      </div>
    </div>
  );
}
