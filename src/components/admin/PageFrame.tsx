"use client";

/**
 * The shared page scaffold: header + toolbar + state handling.
 *
 * Every admin page needs the same branch — first-load skeleton, error with
 * retry, index-building notice, then content — plus a refresh indicator and a
 * truncation warning. Previously each page wrote its own version of that
 * ladder, which is how five of them ended up tearing down the whole view on
 * every filter change while the other two kept their data on screen.
 *
 * Content renders as soon as data exists and STAYS rendered during refetches;
 * only the very first load shows skeletons.
 */

import * as React from "react";
import { AdminPageHeader } from "./AdminCard";
import {
  ErrorPanel,
  IndexBuildingPanel,
  PageSkeleton,
  RefreshingBar,
  TruncationNotice,
} from "./StatePanels";
import { adminViewState, showRefreshError, showTruncationNotice } from "./page-state";

export function PageFrame({
  title,
  subtitle,
  toolbar,
  state,
  skeleton,
  truncated,
  scanned,
  children,
}: {
  title: string;
  subtitle?: string;
  toolbar?: React.ReactNode;
  state: {
    isLoading: boolean;
    isRefreshing: boolean;
    error: string | null;
    indexBuilding: boolean;
    refresh: () => void;
    hasData: boolean;
  };
  skeleton?: React.ReactNode;
  /** True when the underlying scan hit its cap — surfaced as an honest notice. */
  truncated?: boolean;
  scanned?: number;
  children: React.ReactNode;
}) {
  const view = adminViewState({
    loading: state.isLoading,
    hasData: state.hasData,
    error: state.error,
    indexBuilding: state.indexBuilding,
  });

  return (
    <div className="space-y-4">
      <AdminPageHeader title={title} subtitle={subtitle} action={toolbar} />
      <RefreshingBar active={state.isRefreshing} />

      {view === "loading" ? (
        (skeleton ?? <PageSkeleton />)
      ) : view === "error" ? (
        <ErrorPanel message={state.error ?? "Unknown error"} onRetry={state.refresh} />
      ) : view === "index-building" ? (
        <IndexBuildingPanel onRetry={state.refresh} />
      ) : (
        <>
          {/* A refresh that fails while data is on screen shows an inline
              banner rather than discarding the data the operator is reading. */}
          {showRefreshError({
            loading: state.isLoading,
            hasData: state.hasData,
            error: state.error,
            indexBuilding: state.indexBuilding,
          }) && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-400/25 bg-rose-500/[0.07] px-3 py-2 text-xs text-rose-200"
            >
              <span>Refresh failed: {state.error}</span>
              <button
                type="button"
                onClick={state.refresh}
                className="ml-auto underline underline-offset-2 hover:text-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
              >
                Retry
              </button>
            </div>
          )}
          {showTruncationNotice(truncated, view) && scanned != null && (
            <TruncationNotice scanned={scanned} />
          )}
          {children}
        </>
      )}
    </div>
  );
}

/** Standard two-column chart grid. */
export function ChartGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{children}</div>;
}
