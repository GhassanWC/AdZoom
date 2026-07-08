/**
 * Pure constants + math for the preview/timeline vertical split ratio. Shared
 * by `context.tsx` (owns the persisted `splitFraction` state), the unified
 * control bar (renders the Preview/Balanced/Timeline mode buttons), and
 * `EditorSplitWorkspace` (owns the pointer-drag mechanics + CSS grid). No
 * React/DOM dependency — keeps the three in perfect agreement.
 */

export type WorkspaceMode = "preview" | "balanced" | "timeline";

// v2: the default ratio jumped from 40% to 70% preview — bump the storage key
// so returning users pick up the new default instead of an old persisted ratio.
export const SPLIT_FRACTION_KEY = "framevo:editor-split-fraction-v2";

export const MIN_PREVIEW_PX = 280;
export const MIN_TIMELINE_PX = 300;
const FR = 1000; // fr granularity for the grid-template-rows string

/**
 * "Balanced" is the DEFAULT (fresh session + double-click-to-reset land here):
 * 70% preview / 30% timeline. Preview/Timeline spread out from there; the
 * timeline's `minmax(300px, …)` floor guarantees it never disappears even at
 * the 82% extreme.
 */
export const MODE_FRACTION: Record<WorkspaceMode, number> = {
  preview: 0.82,
  balanced: 0.7,
  timeline: 0.45,
};
export const MODE_TOLERANCE = 0.02;
/** Keyboard/programmatic fraction bounds (the px minmax is the hard clamp). */
export const FRACTION_MIN = 0.15;
export const FRACTION_MAX = 0.85;
export const KEY_STEP = 0.03;

export function clampSplitFraction(f: number): number {
  return Math.max(FRACTION_MIN, Math.min(FRACTION_MAX, f));
}

/** 3 grid rows: preview / thin resize grip (auto) / timeline. The unified
 *  control bar lives INSIDE the timeline pane now, so it no longer needs its
 *  own grid row here. */
export function splitGridRows(fraction: number): string {
  const pf = Math.round(fraction * FR);
  const tf = FR - pf;
  return `minmax(${MIN_PREVIEW_PX}px, ${pf}fr) auto minmax(${MIN_TIMELINE_PX}px, ${tf}fr)`;
}

/** Which preset mode (if any) the current fraction matches, for button highlighting. */
export function modeForSplitFraction(fraction: number): WorkspaceMode | null {
  return (
    (Object.keys(MODE_FRACTION) as WorkspaceMode[]).find(
      (m) => Math.abs(MODE_FRACTION[m] - fraction) < MODE_TOLERANCE
    ) ?? null
  );
}
