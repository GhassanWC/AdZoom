/**
 * Pure, DOM-free behaviour helpers for the editor dialog system — extracted so
 * they're unit-testable (the EditorDialog component itself pulls in framer-motion
 * / react-dom and can't load under `node --test`).
 */

/**
 * A backdrop click closes the dialog ONLY when the press both STARTED and ENDED
 * on the backdrop itself. This is what prevents an accidental close when a
 * slider drag / dropdown / popover / drag-handle interaction began INSIDE the
 * dialog and the pointer happens to release over the backdrop (a very common way
 * to lose work). Clicks that begin inside the dialog never close it.
 */
export function shouldCloseOnBackdrop(opts: {
  pressStartedOnBackdrop: boolean;
  releaseTargetIsBackdrop: boolean;
}): boolean {
  return opts.pressStartedOnBackdrop && opts.releaseTargetIsBackdrop;
}

/**
 * Outside-press close for FLOATING (backdrop-less) dialogs — e.g. the moment
 * editor, which must keep the video preview + timeline behind it interactive.
 * A press closes the dialog ONLY when it both started AND ended:
 *   - outside the dialog card (slider drags that stray out don't close), and
 *   - outside any "hold" region (the preview workspace / timeline / toolbar,
 *     marked with a data attribute) — interacting with the video crop box or
 *     switching moments on the timeline must never dismiss the editor.
 */
export function shouldCloseOnOutsidePress(opts: {
  pressInsideCard: boolean;
  releaseInsideCard: boolean;
  pressInsideHold: boolean;
  releaseInsideHold: boolean;
}): boolean {
  return (
    !opts.pressInsideCard &&
    !opts.releaseInsideCard &&
    !opts.pressInsideHold &&
    !opts.releaseInsideHold
  );
}
