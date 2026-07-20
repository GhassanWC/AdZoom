"use client";

/**
 * Filter + pagination state for a list page, bundled once.
 *
 * Every admin list page needs the same seven pieces of state (page, page size,
 * debounced search, a status filter, a range preset, custom from/to) wired to
 * the same query params. Previously each page re-declared its own subset, which
 * is why some pages had search and others didn't, only Overview had a date
 * range, and none reset to page 1 when a filter changed.
 *
 * `extraParams` carries page-specific filters (pipeline, plan, environment,
 * kind) without another bespoke hook.
 */

import * as React from "react";
import { useAdminQuery, useDebounced, type AdminQueryState } from "./useAdminQuery";
import { DEFAULT_PAGE_SIZE } from "@/lib/admin/params";
import type { RangeKey } from "@/lib/admin/range";

export interface AdminListPage<T> extends AdminQueryState<T> {
  page: number;
  setPage: (p: number) => void;
  pageSize: number;
  setPageSize: (n: number) => void;
  search: string;
  setSearch: (v: string) => void;
  status: string;
  setStatus: (v: string) => void;
  range: RangeKey;
  setRange: (r: RangeKey) => void;
  from: string;
  setFrom: (v: string) => void;
  to: string;
  setTo: (v: string) => void;
}

export function useAdminListPage<T>(
  path: string,
  options: {
    defaultRange?: RangeKey;
    defaultPageSize?: number;
    /** Page-specific filters. Changing any of these resets to page 1. */
    extraParams?: Record<string, string | number | undefined>;
  } = {}
): AdminListPage<T> {
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSizeRaw] = React.useState(options.defaultPageSize ?? DEFAULT_PAGE_SIZE);
  const [searchInput, setSearch] = React.useState("");
  const [status, setStatusRaw] = React.useState("");
  const [range, setRangeRaw] = React.useState<RangeKey>(options.defaultRange ?? "30d");
  const [from, setFromRaw] = React.useState("");
  const [to, setToRaw] = React.useState("");

  // Debounced so each keystroke doesn't trigger a Firestore scan.
  const search = useDebounced(searchInput, 300);

  const extraParams = options.extraParams ?? {};
  const extraKey = JSON.stringify(extraParams);

  // Any filter change must return to page 1 — otherwise a narrowed result set
  // strands you on a page that no longer exists and the table reads empty for
  // no apparent reason.
  //
  // Done by adjusting state DURING RENDER (React's documented pattern for
  // "state derived from a prop change") rather than in an effect. An effect
  // would render one frame with the stale page, fire a request for it, then
  // re-render and fire a second request — a visible flash and a wasted
  // Firestore scan on every keystroke.
  const filterKey = JSON.stringify({ search, status, range, from, to, pageSize, extraKey });
  const [lastFilterKey, setLastFilterKey] = React.useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  const query = useAdminQuery<T>(path, {
    page,
    pageSize,
    search: search || undefined,
    status: status || undefined,
    range,
    from: from || undefined,
    to: to || undefined,
    ...extraParams,
  });

  return {
    ...query,
    page,
    setPage,
    pageSize,
    setPageSize: setPageSizeRaw,
    search: searchInput,
    setSearch,
    status,
    setStatus: setStatusRaw,
    range,
    setRange: setRangeRaw,
    from,
    setFrom: setFromRaw,
    to,
    setTo: setToRaw,
  };
}

/** Shape every admin list route returns. */
export interface AdminListResponse<TRow, TSummary> {
  rows: TRow[];
  page: number;
  pageCount: number;
  pageSize: number;
  filteredTotal: number;
  windowTotal: number;
  summary: TSummary;
  truncated: boolean;
  scanned: number;
  skipped: number;
  range: { fromMs: number; toMs: number; key: RangeKey };
  generatedAt: number;
  indexBuilding?: boolean;
}
