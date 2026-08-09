/**
 * Pure, DOM-free behaviour helpers for the fullscreen editor shell — extracted
 * (like editor-dialog-behavior.ts) so they're unit-testable under `node --test`
 * without pulling in React/framer-motion.
 */

/* ── Editor route detection ──────────────────────────────────────────────── */

/**
 * The project editor detail route gets the dedicated fullscreen shell: it
 * drops the dashboard topbar, the content padding and the theme dock in favour
 * of its own chrome. It KEEPS the nav rail — that is shared with every other
 * dashboard route, so there is exactly one navigation in the app.
 * Matches /dashboard/projects/<id> (one non-empty segment, optional trailing
 * slash) but NOT /dashboard/projects (the list page).
 */
export function isEditorRoute(pathname: string): boolean {
  return /^\/dashboard\/projects\/[^/]+\/?$/.test(pathname);
}

/* ── Moment review navigation (Previous / Next edit) ─────────────────────── */

interface NavMoment {
  id: string;
  startTime: number;
}

/**
 * Review order = timeline order: by start time, id as a stable tiebreak.
 * Returns a NEW array (never mutates the input).
 */
export function momentReviewOrder<T extends NavMoment>(moments: readonly T[]): T[] {
  return [...moments].sort(
    (a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id)
  );
}

/**
 * 1-based position of a moment in review order, for the "12 of 42" indicator.
 * Returns null when the moment isn't in the list.
 */
export function momentReviewPosition(
  moments: readonly NavMoment[],
  id: string | null
): { index: number; total: number } | null {
  const order = momentReviewOrder(moments);
  const i = order.findIndex((m) => m.id === id);
  return i === -1 ? null : { index: i + 1, total: order.length };
}

/**
 * The id of the previous/next moment in review order. No wrap-around — at
 * either end the same direction returns null so the nav button can disable.
 * When `currentId` is unknown (nothing selected), "next" starts at the first
 * moment and "prev" at the last, so the buttons always enter the review flow.
 */
export function adjacentMomentId(
  moments: readonly NavMoment[],
  currentId: string | null,
  dir: "prev" | "next"
): string | null {
  const order = momentReviewOrder(moments);
  if (order.length === 0) return null;
  const i = order.findIndex((m) => m.id === currentId);
  if (i === -1) return dir === "next" ? order[0].id : order[order.length - 1].id;
  const j = dir === "next" ? i + 1 : i - 1;
  return j < 0 || j >= order.length ? null : order[j].id;
}

/* ── Before / After compare (preview-only bypass) ────────────────────────── */

interface BypassMoment {
  id: string;
}

/**
 * Preview-side "Before" view: REMOVE only the compared moment from the list
 * feeding the live preview, leaving every other edit active. Removal (not
 * `enabled: false`) is deliberate — the camera resolver and cut/speed engines
 * consume the raw list without an enabled filter, so removal is the only
 * change that reliably switches the effect off for every effect type. Pure +
 * non-mutating; persisted data and export never see it. Returns the input
 * array unchanged when there's no bypass, so memoized consumers don't
 * re-render.
 */
export function applyCompareBypass<T extends BypassMoment>(
  moments: T[],
  bypassId: string | null
): T[] {
  if (!bypassId || !moments.some((m) => m.id === bypassId)) return moments;
  return moments.filter((m) => m.id !== bypassId);
}
