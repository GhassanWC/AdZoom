"use client";

import { Download } from "lucide-react";
import { EditorSheet } from "./EditorSheet";
import { RealExportPanel } from "./RealExportPanel";

/**
 * "Export" sheet — resolution / frame rate / format / pre-flight summary and
 * the primary export action, all in one focused modal.
 */
export function ExportModal({
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
      title="Export video"
      subtitle="Choose your export settings. Framevo will prepare your MP4 automatically."
      icon={<Download size={17} />}
      size="default"
    >
      <RealExportPanel onClose={onClose} />
    </EditorSheet>
  );
}
