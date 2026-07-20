"use client";

/**
 * Admin → Events.
 *
 * "Top events" is now tallied from the same scanned window as the table, so the
 * chart and the table always describe the same set. It used to come from a
 * separate 1000-doc recency-biased sample that ignored the page's own filters
 * and carried no disclosure — "top events" actually meant "top events among the
 * most recent 1000".
 *
 * The environment filter defaults to production. `trackEvent` stamps
 * `environment`, but no admin route ever filtered on it, so events from
 * development machines were being counted as real traffic.
 */

import * as React from "react";
import { Activity, Users, Radio, Filter } from "lucide-react";
import { MetricCard, MetricGrid } from "@/components/admin/MetricCard";
import { SectionCard } from "@/components/admin/AdminCard";
import { DataTable, CellStack, type Column } from "@/components/admin/DataTable";
import { BarList, AreaChart, type DayPoint, type Slice } from "@/components/admin/Charts";
import { Pagination } from "@/components/admin/Pagination";
import { PageFrame, ChartGrid } from "@/components/admin/PageFrame";
import { EmptyPanel } from "@/components/admin/StatePanels";
import {
  Toolbar,
  SearchInput,
  FilterSelect,
  DateRangeFilter,
  RefreshButton,
} from "@/components/admin/Toolbar";
import { useAdminListPage, type AdminListResponse } from "@/components/admin/useAdminListPage";
import { fmtDate, fmtNum, truncateMiddle } from "@/components/admin/format";

interface EventRow {
  id: string;
  eventName: string;
  userId: string;
  userEmail: string | null;
  projectId: string | null;
  plan: string | null;
  environment: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

interface EventSummary {
  total: number;
  topEvents: Slice[];
  byPlan: Slice[];
  byEnvironment: Slice[];
  uniqueUsers: number;
  perDay: DayPoint[];
}

type EventsResponse = AdminListResponse<EventRow, EventSummary> & { eventNames: string[] };

const ENVIRONMENT_OPTIONS = [
  { value: "production", label: "Production" },
  { value: "development", label: "Development" },
  { value: "all", label: "All environments" },
];

export default function AdminEventsPage() {
  const [environment, setEnvironment] = React.useState("production");
  const [eventName, setEventName] = React.useState("");

  const q = useAdminListPage<EventsResponse>("/api/admin/events", {
    defaultPageSize: 50,
    extraParams: { environment, eventName: eventName || undefined },
  });
  const d = q.data;
  const s = d?.summary;

  // The event-name filter is populated from the data itself, so it can never
  // drift from what is actually being written.
  const eventOptions = React.useMemo(
    () => (d?.eventNames ?? []).map((n) => ({ value: n, label: n })),
    [d?.eventNames]
  );

  const columns: Column<EventRow>[] = [
    {
      key: "event",
      header: "Event",
      render: (r) => (
        <CellStack
          primary={<span className="font-mono text-xs text-text-primary">{r.eventName}</span>}
          secondary={r.projectId ? `project ${truncateMiddle(r.projectId, 6, 4)}` : undefined}
        />
      ),
    },
    {
      key: "user",
      header: "User",
      render: (r) => (
        <CellStack
          primary={r.userEmail ?? truncateMiddle(r.userId, 8, 4) ?? "—"}
          secondary={r.plan ?? undefined}
          title={r.userId}
        />
      ),
    },
    {
      key: "env",
      header: "Env",
      hideOnMobile: true,
      render: (r) => <span className="text-text-muted">{r.environment}</span>,
    },
    {
      key: "meta",
      header: "Metadata",
      hideOnMobile: true,
      render: (r) => {
        const keys = Object.keys(r.metadata);
        if (!keys.length) return <span className="text-text-muted">—</span>;
        const preview = keys
          .slice(0, 3)
          .map((k) => `${k}: ${String(r.metadata[k]).slice(0, 24)}`)
          .join(" · ");
        return (
          <span className="text-xs text-text-muted" title={JSON.stringify(r.metadata)}>
            {preview}
            {keys.length > 3 && ` +${keys.length - 3}`}
          </span>
        );
      },
    },
    { key: "ts", header: "When", align: "right", render: (r) => fmtDate(r.timestamp) },
  ];

  return (
    <PageFrame
      title="Events"
      subtitle="Product analytics stream — what users are actually doing."
      state={{ ...q, hasData: Boolean(d) }}
      truncated={d?.truncated}
      scanned={d?.scanned}
      toolbar={
        <Toolbar>
          <SearchInput
            value={q.search}
            onChange={q.setSearch}
            label="Search events by name, user or project"
            placeholder="Event, email, uid…"
          />
          <FilterSelect
            value={eventName}
            onChange={setEventName}
            options={eventOptions}
            allLabel="All events"
            label="Filter by event name"
          />
          <FilterSelect
            value={environment === "production" ? "" : environment}
            onChange={(v) => setEnvironment(v || "production")}
            options={ENVIRONMENT_OPTIONS.filter((o) => o.value !== "production")}
            allLabel="Production"
            label="Filter by environment"
          />
          <DateRangeFilter
            range={q.range}
            from={q.from}
            to={q.to}
            onRangeChange={q.setRange}
            onFromChange={q.setFrom}
            onToChange={q.setTo}
          />
          <RefreshButton onClick={q.refresh} busy={q.isRefreshing} updatedAt={q.updatedAt} />
        </Toolbar>
      }
    >
      {d && s && (
        <>
          <MetricGrid>
            <MetricCard
              label="Events in range"
              value={fmtNum(s.total)}
              sub={environment === "all" ? "all environments" : environment}
              icon={<Activity size={15} />}
              tone="accent"
            />
            <MetricCard
              label="Active users"
              value={fmtNum(s.uniqueUsers)}
              sub="distinct accounts emitting events"
              icon={<Users size={15} />}
            />
            <MetricCard
              label="Distinct event types"
              value={fmtNum(s.topEvents.length)}
              sub="named events seen in range"
              icon={<Radio size={15} />}
            />
            <MetricCard
              label="Showing"
              value={fmtNum(d.filteredTotal)}
              sub={eventName ? `filtered to ${eventName}` : "no event filter"}
              icon={<Filter size={15} />}
            />
          </MetricGrid>

          <ChartGrid>
            <SectionCard
              title="Events per day"
              total={fmtNum(s.total)}
              subtitle="Bars sum to the total above — same query, same window."
            >
              <AreaChart data={s.perDay} label="Events per day" />
            </SectionCard>
            <SectionCard
              title="Top events"
              total={fmtNum(s.total)}
              subtitle="Tallied from this window, not a separate sample."
            >
              <BarList data={s.topEvents} total={s.total} />
            </SectionCard>
          </ChartGrid>

          <ChartGrid>
            <SectionCard title="By plan" total={fmtNum(s.total)} subtitle="Plan recorded on each event.">
              <BarList data={s.byPlan} total={s.total} />
            </SectionCard>
            <SectionCard
              title="By environment"
              subtitle="Production is the default view; dev traffic is excluded from metrics above."
            >
              <BarList data={s.byEnvironment} />
            </SectionCard>
          </ChartGrid>

          {d.rows.length === 0 ? (
            <EmptyPanel
              label="No events match these filters"
              hint="Marketing and page-view events go to GA4 only — they never reach Firestore."
            />
          ) : (
            <>
              <DataTable
                caption="Analytics events, newest first"
                columns={columns}
                rows={d.rows}
                rowKey={(r) => r.id}
                minWidth={900}
              />
              <Pagination
                page={d.page}
                pageCount={d.pageCount}
                pageSize={d.pageSize}
                total={d.filteredTotal}
                onPageChange={q.setPage}
                onPageSizeChange={q.setPageSize}
              />
            </>
          )}
        </>
      )}
    </PageFrame>
  );
}
