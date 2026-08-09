"use client";

import * as React from "react";
import type { DetectedMoment } from "@/lib/firebase/schema";
import { useRenderCount } from "@/lib/perf/render-probe";
import type { DragMode } from "./utils";
import type { DragStore } from "./drag-store";
import { MomentPill } from "./MomentPill";

/**
 * A lane of draggable moment pills. Extracted from `RealTimeline` so the AI
 * and User tracks (and any future moment-backed track) share one render path.
 * Pills self-position via `left%` / `width%`, so the lane is just an absolute
 * container.
 *
 * PERF — this lane takes NO playhead time. It used to receive `currentTime` and
 * compute `canSplit(m, currentTime)` for every pill, which forced the entire
 * timeline to re-render several times a second during playback (and on every
 * pointermove while scrubbing) just to keep one button's disabled state honest.
 * Each pill now subscribes to that single boolean itself. The lane is memoized
 * so an edit in one lane doesn't re-render the others.
 */
function MomentLaneImpl({
  moments,
  total,
  selectedMomentId,
  multiSelectIds,
  dragStore,
  layerHidden = false,
  videoUrl,
  sourceCrop,
  attentionCurve,
  onBeginDrag,
  onDuplicate,
  onSplit,
  onToggleEnabled,
  onDelete,
  onEdit,
}: {
  moments: DetectedMoment[];
  total: number;
  selectedMomentId: string | null;
  multiSelectIds: string[];
  /**
   * Live drag geometry. Passed straight through to the pills, which subscribe
   * individually — this lane never reads it, so a drag does not re-render it.
   * Its identity is stable for the life of the timeline.
   */
  dragStore: DragStore;
  /** This lane's LAYER is switched off — every pill in it renders nowhere. */
  layerHidden?: boolean;
  /** Project fields the pills need, read from context ONCE by the timeline. */
  videoUrl?: string;
  sourceCrop?: React.ComponentProps<typeof MomentPill>["sourceCrop"];
  attentionCurve?: number[];
  onBeginDrag: (e: React.PointerEvent, m: DetectedMoment, mode: DragMode) => void;
  onDuplicate: (id: string) => void;
  onSplit: (id: string) => void;
  /** Show/hide this edit — non-destructive, it stays on the lane either way. */
  onToggleEnabled: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  useRenderCount("lane");
  return (
    <div className="absolute inset-0 z-10">
      {moments.map((m0) => (
        <MomentPill
          key={m0.id}
          moment={m0}
          total={total}
          selected={selectedMomentId === m0.id}
          multiSelected={multiSelectIds.includes(m0.id)}
          dragStore={dragStore}
          layerHidden={layerHidden}
          videoUrl={videoUrl}
          sourceCrop={sourceCrop}
          attentionCurve={attentionCurve}
          onBeginDrag={onBeginDrag}
          onDuplicate={onDuplicate}
          onSplit={onSplit}
          onToggleEnabled={onToggleEnabled}
          onDelete={onDelete}
          onEdit={onEdit}
        />
      ))}
    </div>
  );
}

export const MomentLane = React.memo(MomentLaneImpl);
