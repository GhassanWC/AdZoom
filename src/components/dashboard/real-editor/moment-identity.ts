/**
 * Keep OBJECT IDENTITY stable across project echoes. Pure, no React — the
 * boundary conditions are unit-tested rather than eyeballed through the UI.
 *
 * THE PROBLEM
 * -----------
 * `MomentPill` is `React.memo`'d and takes its moment as a prop, so a pill is
 * supposed to be skipped unless THAT edit changed. It never was. Every write to
 * the project comes back through the store subscription as freshly parsed JSON
 * (`materializeProject` passes `analysis` straight through, and both the desktop
 * SQLite reader and a Firestore snapshot hand it a brand-new object graph), so
 * every `DetectedMoment` arrived with a new identity even when its contents were
 * byte-for-byte what they were before. The shallow prop compare therefore failed
 * for all of them, and nudging ONE slider re-rendered ALL the pills: measured at
 * 400 pill renders across a single 30-move slider drag on a 40-edit timeline.
 *
 * The fix is to reconcile the incoming array against the previous one and hand
 * back the PREVIOUS object wherever the contents are unchanged. Then `React.memo`
 * does what it always claimed to: one edit re-renders one pill.
 *
 * This is a rendering optimisation only — the values are identical either way,
 * which is exactly why substituting the older object is safe.
 */

import type { DetectedMoment, ProjectDoc } from "@/lib/firebase/schema";
import { jsonEqual } from "@/lib/json-equal";

// Re-exported so existing callers (and their tests) keep one import site. The
// implementation moved to lib/ because the sync merge needs the SAME notion of
// "changed" this reconciliation uses — see lib/json-equal.ts.
export { jsonEqual };

/**
 * Reconcile `next` against `prev`, reusing previous element objects wherever the
 * contents are unchanged.
 *
 * Returns `prev` ITSELF when the two lists are equivalent element-for-element, so
 * an echo that changed nothing (the common case — most writes touch a field no
 * pill reads) doesn't even produce a new array. Otherwise returns a new array in
 * which the untouched entries are the ORIGINAL objects.
 *
 * Matching is by `id`, not by position, so an edit that reorders the list still
 * lets every unmoved edit keep its identity.
 */
export function reuseIdentity<T extends { id: string }>(
  prev: readonly T[] | undefined,
  next: readonly T[]
): readonly T[] {
  if (prev === next) return next;
  if (!prev || prev.length === 0) return next;

  const byId = new Map<string, T>();
  for (const item of prev) byId.set(item.id, item);

  // "Nothing changed" requires same length AND same order AND same contents —
  // anything less has to produce a new array, or a reorder would be invisible.
  let identical = prev.length === next.length;
  const out = next.map((item, index) => {
    const previous = byId.get(item.id);
    if (previous && jsonEqual(previous, item)) {
      if (prev[index] !== previous) identical = false;
      return previous;
    }
    identical = false;
    return item;
  });
  return identical ? prev : out;
}

/**
 * Repair a project snapshot's object identity against the one it replaces.
 *
 * Applied at the SUBSCRIPTION — the single point where a document echo enters
 * React — so every consumer downstream benefits and nothing has to read a ref
 * during render to do it.
 *
 * Three fields matter, and they are the three that fan out to a memoized child
 * per edit: `detectedMoments` (the pill's `moment`), `attentionCurve` and
 * `sourceCrop` (passed to every pill). Rebuilding the project object at all is
 * skipped unless one of them actually needed repairing, so an echo that changed
 * nothing is indistinguishable from no echo.
 */
export function reconcileProjectIdentity(
  previous: ProjectDoc | null,
  incoming: ProjectDoc
): ProjectDoc {
  if (!previous) return incoming;

  const nextMoments = incoming.analysis?.detectedMoments;
  const prevMoments = previous.analysis?.detectedMoments;
  const moments =
    nextMoments && prevMoments ? reuseIdentity(prevMoments, nextMoments) : nextMoments;

  const nextCurve = incoming.analysis?.attentionCurve;
  const prevCurve = previous.analysis?.attentionCurve;
  const attentionCurve =
    nextCurve && prevCurve && jsonEqual(prevCurve, nextCurve) ? prevCurve : nextCurve;

  const sourceCrop =
    incoming.sourceCrop && previous.sourceCrop && jsonEqual(previous.sourceCrop, incoming.sourceCrop)
      ? previous.sourceCrop
      : incoming.sourceCrop;

  if (
    moments === nextMoments &&
    attentionCurve === nextCurve &&
    sourceCrop === incoming.sourceCrop
  ) {
    return incoming;
  }

  return {
    ...incoming,
    sourceCrop,
    analysis: incoming.analysis
      ? {
          ...incoming.analysis,
          detectedMoments: moments as DetectedMoment[],
          attentionCurve,
        }
      : incoming.analysis,
  };
}
