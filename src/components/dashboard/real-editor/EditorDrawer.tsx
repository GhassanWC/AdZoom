"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X as XIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { lockEditorScroll, unlockEditorScroll } from "./scroll-lock";

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Temporary overlay drawer for the fullscreen editor — used for the Framevo
 * navigation (left) and tool panels like Presets / Insights (right). Slides
 * over the editor WITHOUT resizing the preview; backdrop click, Escape, and
 * the ✕ button close it; focus moves in on open and returns to the trigger on
 * close. Only one drawer should be open at a time (the owner enforces that).
 *
 * NOTE (framer + position:fixed): the slide animation uses a transform, which
 * would trap `position: fixed` descendants (e.g. the Looks tab's save dialog).
 * framer-motion removes the inline transform once x reaches 0, so at rest —
 * the only time such dialogs can open — fixed positioning works normally.
 */
export function EditorDrawer({
  open,
  onClose,
  side = "right",
  title,
  ariaLabel,
  widthClass = "w-full max-w-xl",
  children,
}: {
  open: boolean;
  onClose: () => void;
  side?: "left" | "right";
  /** Optional pinned header title; pass ariaLabel instead for headerless drawers. */
  title?: string;
  ariaLabel?: string;
  widthClass?: string;
  children: React.ReactNode;
}) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();

  // Lock the background PAGE scroll while the drawer is open (the editor page
  // scrolls vertically). The drawer's own content region scrolls internally
  // (overflow-y-auto + overscroll-contain), so only the panel scrolls.
  React.useEffect(() => {
    if (!open) return;
    lockEditorScroll("editor-drawer");
    return () => unlockEditorScroll("editor-drawer");
  }, [open]);

  // Escape closes — capture phase so the timeline's Escape (clear
  // multi-select) doesn't swallow it.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Focus in on open, restore to the trigger on close.
  React.useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? panel).focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      const el = restoreFocusRef.current;
      if (el && document.contains(el)) el.focus();
    };
  }, [open]);

  // Keep Tab focus inside the drawer while it's open.
  const onTrapKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (items.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="editor-drawer-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onClose}
            className="fixed inset-0 z-[130] bg-ink/60 backdrop-blur-sm"
          />
          <motion.div
            key="editor-drawer-panel"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            data-editor-drawer
            {...(title ? { "aria-labelledby": titleId } : { "aria-label": ariaLabel })}
            tabIndex={-1}
            onKeyDown={onTrapKeyDown}
            initial={{ x: side === "left" ? "-100%" : "100%" }}
            animate={{ x: 0 }}
            exit={{ x: side === "left" ? "-100%" : "100%" }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "fixed inset-y-0 z-[131] flex flex-col bg-surface outline-none",
              side === "left"
                ? "left-0 border-r border-white/[0.06]"
                : "right-0 border-l border-white/[0.06]",
              widthClass
            )}
          >
            {title ? (
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3.5">
                <h2
                  id={titleId}
                  className="truncate font-display text-[15px] font-semibold tracking-tight text-white"
                >
                  {title}
                </h2>
                <DrawerCloseButton onClose={onClose} />
              </div>
            ) : (
              <div className="absolute right-3 top-3.5 z-10">
                <DrawerCloseButton onClose={onClose} />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {children}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}

function DrawerCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close panel"
      title="Close (Esc)"
      className="inline-flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-fog transition-colors duration-150 hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
    >
      <XIcon size={15} />
    </button>
  );
}
