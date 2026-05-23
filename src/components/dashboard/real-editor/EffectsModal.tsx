"use client";

import { SlidersHorizontal } from "lucide-react";
import { EditorSheet } from "./EditorSheet";
import { RealEffectsPanel } from "./RealEffectsPanel";

/**
 * "Effects" sheet — global defaults (zoom, cursor, click highlights, toggles)
 * presented as a focused modal instead of an always-on page panel.
 */
export function EffectsModal({
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
      title="Effects"
      subtitle="Global defaults for this project — applied to every detected moment."
      icon={<SlidersHorizontal size={17} />}
      maxWidth="max-w-2xl"
    >
      <RealEffectsPanel />
    </EditorSheet>
  );
}
