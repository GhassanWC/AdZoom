"use client";

import * as React from "react";
import type { DetectedMoment } from "@/lib/firebase/schema";
import { canSplit } from "@/lib/timeline/split";
import type { DragMode } from "./utils";
import { MomentPill } from "./MomentPill";

/**
 * A lane of draggable moment pills. Extracted from `RealTimeline` so the AI
 * and User tracks (and any future moment-backed track) share one render path.
 * Pills self-position via `left%` / `width%`, so the lane is just an absolute
 * container.
 */
export function MomentLane({
  moments,
  total,
  currentTime,
  selectedMomentId,
  multiSelectIds,
  draftId,
  withDraft,
  layerHidden = false,
  onBeginDrag,
  onDuplicate,
  onSplit,
  onToggleEnabled,
  onDelete,
  onEdit,
}: {
  moments: DetectedMoment[];
  total: number;
  /** Playhead position — decides whether each pill's Split action is available. */
  currentTime: number;
  selectedMomentId: string | null;
  multiSelectIds: string[];
  draftId: string | null;
  withDraft: (m: DetectedMoment) => DetectedMoment;
  /** This lane's LAYER is switched off — every pill in it renders nowhere. */
  layerHidden?: boolean;
  onBeginDrag: (e: React.PointerEvent, m: DetectedMoment, mode: DragMode) => void;
  onDuplicate: (id: string) => void;
  onSplit: (id: string) => void;
  /** Show/hide this edit — non-destructive, it stays on the lane either way. */
  onToggleEnabled: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  return (
    <div className="absolute inset-0 z-10">
      {moments.map((m0) => {
        const m = withDraft(m0);
        return (
          <MomentPill
            key={m0.id}
            moment={m}
            total={total}
            selected={selectedMomentId === m0.id}
            multiSelected={multiSelectIds.includes(m0.id)}
            dragging={draftId === m0.id}
            // Computed from the SAME pure predicate the context uses to decide
            // whether the split will actually happen — so the button's enabled
            // state can never disagree with what pressing it does.
            canSplit={canSplit(m, currentTime)}
            layerHidden={layerHidden}
            onBeginDrag={onBeginDrag}
            onDuplicate={() => onDuplicate(m0.id)}
            onSplit={() => onSplit(m0.id)}
            onToggleEnabled={() => onToggleEnabled(m0.id)}
            onDelete={() => onDelete(m0.id)}
            onEdit={() => onEdit(m0.id)}
          />
        );
      })}
    </div>
  );
}
