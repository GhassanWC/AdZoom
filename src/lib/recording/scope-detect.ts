/**
 * Interaction-scope detection — the single source of truth for "is this take
 * our own Framevo tab (coordinates valid) or an external surface?".
 *
 * Used in two places:
 *   • capture time (recording engine) — sets the initial scope, and
 *   • analyze time (server routes) — INDEPENDENTLY re-validates the scope from
 *     the persisted capture dimensions, so a logic improvement (or a wrong
 *     capture-time call) is corrected on the next analyze without re-recording.
 *
 * Pure + isomorphic. Reporting/loading only — never touches balancing or AI.
 */

import { assessCoordinateTrust, type InteractionScope } from "./interaction-trust";

/** Capture-time geometry, persisted on the project doc for re-validation. */
export interface CaptureDimensions {
  /** Captured video track width, in PHYSICAL device pixels. */
  trackWidth: number;
  /** Captured video track height, in PHYSICAL device pixels. */
  trackHeight: number;
  /** Framevo viewport width at capture time, in CSS pixels. */
  viewportWidth: number;
  /** Framevo viewport height at capture time, in CSS pixels. */
  viewportHeight: number;
  /** window.devicePixelRatio at capture time. */
  devicePixelRatio: number;
  /** Raw displaySurface from the track ("browser" | "window" | "monitor" | "unknown"). */
  displaySurface: string;
  /** trackWidth / trackHeight, precomputed. */
  captureAspect: number;
}

export interface ScopeDecision {
  scope: InteractionScope;
  reason: string;
}

/**
 * Decide scope from capture geometry. The crux: track dims are PHYSICAL pixels
 * while the viewport is CSS pixels, so a self-tab on a HiDPI display reports
 * ~`viewport × devicePixelRatio`. We accept a DPI-scaled match, a direct
 * CSS-pixel match, or an aspect-ratio match (DPI-invariant) before falling
 * back to "external".
 */
export function decideInteractionScope(d: CaptureDimensions): ScopeDecision {
  // Only a monitor/window pick is DEFINITELY external — those can never be the
  // Framevo tab. "browser" OR an unknown/missing displaySurface (Firefox and
  // some Chromium contexts don't expose it) fall through to a dimensions check:
  // if the captured surface matches our viewport it's almost certainly our tab.
  if (d.displaySurface === "monitor" || d.displaySurface === "window") {
    return {
      scope: "external",
      reason: `displaySurface=${d.displaySurface} — a ${d.displaySurface} capture, not the Framevo tab`,
    };
  }
  const dpr = d.devicePixelRatio || 1;
  const tol = (expected: number) => Math.max(64, expected * 0.1);
  const within = (a: number, b: number) => Math.abs(a - b) <= tol(b);

  const dimsMatchDpr =
    within(d.trackWidth, d.viewportWidth * dpr) &&
    within(d.trackHeight, d.viewportHeight * dpr);
  const dimsMatchCss =
    within(d.trackWidth, d.viewportWidth) &&
    within(d.trackHeight, d.viewportHeight);
  const viewAspect = d.viewportWidth / Math.max(1, d.viewportHeight);
  const aspectMatch = Math.abs(d.captureAspect - viewAspect) <= 0.02;

  if (dimsMatchDpr)
    return {
      scope: "tab",
      reason: "capture matches viewport × devicePixelRatio (HiDPI self-tab)",
    };
  if (dimsMatchCss)
    return { scope: "tab", reason: "capture matches CSS viewport (self-tab)" };
  if (aspectMatch)
    return {
      scope: "tab",
      reason: "capture aspect ratio matches viewport (self-tab)",
    };
  return {
    scope: "external",
    reason: `capture dimensions didn't match viewport (track ${d.trackWidth}×${d.trackHeight}, viewport ${d.viewportWidth}×${d.viewportHeight} @${dpr}x, surface=${d.displaySurface || "unknown"})`,
  };
}

export interface ResolvedScope {
  /** Scope as written at capture time (project doc's `interactionScope`). */
  scopeAssigned?: InteractionScope;
  /** Scope after independent re-validation from persisted dims. */
  scopeValidated?: InteractionScope;
  /** Whether validated coordinates may drive camera zooms. */
  coordinatesTrusted: boolean;
  /** Why coordinates are/aren't trusted. */
  trustReason: string;
  /** How the validated scope was derived (or why it couldn't be). */
  validationReason: string;
}

/**
 * Re-validate scope from persisted capture dims and assess coordinate trust.
 * When `dims` is absent (legacy projects, plain uploads), falls back to the
 * assigned scope unverified.
 */
export function resolveScopeAndTrust(
  scopeAssigned: InteractionScope | undefined,
  dims: CaptureDimensions | undefined
): ResolvedScope {
  let scopeValidated = scopeAssigned;
  let validationReason: string;
  if (dims) {
    const decision = decideInteractionScope(dims);
    scopeValidated = decision.scope;
    validationReason = `re-validated: ${decision.reason}`;
  } else {
    validationReason =
      "no capture dimensions persisted — using assigned scope unverified";
  }
  const trust = assessCoordinateTrust(scopeValidated);
  return {
    scopeAssigned,
    scopeValidated,
    coordinatesTrusted: trust.trusted,
    trustReason: trust.reason,
    validationReason,
  };
}
