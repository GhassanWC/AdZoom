/**
 * Motion helpers for the JS-driven bits of the editor.
 *
 * Everything that CAN be expressed in CSS is (see the `fv-*` classes in
 * globals.css) — CSS animations run off the main thread and keep working while
 * the browser is busy decoding video or laying out a big timeline. This module
 * exists only for the cases where JS has to make the call, and its job is to
 * make sure those cases honour `prefers-reduced-motion` too.
 */

/**
 * Does the user want reduced motion? Read at call time, not cached: the OS
 * setting can change while the editor is open.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * `smooth` normally, `auto` (instant) when the user has asked for reduced
 * motion — a smooth-scrolling viewport is exactly the kind of large-area
 * movement that triggers motion sickness.
 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
