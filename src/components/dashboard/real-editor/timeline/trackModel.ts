/**
 * Shared lane types for the timeline.
 *
 * This module used to carry a `TimelineTrackDescriptor` — id, kind, label, Icon,
 * tone, count, note — because the orchestrator mapped one descriptor list TWICE:
 * once for the left label gutter, once for the lanes. The gutter is gone, so the
 * whole descriptor went with it: half its fields (Icon, tone, label, count, note)
 * existed purely to draw the classifier column, and the orchestrator now builds
 * its own minimal row list. What remains is the one thing every lane renderer
 * genuinely needs — the per-frame metrics below.
 */

/** Shared per-frame metrics handed to every lane renderer. */
export interface TimelineLaneContext {
  /** Total timeline duration in seconds. */
  total: number;
  /** Measured pixels-per-second at the current zoom (0 before first measure). */
  pxPerSec: number;
  /** Current horizontal zoom multiplier (1 = fit-to-viewport). */
  zoom: number;
}
