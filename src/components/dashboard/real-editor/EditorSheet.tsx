"use client";

import * as React from "react";
import {
  EditorDialogShell,
  EditorDialogHeader,
  EditorDialogFooter,
  type EditorDialogSize,
} from "./EditorDialog";

/**
 * Back-compat adapter: `EditorSheet` now composes the shared editor dialog system
 * ({@link EditorDialogShell} + header + footer), so every existing consumer
 * (Export / Effects / Canvas / Analyze options) gains the wide, responsive,
 * focus-trapped, backdrop-closable shell with NO change to its own body. The body
 * still owns its padding, so it renders in a bare scroll region here. New dialogs
 * should use the EditorDialog* primitives directly (Body / Section / Grid).
 */
export function EditorSheet({
  open,
  onClose,
  title,
  subtitle,
  icon,
  size = "default",
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  /** Desktop width. `wide` ≈ 900–1000px for control-dense dialogs. */
  size?: EditorDialogSize;
  children: React.ReactNode;
  /** Optional sticky footer rendered below the scroll region. */
  footer?: React.ReactNode;
}) {
  return (
    <EditorDialogShell open={open} onClose={onClose} size={size}>
      <EditorDialogHeader icon={icon} title={title} subtitle={subtitle} />
      {/* Bare scroll region — the consumer's body owns its own padding. */}
      <div className="relative z-[1] min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {children}
      </div>
      {footer && <EditorDialogFooter>{footer}</EditorDialogFooter>}
    </EditorDialogShell>
  );
}
