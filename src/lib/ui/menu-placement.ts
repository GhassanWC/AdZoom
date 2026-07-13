/**
 * Where a dropdown panel goes — the pure half of MenuPopover.
 *
 * The editor shell is a fixed-height, non-scrolling workspace (page, split
 * workspace and timeline pane are all `overflow-hidden`), so a menu positioned
 * `absolute` inside the timeline's control bar is clipped by the PANE, not the
 * viewport: its lower options become unreachable on a short window, and no
 * `max-height` can rescue it. The panel is therefore portalled to <body> and
 * positioned `fixed` — and this module decides where.
 *
 * Pure and DOM-free (rects in, rect out) so the rules that actually matter —
 * never off-screen, never taller than the space it has, flip only when flipping
 * genuinely helps — are testable under `node --test` instead of by eyeballing a
 * browser at three window heights.
 */

/** Space between the trigger and the panel. */
export const MENU_GAP = 6;
/** Minimum breathing room between the panel and any viewport edge. */
export const MENU_MARGIN = 8;
/**
 * The panel never gets squeezed below this: past ~140px a menu is more usefully
 * a scroll region than a two-row sliver. It may then overhang the margin, which
 * is the lesser evil — an overhanging scrollable menu is still operable, and the
 * clamp below keeps it on-screen.
 */
export const MENU_MIN_HEIGHT = 140;

export interface MenuTriggerRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface MenuViewport {
  width: number;
  height: number;
}

export interface MenuPlacementInput {
  trigger: MenuTriggerRect;
  viewport: MenuViewport;
  /** Panel width in px — fixed by the caller, so it's an input, not a result. */
  width: number;
  /**
   * The panel's natural (unclamped) content height. 0 when it hasn't been
   * measured yet — the first pass then places it below, and the second pass,
   * once it's in the DOM, can flip it.
   */
  naturalHeight: number;
  /** Which trigger edge the panel lines up with, before edge-clamping. */
  align: "left" | "right";
}

export interface MenuPlacement {
  left: number;
  width: number;
  maxHeight: number;
  /** Set when the panel hangs below the trigger. */
  top?: number;
  /** Set when the panel is flipped above the trigger. */
  bottom?: number;
  /** True when the content is taller than the space — the panel scrolls. */
  scrolls: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/**
 * Place the panel.
 *
 * - Prefers BELOW the trigger, which is where a dropdown belongs.
 * - Flips ABOVE only when the content doesn't fit below AND there is more room
 *   above. Flipping a menu that already fits would be motion for nothing, and
 *   flipping into an even smaller space would be worse than not flipping.
 * - Clamps the height to the room actually available, so the overflow scrolls
 *   inside the panel instead of being cut off by the window.
 * - Clamps horizontally so a right-aligned menu near an edge stays on-screen.
 */
export function placeMenu(input: MenuPlacementInput): MenuPlacement {
  const { trigger, viewport, width, naturalHeight, align } = input;

  const below = Math.max(0, viewport.height - trigger.bottom - MENU_GAP - MENU_MARGIN);
  const above = Math.max(0, trigger.top - MENU_GAP - MENU_MARGIN);

  const flip = naturalHeight > below && above > below;
  const room = flip ? above : below;
  const maxHeight = Math.max(MENU_MIN_HEIGHT, room);

  const raw = align === "left" ? trigger.left : trigger.right - width;
  const left = clamp(raw, MENU_MARGIN, viewport.width - width - MENU_MARGIN);

  return {
    left,
    width,
    maxHeight,
    ...(flip
      ? { bottom: viewport.height - trigger.top + MENU_GAP }
      : { top: trigger.bottom + MENU_GAP }),
    scrolls: naturalHeight > maxHeight,
  };
}
