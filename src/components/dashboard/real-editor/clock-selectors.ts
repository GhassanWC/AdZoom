/**
 * Pure clock-derived selectors.
 *
 * These exist so the editor provider can subscribe to the playhead clock at a
 * COARSE granularity. Both return a primitive, so a tick that doesn't change the
 * answer (the overwhelming majority of ticks) costs zero React work — see
 * playback-clock.tsx. Kept pure and separate so the boundary conditions are
 * unit-tested rather than eyeballed through the UI.
 */
import type { DetectedMoment } from "@/lib/firebase/schema";
import { canSplit } from "@/lib/timeline/split";

/**
 * Which moment the playhead is "in", as an id.
 *
 * An explicit selection wins while the playhead is still inside it — otherwise
 * clicking a pill and then nudging the playhead one frame would silently hand
 * the inspector to a different edit. Falls back to the first moment whose range
 * contains the time.
 */
export function activeMomentIdAt(
  moments: readonly DetectedMoment[],
  selectedMomentId: string | null,
  time: number
): string | null {
  if (selectedMomentId) {
    const sel = moments.find((m) => m.id === selectedMomentId);
    if (sel && time >= sel.startTime && time <= sel.endTime) return sel.id;
  }
  const within = moments.find((m) => time >= m.startTime && time <= m.endTime);
  return within ? within.id : null;
}

/** Whether any currently-targeted edit can be split at this time. */
export function canSplitAt(
  moments: readonly DetectedMoment[],
  targetIds: readonly string[],
  time: number
): boolean {
  if (targetIds.length === 0) return false;
  const ids = new Set(targetIds);
  return moments.some((m) => ids.has(m.id) && canSplit(m, time));
}
