"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X as XIcon } from "lucide-react";
import { useEditorReal } from "./context";
import { MomentInspector } from "./MomentInspector";

/**
 * Floating "moment editor" — wraps `MomentInspector` in a backdrop/portal so it
 * pops up on add (toolbar buttons) or edit (pill pencil icon) instead of taking
 * permanent space in the page flow.
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
  // (which clears multi-select). The modal taking priority feels right when
  // it's open.
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

  // Lock body scroll while open.
  React.useEffect(() => {
    if (!visible) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [visible]);

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          key="moment-inspector-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[115] flex items-center justify-center bg-ink/80 px-4 py-6 backdrop-blur-xl"
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            className="relative flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden shadow-cinematic"
          >
            <button
              type="button"
              onClick={closeInspector}
              aria-label="Close moment editor"
              title="Close (Esc)"
              className="absolute right-3 top-3 z-20 inline-flex size-8 items-center justify-center rounded-full border border-white/15 bg-ink/90 text-fog backdrop-blur-md transition-colors duration-150 hover:border-white/30 hover:text-white"
            >
              <XIcon size={14} />
            </button>
            {/* Inner scrollable region — keeps the scrollbar inside the card
                so backdrop clicks (and accidental scrollbar grabs) don't leak
                to the overlay. The overlay itself no longer scrolls or
                closes on outside clicks; only the X / Esc dismiss it. */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <MomentInspector />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
