"use client";

import * as React from "react";
import { useEditorReal } from "./context";
import {
  MIN_PREVIEW_PX,
  MIN_TIMELINE_PX,
  MODE_FRACTION,
  FRACTION_MIN,
  FRACTION_MAX,
  KEY_STEP,
  clampSplitFraction,
  splitGridRows,
} from "./workspace-split";

/**
 * Fixed-height, resizable vertical split for the editor: the preview occupies
 * the TOP region, the timeline (which now hosts the unified control bar itself)
 * the BOTTOM, with a thin draggable grip between them. The whole thing fills
 * its parent (clamped to the viewport below the header), so the PAGE never
 * scrolls — only the timeline scrolls internally, and the preview stays
 * visible while editing.
 *
 * Layout is a CSS grid whose row template encodes the split ratio:
 *   [ preview (fr, min 280) ][ grip (auto) ][ timeline (fr, min 300) ]
 * The `minmax(min, fr)` tracks keep the ratio responsive to window size AND
 * enforce a usable minimum for each pane. During a drag we mutate the grid
 * style DIRECTLY on the DOM node (no React state churn → no expensive
 * re-render of the preview) and only commit the ratio to context (+
 * localStorage) on release. The ratio itself lives in context — not local
 * state — so the unified bar's Preview/Balanced/Timeline buttons (rendered
 * far away, inside the timeline) can read/set the very same value.
 */
export function EditorSplitWorkspace({
  preview,
  timeline,
}: {
  preview: React.ReactNode;
  timeline: React.ReactNode;
}) {
  const { splitFraction: fraction, setSplitFraction: commit } = useEditorReal();

  const workspaceRef = React.useRef<HTMLDivElement | null>(null);
  const previewRef = React.useRef<HTMLDivElement | null>(null);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<{
    startY: number;
    startPreview: number;
    available: number;
    live: number;
  } | null>(null);

  // ── Pointer drag — mutate the grid rows DIRECTLY (no re-render) until release.
  const onPointerDown = React.useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const prev = previewRef.current;
    const bot = bottomRef.current;
    if (!prev || !bot) return;
    e.preventDefault();
    const startPreview = prev.offsetHeight;
    const available = startPreview + bot.offsetHeight;
    dragRef.current = { startY: e.clientY, startPreview, available, live: fraction };

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      const node = workspaceRef.current;
      if (!d || !node) return;
      const max = Math.max(MIN_PREVIEW_PX, d.available - MIN_TIMELINE_PX);
      let px = d.startPreview + (ev.clientY - d.startY);
      px = Math.max(MIN_PREVIEW_PX, Math.min(px, max));
      const f = d.available > 0 ? px / d.available : fraction;
      d.live = f;
      node.style.gridTemplateRows = splitGridRows(f); // live, no React
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (d) commit(d.live);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [fraction, commit]);

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      // Up = more timeline (smaller preview); Down = more preview.
      if (e.key === "ArrowUp") {
        e.preventDefault();
        commit(fraction - KEY_STEP);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        commit(fraction + KEY_STEP);
      } else if (e.key === "Home" || e.key === "Enter") {
        e.preventDefault();
        commit(MODE_FRACTION.balanced);
      }
    },
    [fraction, commit]
  );

  return (
    <div
      ref={workspaceRef}
      // Hold region: dragging the grip / clicking anywhere in the workspace
      // must not dismiss the floating moment inspector.
      data-editor-dialog-hold
      className="grid min-h-0 flex-1 overflow-hidden"
      style={{ gridTemplateRows: splitGridRows(clampSplitFraction(fraction)) }}
    >
      {/* Preview pane (row 1) — RealVideoPlayer fill-fits this box. */}
      <section
        ref={previewRef}
        className="relative min-h-0 overflow-hidden px-3 py-2 sm:px-4"
      >
        {preview}
      </section>

      {/* Thin resize grip (row 2) — no border/background of its own so it
          doesn't read as a fourth "section"; just a drag affordance. The
          Preview/Balanced/Timeline mode buttons live in the unified control
          bar now (row 1 of the timeline pane below). */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize preview and timeline"
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={Math.round(FRACTION_MIN * 100)}
        aria-valuemax={Math.round(FRACTION_MAX * 100)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onDoubleClick={() => commit(MODE_FRACTION.balanced)}
        onKeyDown={onKeyDown}
        title="Drag to resize · double-click to reset · ↑/↓ to adjust"
        className="group relative z-10 flex h-2 shrink-0 cursor-row-resize items-center justify-center outline-none focus-visible:bg-violet-500/10"
      >
        <div className="h-1 w-10 rounded-full bg-white/10 transition-colors duration-150 group-hover:bg-white/25 group-focus-visible:bg-violet-400/60" />
      </div>

      {/* Timeline region (row 3) — fills remaining height; its own unified
          control bar + optional scenes strip sit at its top, then the
          internally-scrolling lanes. */}
      <section ref={bottomRef} className="flex min-h-0 flex-col overflow-hidden">
        {timeline}
      </section>
    </div>
  );
}
