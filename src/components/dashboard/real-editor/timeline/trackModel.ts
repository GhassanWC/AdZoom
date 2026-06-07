import type { LucideIcon } from "lucide-react";
import type * as React from "react";

/**
 * Track-model abstraction for the timeline.
 *
 * The orchestrator (`RealTimeline`) builds an ordered `TimelineTrackDescriptor[]`
 * and maps it twice — once for the left header gutter, once for the lanes.
 * Adding a future feature (captions, audio, transitions, speed ramps, crop
 * regions) becomes a matter of appending one descriptor with its own
 * `renderLane`, never surgery on the render tree. This is the "future-ready
 * architecture" requirement made concrete.
 */
export type TimelineTrackKind =
  | "ai"
  | "user"
  | "interactions"
  // ── Prepared-but-not-implemented (placeholder lanes / future descriptors) ──
  | "speed"
  | "crop"
  | "captions"
  | "audio"
  | "transitions";

/** Shared per-frame metrics handed to every lane renderer. */
export interface TimelineLaneContext {
  /** Total timeline duration in seconds. */
  total: number;
  /** Measured pixels-per-second at the current zoom (0 before first measure). */
  pxPerSec: number;
  /** Current horizontal zoom multiplier (1 = fit-to-viewport). */
  zoom: number;
}

export type TimelineTrackTone = "violet" | "cyan" | "fog" | "amber" | "teal";

export interface TimelineTrackDescriptor {
  id: string;
  kind: TimelineTrackKind;
  /** Left-gutter label. */
  label: string;
  Icon: LucideIcon;
  /** Row height in px (from `TRACK_HEIGHTS`). */
  height: number;
  tone: TimelineTrackTone;
  /** False → read-only / placeholder lane (dimmed, no drag handles). */
  interactive: boolean;
  /** Renders the dimmed "coming soon" affordance on the gutter label + lane. */
  comingSoon?: boolean;
  /** Optional count shown under the gutter label. */
  count?: number;
  /** Lane body. Returns absolutely-positioned children (pills / markers). */
  renderLane: (ctx: TimelineLaneContext) => React.ReactNode;
}
