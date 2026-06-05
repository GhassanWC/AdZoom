/**
 * Coordinate-trust assessment for captured interactions.
 *
 * `interactionScope` records HOW a take was captured; this helper turns that
 * into the orthogonal question the editing pipeline actually cares about:
 * "can the click coordinates be mapped onto the recorded frame?".
 *
 * Separating LOAD from TRUST is deliberate — external recordings still load
 * their event stream (so diagnostics can count it), but their coordinates are
 * in the Framevo viewport's space, not the recorded surface, so they must NOT
 * drive camera zooms. Pure + isomorphic (client upload + server analyzer both
 * import it). Reporting/loading only — never touches balancing or AI.
 */

export type InteractionScope = "tab" | "external";

export interface CoordinateTrust {
  /** True when click coordinates map to the recorded frame and may drive zooms. */
  trusted: boolean;
  /** One-line, human-readable justification (surfaced in diagnostics). */
  reason: string;
}

export function assessCoordinateTrust(
  scope: InteractionScope | undefined
): CoordinateTrust {
  if (scope === "tab") {
    return {
      trusted: true,
      reason: "self-tab capture — click coordinates map to the recorded frame",
    };
  }
  if (scope === "external") {
    return {
      trusted: false,
      reason:
        "external surface — coordinates are in the Framevo viewport, not the recorded frame",
    };
  }
  return {
    trusted: false,
    reason: "unknown capture scope — coordinates not validated",
  };
}
