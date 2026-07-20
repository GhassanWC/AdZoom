/**
 * Which panel an admin page shows — as a pure decision, so it is testable
 * without a DOM (matching the `clips-panel-state.ts` pattern in this repo).
 *
 * The ordering here is the whole point. The old pages each open-coded this
 * ladder and got it subtly different: five of them tested bare `loading`, so
 * changing a status filter tore down the metric cards, charts AND table and
 * replaced the entire page with a spinner, while the other two guarded with
 * `loading && !data` and kept their content on screen. Encoding the rules once
 * makes that divergence impossible.
 */

export type AdminViewState =
  | "loading"
  | "error"
  | "index-building"
  | "content";

export interface AdminViewInput {
  /** A request is in flight. */
  loading: boolean;
  /** Data from a previous successful response is available. */
  hasData: boolean;
  error: string | null;
  indexBuilding: boolean;
}

/**
 * Skeletons ONLY on a true first load. Once data exists it stays rendered —
 * including through a failed refresh, which surfaces as an inline banner rather
 * than discarding what the operator is looking at.
 */
export function adminViewState(input: AdminViewInput): AdminViewState {
  const { loading, hasData, error, indexBuilding } = input;

  // First load: nothing to show yet.
  if (loading && !hasData) return "loading";

  // A hard error with no previous data is the only full-page error takeover.
  if (error && !hasData) return "error";

  // Index-building outranks content: the response is a successful 200 but its
  // payload is empty by definition, so rendering "0 everywhere" would be a lie.
  if (indexBuilding) return "index-building";

  return "content";
}

/**
 * Whether to show the non-blocking "refresh failed" banner: an error arrived
 * but we still have data on screen, so the page is usable.
 */
export function showRefreshError(input: AdminViewInput): boolean {
  return Boolean(input.error) && input.hasData && !input.indexBuilding;
}

/**
 * Whether to show the "no rows match" empty state.
 *
 * Deliberately distinct from `adminViewState`: an empty RESULT is not an empty
 * PAGE. The metric cards and charts still describe the window (and may be
 * non-zero) even when the current filter matches no rows, so the empty state
 * replaces the table only — never the whole view.
 */
export function showEmptyRows(rowCount: number, state: AdminViewState): boolean {
  return state === "content" && rowCount === 0;
}

/**
 * Whether the honest "totals are a floor" notice belongs on screen: the scan
 * hit its cap AND we are actually showing content.
 */
export function showTruncationNotice(
  truncated: boolean | undefined,
  state: AdminViewState
): boolean {
  return state === "content" && truncated === true;
}
