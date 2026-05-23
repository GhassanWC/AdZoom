"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X as XIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Shared modal shell used by the Effects and Export dialogs. Behaviour matches
 * `MomentInspectorModal`:
 *   - Renders into a portal at <body>
 *   - Esc closes (capture phase, so it wins over other window listeners)
 *   - Backdrop click does NOT close — avoids the "lost work via stray drag"
 *     trap; only the explicit X button or Esc dismiss
 *   - Inner card scrolls; backdrop does not
 */
export function EditorSheet({
  open,
  onClose,
  title,
  subtitle,
  icon,
  maxWidth = "max-w-2xl",
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  /** Tailwind max-width class. Default `max-w-2xl`. */
  maxWidth?: string;
  children: React.ReactNode;
  /** Optional sticky footer rendered below the scroll region. */
  footer?: React.ReactNode;
}) {
  // Esc closes — capture phase so it wins over other handlers (timeline, etc).
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

  // Lock body scroll while a sheet is open.
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="editor-sheet-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[125] flex items-center justify-center bg-ink/80 px-4 py-6 backdrop-blur-xl"
        >
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.96 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-b from-surface to-ink shadow-cinematic",
              maxWidth
            )}
          >
            {/* Soft violet aurora at the top — premium signature */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-48 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.18),transparent_70%)] blur-2xl"
            />

            <header className="relative flex items-start justify-between gap-3 border-b border-white/[0.06] px-6 py-5">
              <div className="flex min-w-0 items-start gap-3">
                {icon && (
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-violet-400/20 bg-violet-500/10 text-violet-200">
                    {icon}
                  </span>
                )}
                <div className="min-w-0">
                  <h2 className="truncate font-display text-lg font-semibold tracking-tight text-white">
                    {title}
                  </h2>
                  {subtitle && (
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-fog">
                      {subtitle}
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                title="Close (Esc)"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.02] text-fog transition-colors duration-150 hover:border-white/25 hover:text-white"
              >
                <XIcon size={14} />
              </button>
            </header>

            <div className="relative min-h-0 flex-1 overflow-y-auto">
              {children}
            </div>

            {footer && (
              <div className="relative border-t border-white/[0.06] bg-ink/40 px-6 py-4 backdrop-blur-md">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
