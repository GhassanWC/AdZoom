"use client";

/**
 * Admin → Exports.
 *
 * THE BUG THIS PAGE EXISTED TO DEMONSTRATE
 * ----------------------------------------
 * "Total exports" showed 0 while the watermark card, both distribution charts
 * and the table all showed records. The card summed five `.count()`
 * aggregations that silently returned null (→ 0) when their index was missing,
 * while the charts and table were fed by a completely separate 1000-doc sample
 * query that had a working index.
 *
 * Now every number on this page — the cards, the status bar, both BarLists and
 * the table — comes from ONE scan (see api/admin/exports/route.ts). The card
 * total is `windowTotal`, and the status segments sum to exactly that by
 * construction. It also finally counts BOTH pipelines: browser renders
 * (`exports`) and paid cloud renders (`exportJobs`), the latter of which was
 * entirely absent from the admin before.
 */

import * as React from "react";
import { Download, CheckCircle2, XCircle, Droplet, Cloud, Timer } from "lucide-react";
import { MetricCard, MetricGrid } from "@/components/admin/MetricCard";
import { SectionCard } from "@/components/admin/AdminCard";
import { DataTable, CellStack, type Column } from "@/components/admin/DataTable";
import { BarList, StatusBar, AreaChart, StatusDot, type DayPoint, type Slice } from "@/components/admin/Charts";
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
import {
  useAdminListPage,
  type AdminListResponse,
} from "@/components/admin/useAdminListPage";
import {
  fmtBytes,
  fmtDate,
  fmtElapsed,
  fmtNum,
  fmtMinutes,
  truncateMiddle,
} from "@/components/admin/format";

interface ExportRow {
  id: string;
  uid: string;
  pipeline: "browser" | "cloud";
  projectId: string;
  projectTitle: string;
  format: string;
  resolution: string;
  fps: number;
  status: string;
  rawStatus: string;
  stage: string | null;
  applyWatermark: boolean;
  fileSize: number | null;
  errorMessage: string | null;
  errorCode: string | null;
  exportMinutes: number | null;
  plan: string | null;
  createdAt: number;
  completedAt: number | null;
  turnaroundMs: number | null;
}

interface ExportSummary {
  byStatus: Record<string, number>;
  byPipeline: Slice[];
  byFormat: Slice[];
  byResolution: Slice[];
  watermarked: number;
  totalBytes: number;
  avgTurnaroundMs: number | null;
  medianTurnaroundMs: number | null;
  cloudMinutes: number;
  perDay: DayPoint[];
}

const STATUS_OPTIONS = ["queued", "processing", "ready", "failed", "cancelled"].map((s) => ({
  value: s,
  label: s,
}));

const PIPELINE_OPTIONS = [
  { value: "browser", label: "Browser (free)" },
  { value: "cloud", label: "Cloud (paid)" },
];

export default function AdminExportsPage() {
  const [pipeline, setPipeline] = React.useState("");
  const q = useAdminListPage<AdminListResponse<ExportRow, ExportSummary>>(
    "/api/admin/exports",
    { extraParams: { pipeline: pipeline || undefined } }
  );

  const d = q.data;
  const s = d?.summary;

  const columns: Column<ExportRow>[] = [
    {
      key: "project",
      header: "Project",
      render: (r) => (
        <CellStack
          primary={r.projectTitle}
          secondary={truncateMiddle(r.uid, 8, 4)}
          title={`${r.projectTitle} · ${r.uid}`}
        />
      ),
    },
    {
      key: "pipeline",
      header: "Pipeline",
      render: (r) => (
        <span className="capitalize text-text-secondary">{r.pipeline}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <div>
          <StatusDot status={r.status} />
          {/* The normalized bucket drives the chart; the raw status is what the
              operator needs when debugging a specific job. */}
          {r.rawStatus !== r.status && (
            <div className="text-[11px] text-text-muted">{r.stage ?? r.rawStatus}</div>
          )}
        </div>
      ),
    },
    { key: "format", header: "Format", hideOnMobile: true, render: (r) => r.format },
    {
      key: "res",
      header: "Quality",
      hideOnMobile: true,
      render: (r) => `${r.resolution}${r.fps ? ` · ${r.fps}fps` : ""}`,
    },
    {
      key: "size",
      header: "Size",
      align: "right",
      hideOnMobile: true,
      render: (r) => (r.fileSize ? fmtBytes(r.fileSize) : "—"),
    },
    {
      key: "minutes",
      header: "Billed",
      align: "right",
      hideOnMobile: true,
      render: (r) => fmtMinutes(r.exportMinutes),
    },
    {
      key: "dur",
      header: "Turnaround",
      align: "right",
      hideOnMobile: true,
      render: (r) => fmtElapsed(r.turnaroundMs),
    },
    {
      key: "created",
      header: "Created",
      align: "right",
      render: (r) => fmtDate(r.createdAt),
    },
  ];

  return (
    <PageFrame
      title="Exports"
      subtitle="Browser and cloud renders, outcomes and format mix."
      state={{ ...q, hasData: Boolean(d) }}
      truncated={d?.truncated}
      scanned={d?.scanned}
      toolbar={
        <Toolbar>
          <SearchInput
            value={q.search}
            onChange={q.setSearch}
            label="Search exports by project, user or id"
            placeholder="Project, uid, id…"
          />
          <FilterSelect
            value={pipeline}
            onChange={setPipeline}
            options={PIPELINE_OPTIONS}
            allLabel="All pipelines"
            label="Filter by pipeline"
          />
          <FilterSelect
            value={q.status}
            onChange={q.setStatus}
            options={STATUS_OPTIONS}
            allLabel="All statuses"
            label="Filter by status"
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
              label="Total exports"
              value={fmtNum(d.windowTotal)}
              sub="browser + cloud, in range"
              icon={<Download size={15} />}
              tone="accent"
            />
            <MetricCard
              label="Ready"
              value={fmtNum(s.byStatus.ready ?? 0)}
              sub={`${fmtNum(s.byStatus.processing ?? 0)} processing · ${fmtNum(s.byStatus.queued ?? 0)} queued`}
              icon={<CheckCircle2 size={15} />}
              tone="good"
            />
            <MetricCard
              label="Failed"
              value={fmtNum(s.byStatus.failed ?? 0)}
              sub={`${fmtNum(s.byStatus.cancelled ?? 0)} cancelled`}
              icon={<XCircle size={15} />}
              tone={(s.byStatus.failed ?? 0) > 0 ? "bad" : "default"}
            />
            <MetricCard
              label="Watermarked"
              value={fmtNum(s.watermarked)}
              sub="free-tier browser renders"
              icon={<Droplet size={15} />}
            />
          </MetricGrid>

          <MetricGrid>
            <MetricCard
              label="Cloud minutes billed"
              value={fmtMinutes(s.cloudMinutes) === "—" ? "0 min" : fmtMinutes(s.cloudMinutes)}
              sub="consumed, else estimated"
              icon={<Cloud size={15} />}
            />
            <MetricCard
              label="Median turnaround"
              value={fmtElapsed(s.medianTurnaroundMs)}
              sub={`mean ${fmtElapsed(s.avgTurnaroundMs)} · queue + render`}
              icon={<Timer size={15} />}
            />
            <MetricCard
              label="Output stored"
              value={s.totalBytes > 0 ? fmtBytes(s.totalBytes) : "—"}
              sub="sum of recorded file sizes"
              icon={<Download size={15} />}
            />
            <MetricCard
              label="Cloud share"
              value={fmtNum(s.byPipeline.find((p) => p.label === "cloud")?.value ?? 0)}
              sub={`of ${fmtNum(d.windowTotal)} total exports`}
              icon={<Cloud size={15} />}
            />
          </MetricGrid>

          <ChartGrid>
            <SectionCard
              title="Exports per day"
              total={fmtNum(d.windowTotal)}
              subtitle="Bars sum to the total above — same query, same window."
            >
              <AreaChart data={s.perDay} label="Exports per day" />
            </SectionCard>
            <SectionCard title="Status breakdown" total={fmtNum(d.windowTotal)}>
              <StatusBar counts={s.byStatus} />
            </SectionCard>
          </ChartGrid>

          <ChartGrid>
            <SectionCard title="Output format" subtitle="Across both pipelines">
              <BarList data={s.byFormat} total={d.windowTotal} />
            </SectionCard>
            <SectionCard title="Resolution" subtitle="Cloud heights mapped to the same labels">
              <BarList data={s.byResolution} total={d.windowTotal} />
            </SectionCard>
          </ChartGrid>

          {d.rows.length === 0 ? (
            <EmptyPanel
              label="No exports match these filters"
              hint="Try widening the date range or clearing the status and pipeline filters."
            />
          ) : (
            <>
              <DataTable
                caption="Exports across all users, newest first"
                columns={columns}
                rows={d.rows}
                rowKey={(r) => `${r.pipeline}:${r.uid}:${r.id}`}
                minWidth={980}
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
