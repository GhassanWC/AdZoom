/**
 * What a click highlight looks like — resolved once, for every renderer.
 *
 * A click's ring/pulse/burst used to be read straight off the project's global
 * `effectsSettings` at four different draw sites (the editor preview's DOM
 * layer, `compose-frame` for browser export + the Cloud Run worker, and
 * Remotion's EffectsLayer). Making the look PER-EDIT means each of those sites
 * has to answer the same question — "does this moment override the project?" —
 * and four copies of that question is how preview and export drift apart.
 *
 * So it's asked once, here.
 *
 * Precedence, matching `textStyle`'s resolve-at-draw rule: the moment's own bag
 * wins, the project's settings are the fallback, and ABSENT means the project
 * value — which is what a Look applies. Nothing is backfilled onto old docs.
 *
 * Pure + dependency-free (no `server-only`, no canvas): it runs in the browser,
 * in the worker, in Remotion and under `node --test`.
 */
import type { DetectedMoment, EffectsSettings } from "../firebase/schema";

export type ClickHighlightStyle = "ring" | "pulse" | "burst";

/** The project-level fallbacks — the only part of EffectsSettings this needs. */
export interface ClickHighlightDefaults {
  clickHighlights: EffectsSettings["clickHighlights"];
  clickHighlightStyle: EffectsSettings["clickHighlightStyle"];
  clickHighlightSize: EffectsSettings["clickHighlightSize"];
}

export interface ResolvedClickHighlight {
  style: ClickHighlightStyle;
  sizePct: number;
}

/**
 * The highlight to draw for `moment`, or NULL when nothing should be drawn.
 *
 * Null covers all three ways a click can be silent, and every renderer gets the
 * same three for free:
 *   - the moment isn't a click-highlight at all;
 *   - the user switched THIS click off (`enabled === false`, the same
 *     non-destructive flag overlays use — it stays on the timeline);
 *   - the project has click highlights turned off wholesale.
 */
export function resolveClickHighlight(
  moment: DetectedMoment | null | undefined,
  defaults: ClickHighlightDefaults
): ResolvedClickHighlight | null {
  if (!moment || moment.effectType !== "click-highlight") return null;
  // `enabled` is absent on every older doc and means "on" — only an explicit
  // false hides an edit.
  if (moment.enabled === false) return null;
  if (!defaults.clickHighlights) return null;

  return {
    style: moment.clickHighlight?.style ?? defaults.clickHighlightStyle,
    sizePct: moment.clickHighlight?.size ?? defaults.clickHighlightSize,
  };
}
