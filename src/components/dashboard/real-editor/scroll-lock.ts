"use client";

/**
 * Editor body-scroll-lock helpers.
 *
 * Background: modals lock page scroll with `document.body.style.overflow`.
 * The bug this fixes — the docked inspector's modal fallback ran its
 * scroll-lock effect off `inspectorOpen` even on wide (`xl`) screens where the
 * modal itself is CSS-hidden, so clicking "Edit" locked the body with no
 * visible modal to release it → the page froze. Modals now gate their lock on
 * actually being visible AND go through these helpers, which log in dev and
 * expose `restoreEditorScrollLock()` as a force-clear safety net.
 */

function log(line: string) {
  // Dev-only but unconditional (no ?debug needed) so apply/release is always
  // observable while developing — the docked-inspector freeze was invisible
  // precisely because nothing logged the lock.
  if (process.env.NODE_ENV === "production") return;
  // eslint-disable-next-line no-console
  console.log(`[scroll-lock] ${line} · body.overflow="${
    typeof document !== "undefined" ? document.body.style.overflow : "?"
  }"`);
}

/** The body overflow value before the first active lock, restored on unlock. */
let savedBodyOverflow: string | null = null;

/** Lock page scroll (idempotent — remembers the pre-lock value once). */
export function lockEditorScroll(reason = "modal"): void {
  if (typeof document === "undefined") return;
  if (savedBodyOverflow === null) savedBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  log(`locked (${reason})`);
}

/** Release a lock set by `lockEditorScroll`, restoring the prior value. */
export function unlockEditorScroll(reason = "modal"): void {
  if (typeof document === "undefined") return;
  document.body.style.overflow = savedBodyOverflow ?? "";
  savedBodyOverflow = null;
  log(`unlocked (${reason})`);
}

/**
 * Safety net — force-clear ANY editor scroll lock and stale overlay styles,
 * regardless of who set them. Call on editor unmount / route change so a leaked
 * lock can never strand the page in a non-scrolling state.
 */
export function restoreEditorScrollLock(): void {
  if (typeof document === "undefined") return;
  savedBodyOverflow = null;
  document.body.style.overflow = "";
  document.documentElement.style.overflow = "";
  log("force-restored");
}
