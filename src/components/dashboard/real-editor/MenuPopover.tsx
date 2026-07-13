"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { placeMenu, type MenuPlacement } from "@/lib/ui/menu-placement";
import { EDITOR_DIALOG_HOLD_ATTR } from "./EditorDialog";

/**
 * A dropdown panel that CANNOT be clipped.
 *
 * The editor shell is a fixed-height, non-scrolling workspace: the page, the
 * split workspace and the timeline pane are all `overflow-hidden`. An
 * absolutely-positioned menu inside the timeline's control bar is therefore
 * clipped by its ancestors' boxes, not by the viewport — so a `max-h-[70vh]`
 * does nothing, and the options past the pane's bottom edge are simply
 * unreachable. That's the bug this exists to make impossible.
 *
 * So the panel is PORTALLED to `document.body` and positioned `fixed` against
 * the trigger's viewport rect: no ancestor can clip it. It then earns its keep:
 *
 * - it FLIPS above the trigger when the content doesn't fit below and there is
 *   more room above (measured, not guessed — a short menu near the bottom stays
 *   below rather than jumping for no reason);
 * - it CLAMPS its height to the space actually available and scrolls inside, so
 *   a menu taller than the window is scrollable rather than truncated;
 * - it CLAMPS horizontally so an edge-aligned menu never runs off-screen.
 *
 * It re-measures on resize and on scroll (capture: any scrolling ancestor moves
 * the trigger under a fixed panel), so the panel never drifts away from the
 * button it belongs to.
 */

export interface MenuPopoverState {
  open: boolean;
  toggle: () => void;
  close: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  panelRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Open state for one menu: Escape closes, and a press outside BOTH the trigger
 * and the (portalled) panel closes. The panel is not a DOM descendant of the
 * trigger any more, so "outside" has to be asked of both — testing only the
 * wrapper would close the menu the instant you clicked an item in it.
 */
export function useMenuPopover(): MenuPopoverState {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The trigger toggles itself on click — don't also close it here, or the
      // two would cancel out and the menu would never open.
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return {
    open,
    toggle: React.useCallback(() => setOpen((v) => !v), []),
    close: React.useCallback(() => setOpen(false), []),
    triggerRef,
    panelRef,
  };
}

export function MenuPopover({
  state,
  align = "left",
  width,
  className,
  ariaLabel,
  children,
}: {
  state: MenuPopoverState;
  /** Which trigger edge the panel lines up with, before edge-clamping. */
  align?: "left" | "right";
  /** Panel width in px — a number, because the placement math has to know it. */
  width: number;
  className?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  const { open, triggerRef, panelRef } = state;
  const [placement, setPlacement] = React.useState<MenuPlacement | null>(null);
  // Identical values ⇒ no setState, so the measure pass below settles after one
  // extra render instead of re-triggering itself forever.
  const lastRef = React.useRef<MenuPlacement | null>(null);

  const place = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const t = trigger.getBoundingClientRect();

    const next = placeMenu({
      trigger: { left: t.left, right: t.right, top: t.top, bottom: t.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      width,
      align,
      // `scrollHeight` is the content's natural height even while `max-height`
      // clamps the box — exactly the question being asked: "would this menu need
      // to scroll if it opened downwards?". It's 0 on the first pass (the panel
      // isn't in the DOM yet); the second pass has the real number.
      naturalHeight: panelRef.current?.scrollHeight ?? 0,
    });

    const prev = lastRef.current;
    if (
      prev &&
      prev.left === next.left &&
      prev.width === next.width &&
      prev.maxHeight === next.maxHeight &&
      prev.top === next.top &&
      prev.bottom === next.bottom
    ) {
      return;
    }
    lastRef.current = next;
    setPlacement(next);
  }, [align, width, triggerRef, panelRef]);

  // Runs before paint, and again after the panel is in the DOM (it depends on
  // `placement`, which the first pass sets) — so the flip is decided from the
  // measured content height without ever showing a frame in the wrong place.
  React.useLayoutEffect(() => {
    if (!open) {
      lastRef.current = null;
      setPlacement(null);
      return;
    }
    place();
  }, [open, placement, place]);

  React.useEffect(() => {
    if (!open) return;
    const onChange = () => place();
    window.addEventListener("resize", onChange);
    // Capture phase: the trigger can be moved by ANY scrolling ancestor, not
    // just the window.
    window.addEventListener("scroll", onChange, true);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
    };
  }, [open, place]);

  if (!open || !placement || typeof document === "undefined") return null;

  const { left, width: w, maxHeight, top, bottom } = placement;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={ariaLabel}
      // The panel lives on <body> now, outside the control bar's hold region —
      // it has to carry the attribute itself, or clicking a menu item would
      // read as an outside-click and dismiss the floating moment inspector.
      {...{ [EDITOR_DIALOG_HOLD_ATTR]: "" }}
      style={{ position: "fixed", left, width: w, maxHeight, top, bottom }}
      className={cn(
        "z-[60] overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-ink/95 p-1.5 shadow-cinematic backdrop-blur-xl",
        className
      )}
    >
      {children}
    </div>,
    document.body
  );
}
