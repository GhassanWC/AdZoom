"use client";

/**
 * Admin → Errors.
 *
 * Grouped by frequency, which is the actual job of an error dashboard — the old
 * page was a flat card feed with no counts, no grouping and no pagination, so
 * "which failure is happening most" was unanswerable.
 *
 * Sources are analysis failures, browser-export failures and cloud-export
 * failures. Cloud (`exportJobs`) is new here: the paid render path previously
 * had no error visibility at all. The old "client" tab is gone — it queried an
 * event name that nothing in the codebase ever emits, so it was permanently
 * empty.
 *
 * There is no resolved/unresolved filter because no collection stores a
 * resolution flag; every failure in the window is listed.
 */

import * as React from "react";
import { AlertTriangle, Users, Layers, Flame } from "lucide-react";
import { MetricCard, MetricGrid } from "@/components/admin/MetricCard";
import { AdminCard, SectionCard, MicroLabel } from "@/components/admin/AdminCard";
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
import { fmtDate, fmtNum, fmtRelative, truncateMiddle } from "@/components/admin/format";

interface ErrorRow {
  id: string;
  kind: string;
  uid: string;
  projectId: string;
  projectTitle: string;
  message: string;
  errorCode: string | null;
  signature: string;
  at: number;
  context: Record<string, string | number | null>;
}

interface ErrorSummary {
  byKind: Record<string, number>;
  topSignatures: {
    signature: string;
    count: number;
    kind: string;
    sampleMessage: string;
    lastSeenAt: number;
  }[];
  byErrorCode: Slice[];
  affectedUsers: number;
  total: number;
  perDay: DayPoint[];
}

const KIND_OPTIONS = [
  { value: "analysis", label: "Analysis" },
  { value: "export", label: "Browser export" },
  { value: "cloud-export", label: "Cloud export" },
];

const KIND_LABEL: Record<string, string> = {
  analysis: "Analysis",
  export: "Browser export",
  "cloud-export": "Cloud export",
};

export default function AdminErrorsPage() {
  const [kind, setKind] = React.useState("");
  const q = useAdminListPage<AdminListResponse<ErrorRow, ErrorSummary>>("/api/admin/errors", {
    extraParams: { kind: kind || undefined },
  });
  const d = q.data;
  const s = d?.summary;

  const columns: Column<ErrorRow>[] = [
    {
      key: "error",
      header: "Error",
      render: (r) => (
        <CellStack
          primary={<span className="text-rose-200">{r.errorCode ?? r.message}</span>}
          secondary={r.errorCode ? r.message : r.projectTitle}
          title={r.message}
        />
      ),
    },
    {
      key: "kind",
      header: "Source",
      render: (r) => (
        <span className="whitespace-nowrap text-text-secondary">{KIND_LABEL[r.kind] ?? r.kind}</span>
      ),
    },
    {
      key: "project",
      header: "Project",
      hideOnMobile: true,
      render: (r) => (
        <CellStack primary={r.projectTitle} secondary={truncateMiddle(r.uid, 8, 4)} />
      ),
    },
    {
      key: "context",
      header: "Context",
      hideOnMobile: true,
      render: (r) => {
        const parts = Object.entries(r.context)
          .filter(([, v]) => v !== null && v !== "")
          .map(([k, v]) => `${k}: ${v}`);
        return parts.length ? (
          <span className="text-xs text-text-muted">{parts.join(" · ")}</span>
        ) : (
          "—"
        );
      },
    },
    { key: "at", header: "When", align: "right", render: (r) => fmtDate(r.at) },
  ];

  return (
    <PageFrame
      title="Errors"
      subtitle="Failures across analysis and both export pipelines, grouped by cause."
      state={{ ...q, hasData: Boolean(d) }}
      truncated={d?.truncated}
      scanned={d?.scanned}
      toolbar={
        <Toolbar>
          <SearchInput
            value={q.search}
            onChange={q.setSearch}
            label="Search errors by message, project or user"
            placeholder="Message, code, uid…"
          />
          <FilterSelect
            value={kind}
            onChange={setKind}
            options={KIND_OPTIONS}
            allLabel="All sources"
            label="Filter by error source"
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
              label="Total failures"
              value={fmtNum(s.total)}
              sub="in the selected range"
              icon={<AlertTriangle size={15} />}
              tone={s.total > 0 ? "bad" : "good"}
            />
            <MetricCard
              label="Affected users"
              value={fmtNum(s.affectedUsers)}
              sub="distinct accounts hit"
              icon={<Users size={15} />}
            />
            <MetricCard
              label="Distinct causes"
              value={fmtNum(s.topSignatures.length)}
              sub="after grouping similar messages"
              icon={<Layers size={15} />}
            />
            <MetricCard
              label="Most common"
              value={s.topSignatures[0] ? fmtNum(s.topSignatures[0].count) : "0"}
              sub={s.topSignatures[0]?.signature ?? "No failures in range"}
              icon={<Flame size={15} />}
              tone={s.topSignatures[0] ? "warn" : "default"}
            />
          </MetricGrid>

          <ChartGrid>
            <SectionCard
              title="Failures per day"
              total={fmtNum(s.total)}
              subtitle="Bars sum to the total above."
            >
              <AreaChart data={s.perDay} label="Failures per day" />
            </SectionCard>
            <SectionCard
              title="By source"
              total={fmtNum(s.total)}
              subtitle="Which pipeline the failure came from."
            >
              <BarList
                data={Object.entries(s.byKind).map(([label, value]) => ({
                  label: KIND_LABEL[label] ?? label,
                  value,
                }))}
                total={s.total}
              />
            </SectionCard>
          </ChartGrid>

          {/* The centrepiece: what is failing most, and what it looks like. */}
          <SectionCard
            title="Top failure causes"
            subtitle="Similar messages are grouped by signature — ids, paths, times and numbers are normalized away."
          >
            {s.topSignatures.length === 0 ? (
              <div className="grid h-24 place-items-center text-xs text-text-muted">
                No failures in this range.
              </div>
            ) : (
              <ul className="space-y-2">
                {s.topSignatures.map((g) => (
                  <li key={g.signature}>
                    <AdminCard pad="sm" className="flex items-start gap-3">
                      <span className="mt-0.5 grid min-w-9 shrink-0 place-items-center rounded-md border border-rose-400/25 bg-rose-500/10 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-rose-200">
                        {g.count}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-text-primary" title={g.sampleMessage}>
                          {g.sampleMessage}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-text-muted">
                          <MicroLabel>{KIND_LABEL[g.kind] ?? g.kind}</MicroLabel>
                          <span>last seen {fmtRelative(g.lastSeenAt)}</span>
                        </p>
                      </div>
                    </AdminCard>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {s.byErrorCode.length > 0 && (
            <SectionCard
              title="Cloud export error codes"
              subtitle="Structured codes recorded by the render worker."
            >
              <BarList data={s.byErrorCode} />
            </SectionCard>
          )}

          {d.rows.length === 0 ? (
            <EmptyPanel
              label="No failures match these filters"
              hint="That's good news — try widening the date range to confirm."
            />
          ) : (
            <>
              <DataTable
                caption="Individual failures across all pipelines, newest first"
                columns={columns}
                rows={d.rows}
                rowKey={(r) => r.id}
                minWidth={960}
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
