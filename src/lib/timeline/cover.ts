/**
 * `object-fit: cover` semantics — uniformly scale a source rectangle to
 * FILL a target rectangle, allowing the overflowing axis to be cropped at
 * draw time. Shared between the canvas exporter (where it sets the
 * `drawImage` dimensions) and the preview diagnostic helper (where it
 * lets us compute the same cover-fit dims the export will use, so the
 * preview/export camera snapshots are apples-to-apples).
 *
 * Used to live inside `export.ts` as a private helper; lifted out so the
 * preview side can call it too without a circular import.
 */
export function coverFitDims(
  sourceW: number,
  sourceH: number,
  targetW: number,
  targetH: number
): { drawW: number; drawH: number } {
  const safeSrcW = sourceW > 0 ? sourceW : 1920;
  const safeSrcH = sourceH > 0 ? sourceH : 1080;
  const safeTgtW = targetW > 0 ? targetW : safeSrcW;
  const safeTgtH = targetH > 0 ? targetH : safeSrcH;
  const cAspect = safeTgtW / safeTgtH;
  const sAspect = safeSrcW / safeSrcH;
  if (sAspect > cAspect) {
    // Source is wider than target — fit by height, overflow horizontally.
    return { drawW: safeTgtH * sAspect, drawH: safeTgtH };
  }
  // Source is narrower (or equal) — fit by width, overflow vertically.
  return { drawW: safeTgtW, drawH: safeTgtW / sAspect };
}
