"use client";

import * as React from "react";
import type { DetectedMoment } from "@/lib/firebase/schema";
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
  selectedMomentId,
  multiSelectIds,
  draftId,
  withDraft,
  onBeginDrag,
  onDuplicate,
  onDelete,
  onEdit,
}: {
  moments: DetectedMoment[];
  total: number;
  selectedMomentId: string | null;
  multiSelectIds: string[];
  draftId: string | null;
  withDraft: (m: DetectedMoment) => DetectedMoment;
  onBeginDrag: (e: React.PointerEvent, m: DetectedMoment, mode: DragMode) => void;
  onDuplicate: (id: string) => void;
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
            onBeginDrag={onBeginDrag}
            onDuplicate={() => onDuplicate(m0.id)}
            onDelete={() => onDelete(m0.id)}
            onEdit={() => onEdit(m0.id)}
          />
        );
      })}
    </div>
  );
}
