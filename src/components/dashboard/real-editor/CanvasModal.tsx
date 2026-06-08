"use client";

import { Frame } from "lucide-react";
import { EditorSheet } from "./EditorSheet";
import { RealCanvasPanel } from "./RealCanvasPanel";

/**
 * "Canvas" sheet — the global output-canvas layout (aspect ratio + fit mode +
 * background). Decides how the whole source video fits the export frame, BEFORE
 * the per-moment camera. Distinct from per-moment Crop/Reframe (a timeline
 * effect). Mirrors `EffectsModal` / `ExportModal`.
 */
export function CanvasModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <EditorSheet
      open={open}
      onClose={onClose}
      title="Canvas"
      subtitle="How your whole video fits the export frame. Preview matches the export."
      icon={<Frame size={17} />}
      maxWidth="max-w-2xl"
    >
      <RealCanvasPanel />
    </EditorSheet>
  );
}
