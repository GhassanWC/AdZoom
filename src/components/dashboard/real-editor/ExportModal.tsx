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
      title="Export"
      subtitle="Render in your browser. Audio is baked in."
      icon={<Download size={17} />}
      maxWidth="max-w-2xl"
    >
      <RealExportPanel onClose={onClose} />
    </EditorSheet>
  );
}
