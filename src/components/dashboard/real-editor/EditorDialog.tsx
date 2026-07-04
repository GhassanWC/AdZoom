"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X as XIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { lockEditorScroll, unlockEditorScroll } from "./scroll-lock";
import {
  shouldCloseOnBackdrop,
  shouldCloseOnOutsidePress,
} from "./editor-dialog-behavior";

/**
 * Floating (backdrop-less) dialogs mark still-interactive regions — the video
 * workspace, the timeline, the editor toolbar — with this attribute so
 * pressing them never counts as an outside-click dismissal.
 */
export const EDITOR_DIALOG_HOLD_ATTR = "data-editor-dialog-hold";

/**
 * The ONE editor dialog system. Every editing dialog (Export, Effects, Canvas,
 * Analyze options, the moment inspector) is built from these pieces, so they
 * share one wide, responsive, accessible shell + one closing behaviour — new
 * dialogs inherit it automatically.
 *
 *   EditorDialogShell   — portal + backdrop + focus trap/restore + scroll lock +
 *                         Esc/backdrop close. Wide on desktop, single-column on
 *                         mobile, never exceeds the viewport (internal scroll).
 *   EditorDialogHeader  — title + subtitle + a large, always-visible close button.
 *   EditorDialogBody    — the scroll region (consistent padding).
 *   EditorDialogSection — a titled group (no nested cards/borders).
 *   EditorDialogGrid    — two columns on desktop, one on mobile.
 *   EditorDialogFooter  — sticky action bar.
 *
 * Layout is a flex column: header + footer are shrink-0 (so they stay pinned),
 * only the body scrolls. RTL is inherited from the document — nothing here forces
 * a direction.
 */

export type EditorDialogSize = "compact" | "default" | "editing" | "wide";

// Wide ≈ 960px on desktop; collapses to full width (minus the overlay padding)
// on mobile. Bigger than the old max-w-xl/2xl so controls no longer feel cramped.
// "editing" ≈ 880px is the landscape two-column moment editor.
// Plain scale / single-token arbitrary values so Tailwind reliably generates them.
const SIZE_CLASS: Record<EditorDialogSize, string> = {
  compact: "sm:max-w-lg",
  default: "sm:max-w-3xl",
  editing: "sm:max-w-[880px]",
  wide: "sm:max-w-[960px]",
};

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function isVisible(el: HTMLElement): boolean {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

interface DialogContextValue {
  onClose: () => void;
  titleId: string;
}
const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialogContext(): DialogContextValue {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error("Editor dialog subcomponents must render inside <EditorDialogShell>.");
  return ctx;
}

export function EditorDialogShell({
  open,
  onClose,
  size = "wide",
  backdrop = true,
  lockScroll = backdrop,
  closeOnOutsidePress = false,
  ariaLabel,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  size?: EditorDialogSize;
  /**
   * Dim + click-to-close backdrop. `false` = a floating panel over still-
   * interactive content (e.g. the moment inspector, whose crop box lives on the
   * video BEHIND the dialog and must stay draggable). Floating panels also skip
   * the scroll lock so the page/timeline keep working.
   */
  backdrop?: boolean;
  /** Lock page scroll while open (defaults to `backdrop`). */
  lockScroll?: boolean;
  /**
   * Floating-variant outside-click close: presses that start AND end outside
   * both the card and any `data-editor-dialog-hold` region dismiss the dialog.
   * Hold regions (video workspace, timeline, toolbar) stay fully interactive
   * without closing it.
   */
  closeOnOutsidePress?: boolean;
  ariaLabel?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const titleId = React.useId();
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  // Where a pointer press STARTED — so a drag out of a slider that releases on
  // the backdrop doesn't count as a backdrop click (see shouldCloseOnBackdrop).
  const pressOnBackdropRef = React.useRef(false);

  // Esc closes — capture phase so it wins over window handlers (timeline, etc.).
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // An overlay drawer stacked ABOVE this dialog owns Escape — capture
        // listeners fire in registration order, not stacking order, so yield
        // explicitly to keep "Esc closes the topmost layer" true.
        if (document.querySelector("[data-editor-drawer]")) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Lock background scrolling (idempotent helper — safe across nested dialogs).
  React.useEffect(() => {
    if (!open || !lockScroll) return;
    lockEditorScroll("editor-dialog");
    return () => unlockEditorScroll("editor-dialog");
  }, [open, lockScroll]);

  // Floating-variant outside-press close. Document-level (capture) because the
  // floating wrapper is pointer-events-none — there is no backdrop element to
  // click. Press-start AND release must both land outside the card and outside
  // every hold region, so slider drags, crop-box drags on the video, and
  // timeline interactions never dismiss the dialog.
  React.useEffect(() => {
    if (!open || backdrop || !closeOnOutsidePress) return;
    let pressInsideCard = false;
    let pressInsideHold = false;
    const hit = (t: EventTarget | null) => {
      const el = t instanceof Element ? t : null;
      return {
        card: !!(el && cardRef.current?.contains(el)),
        hold: !!el?.closest(`[${EDITOR_DIALOG_HOLD_ATTR}]`),
      };
    };
    const onDown = (e: PointerEvent) => {
      // A drawer stacked above owns its own dismissal — interacting with it
      // (including its backdrop) must not also dismiss this dialog.
      if (document.querySelector("[data-editor-drawer]")) {
        pressInsideCard = true; // neutralize this press entirely
        pressInsideHold = true;
        return;
      }
      const h = hit(e.target);
      pressInsideCard = h.card;
      pressInsideHold = h.hold;
    };
    const onUp = (e: PointerEvent) => {
      if (document.querySelector("[data-editor-drawer]")) return;
      const h = hit(e.target);
      if (
        shouldCloseOnOutsidePress({
          pressInsideCard,
          releaseInsideCard: h.card,
          pressInsideHold,
          releaseInsideHold: h.hold,
        })
      ) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
    };
  }, [open, backdrop, closeOnOutsidePress, onClose]);

  // Focus management: remember the trigger, move focus into the dialog on open,
  // restore it to the trigger on close.
  React.useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card) return;
      const first = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(isVisible);
      (first ?? card).focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      const el = restoreFocusRef.current;
      if (el && document.contains(el)) el.focus();
    };
  }, [open]);

  // Keep Tab focus inside the dialog.
  const onTrapKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const card = cardRef.current;
    if (!card) return;
    const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
    if (items.length === 0) {
      e.preventDefault();
      card.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !card.contains(active)) {
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

  const card = (
    <motion.div
      ref={cardRef}
      role="dialog"
      aria-modal={backdrop || undefined}
      // With a header, the title element carries `titleId`; header-less floating
      // panels pass `ariaLabel` instead (no dangling idref).
      {...(ariaLabel ? { "aria-label": ariaLabel } : { "aria-labelledby": titleId })}
      tabIndex={-1}
      onKeyDown={onTrapKeyDown}
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 16, scale: 0.97 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        // SOLID opaque surface — custom-color gradient STOPS (from-surface/to-ink)
        // don't resolve under Tailwind v4, which made the card see-through. A plain
        // background-color token is bulletproof (and required for the backdrop-less
        // floating variant, where anything translucent would show the video behind).
        // `bg-surface` + `border-border-soft` FLIP with the theme (dark surface +
        // white-tint border in dark; light surface + slate-tint border in light),
        // so the dialog reads correctly in both modes.
        "pointer-events-auto relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-2xl border border-border-soft bg-surface shadow-cinematic outline-none",
        SIZE_CLASS[size],
        className
      )}
    >
      {/* Subtle top sheen for premium depth over the solid surface. A UTILITY
          gradient with a standard color (arbitrary rgba/radial gradients don't
          generate under this Tailwind v4 setup); never intercepts clicks. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-32 bg-gradient-to-b from-white/5 to-transparent"
      />
      <DialogContext.Provider value={{ onClose, titleId }}>{children}</DialogContext.Provider>
    </motion.div>
  );

  return createPortal(
    <AnimatePresence>
      {open &&
        (backdrop ? (
          <motion.div
            key="editor-dialog-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="fixed inset-0 z-[125] flex items-center justify-center bg-ink/80 px-3 py-4 backdrop-blur-xl sm:px-6 sm:py-8"
            onPointerDown={(e) => {
              pressOnBackdropRef.current = e.target === e.currentTarget;
            }}
            onClick={(e) => {
              if (
                shouldCloseOnBackdrop({
                  pressStartedOnBackdrop: pressOnBackdropRef.current,
                  releaseTargetIsBackdrop: e.target === e.currentTarget,
                })
              ) {
                onClose();
              }
              pressOnBackdropRef.current = false;
            }}
          >
            {card}
          </motion.div>
        ) : (
          // Floating variant: no backdrop / no scroll lock. The wrapper is
          // click-through (pointer-events-none) so content behind stays usable;
          // only the card itself captures pointer events.
          <div className="pointer-events-none fixed inset-0 z-[118] flex items-center justify-center px-3 py-4">
            {card}
          </div>
        ))}
    </AnimatePresence>,
    document.body
  );
}

export function EditorDialogHeader({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  /** Extra controls rendered left of the close button. */
  actions?: React.ReactNode;
}) {
  const { onClose, titleId } = useDialogContext();
  return (
    <header className="relative z-10 flex shrink-0 items-start justify-between gap-3 border-b border-border-soft px-5 py-4 sm:px-7 sm:py-5">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-violet-400/25 bg-violet-500/15 text-violet-400">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2
            id={titleId}
            className="truncate font-display text-lg font-semibold tracking-tight text-text-primary sm:text-xl"
          >
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">{subtitle}</p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          title="Close (Esc)"
          className="inline-flex size-10 items-center justify-center rounded-full border border-border-soft bg-button-bg-soft text-fog transition-colors duration-150 hover:border-border-strong hover:bg-button-bg-soft-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
        >
          <XIcon size={16} />
        </button>
      </div>
    </header>
  );
}

export function EditorDialogBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative z-[1] min-h-0 flex-1 space-y-7 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7 sm:py-6",
        className
      )}
    >
      {children}
    </div>
  );
}

export function EditorDialogSection({
  title,
  description,
  actions,
  className,
  children,
}: {
  title?: string;
  description?: string;
  /** Right-aligned controls in the section heading row. */
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("space-y-3.5", className)}>
      {(title || description || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            {title && (
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                {title}
              </h3>
            )}
            {description && (
              <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-1.5">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function EditorDialogGrid({
  columns = 2,
  className,
  children,
}: {
  columns?: 2 | 3;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-x-6 gap-y-5",
        columns === 3 ? "lg:grid-cols-3" : "lg:grid-cols-2",
        className
      )}
    >
      {children}
    </div>
  );
}

export function EditorDialogFooter({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative z-10 shrink-0 border-t border-border-soft bg-black/15 px-5 py-4 sm:px-7",
        className
      )}
    >
      {children}
    </div>
  );
}
