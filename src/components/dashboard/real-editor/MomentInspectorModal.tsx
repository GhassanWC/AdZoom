"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X as XIcon } from "lucide-react";
import { useEditorReal } from "./context";
import { MomentInspector } from "./MomentInspector";

function dialogDebugOn(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URL(window.location.href).searchParams.get("debug") === "1";
  } catch {
    return false;
  }
}

/**
 * Moment-settings dialog — a COMPACT FLOATING panel (not a full-screen modal),
 * centered on the page. It opens only when the user clicks Edit on a selected
 * moment (or adds one), never on plain selection. Deliberately:
 *
 *   - NO backdrop  → the full-width video preview + the draggable crop box stay
 *     fully visible and interactive while editing (crop framing needs the
 *     video, which sits "behind" where a modal backdrop would be).
 *   - NO body scroll lock → the page + horizontal timeline keep scrolling; this
 *     also removes the earlier "page frozen after Edit" class of bug entirely.
 *   - Esc / ✕ close. Outside-click is intentionally NOT a close trigger because
 *     the crop box lives on the video (outside the dialog) and dragging it must
 *     not dismiss the settings.
 *
 * `MomentInspector` (rendered inside) already shows the right controls per
 * effect type — crop, speed, or the zoom/focus/click set.
 */
export function MomentInspectorModal() {
  const {
    inspectorOpen,
    closeInspector,
    selectedMomentId,
    activeMoment,
    project,
  } = useEditorReal();

  const moments = project.analysis?.detectedMoments ?? [];
  const moment =
    moments.find((m) => m.id === selectedMomentId) || activeMoment || null;
  const visible = inspectorOpen && moment !== null;

  // Esc closes — capture phase so it wins over the timeline's Esc handler
  // (which clears multi-select).
  React.useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeInspector();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, closeInspector]);

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <>
      {dialogDebugOn() && (
        <div className="pointer-events-none fixed bottom-2 left-2 z-[200] rounded bg-black/85 px-2 py-1 font-mono text-[10px] leading-tight text-lime-300">
          settings-dialog: open={String(inspectorOpen)} · visible=
          {String(visible)}
        </div>
      )}
      <AnimatePresence>
        {visible && (
          <motion.div
            key="moment-settings-dialog"
            role="dialog"
            aria-label="Moment settings"
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            // Compact SOLID panel CENTERED on the page. No backdrop, so the
            // video edges + timeline around it stay visible/usable and there's
            // no dim or scroll-lock. `bg-panel` is opaque in both themes so
            // nothing bleeds through; strong border + shadow read as a real
            // floating inspector.
            //
            className="fixed left-1/2 top-1/2 z-[115] flex max-h-[80vh] w-[440px] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-white/[0.12] bg-panel shadow-cinematic"
          >
            <button
              type="button"
              onClick={closeInspector}
              aria-label="Close moment settings"
              title="Close (Esc)"
              className="absolute right-2.5 top-2.5 z-20 inline-flex size-7 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.06] text-fog transition-colors duration-150 hover:border-white/25 hover:text-white"
            >
              <XIcon size={14} />
            </button>
            {/* Inner scroll region — caps height + scrolls overflow. The
                panel above is the solid surface. */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <MomentInspector />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>,
    document.body
  );
}
