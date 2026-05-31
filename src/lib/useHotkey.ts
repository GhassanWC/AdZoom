"use client";

import * as React from "react";

/**
 * Bind a global keyboard shortcut. Single source for hotkeys across
 * the app — the editor, recording, and navbar all converge on this.
 *
 * By default ignores keystrokes typed into inputs / textareas /
 * contenteditable surfaces so typing in a form field doesn't fire a
 * global action. Pass `allowInInput: true` for shortcuts that should
 * fire even while a field is focused (rare — used by the navbar's
 * ⌘K so the user can re-open search from any field).
 */
export interface HotkeyCombo {
  key: string;
  /** Match Cmd on macOS. Use together with `ctrl` to match either. */
  meta?: boolean;
  /** Match Ctrl. Use together with `meta` to match either. */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface HotkeyOpts {
  /** Fire even when focus is inside an input / textarea / contenteditable. */
  allowInInput?: boolean;
  /** Pass `false` to disable the binding without unmounting. */
  enabled?: boolean;
}

export function useHotkey(
  combo: HotkeyCombo,
  handler: () => void,
  opts: HotkeyOpts = {}
): void {
  const { allowInInput = false, enabled = true } = opts;
  // Always read the latest handler — callers don't need useCallback.
  const handlerRef = React.useRef(handler);
  React.useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  React.useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== combo.key.toLowerCase()) return;
      // Treat `meta` and `ctrl` as "either modifier matches" when the
      // caller asks for both — the canonical cross-platform shortcut
      // pattern (⌘K on macOS, Ctrl+K on Windows / Linux).
      if (combo.meta || combo.ctrl) {
        const modifierOk =
          (combo.meta && e.metaKey) || (combo.ctrl && e.ctrlKey);
        if (!modifierOk) return;
      } else if (e.metaKey || e.ctrlKey) {
        // Caller didn't ask for a modifier; don't fire if one is held
        // (avoid swallowing Ctrl-S, Ctrl-C, etc).
        return;
      }
      if (combo.shift !== undefined && combo.shift !== e.shiftKey) return;
      if (combo.alt !== undefined && combo.alt !== e.altKey) return;

      if (!allowInInput && isEditableTarget(e.target)) return;

      e.preventDefault();
      handlerRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    enabled,
    allowInInput,
    combo.key,
    combo.meta,
    combo.ctrl,
    combo.shift,
    combo.alt,
  ]);
}

/**
 * Return true if `target` is a form field or contenteditable region.
 * Used to suppress shortcuts while the user is typing — overridable
 * per-binding via `allowInInput`.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  return false;
}
