"use client";

import * as React from "react";
import { useEditorReal } from "./context";
import {
  adjacentMomentId,
  momentReviewPosition,
} from "./editor-shell-behavior";

/**
 * Previous/Next edit review navigation — shared by the editor toolbar and the
 * moment editor dialog so both walk the SAME order (timeline order: start
 * time, id tiebreak) and stay in sync.
 *
 * Navigating selects the moment, moves the playhead into it (same nudge the
 * timeline uses on pill click, so the preview shows the edit), and opens the
 * moment editor. The dialog stays open across navigation because it keys off
 * `selectedMomentId` — content swaps in place, no close/reopen.
 */
export function useMomentReview() {
  const { project, selectedMomentId, setSelectedMomentId, seek, openInspector } =
    useEditorReal();

  const moments = React.useMemo(
    () => project.analysis?.detectedMoments ?? [],
    [project.analysis?.detectedMoments]
  );

  const position = React.useMemo(
    () => momentReviewPosition(moments, selectedMomentId),
    [moments, selectedMomentId]
  );

  const goTo = React.useCallback(
    (dir: "prev" | "next") => {
      const id = adjacentMomentId(moments, selectedMomentId, dir);
      if (!id) return;
      const m = moments.find((x) => x.id === id);
      setSelectedMomentId(id);
      if (m) seek(Math.min(m.endTime - 0.01, m.startTime + 0.05));
      openInspector();
    },
    [moments, selectedMomentId, setSelectedMomentId, seek, openInspector]
  );

  const hasPrev = adjacentMomentId(moments, selectedMomentId, "prev") !== null;
  const hasNext = adjacentMomentId(moments, selectedMomentId, "next") !== null;

  return {
    /** 1-based "12 of 42" position, or null when nothing is selected. */
    position,
    total: moments.length,
    hasPrev,
    hasNext,
    goPrev: () => goTo("prev"),
    goNext: () => goTo("next"),
  };
}
