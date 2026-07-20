"use client";

/**
 * Admin → Analysis.
 *
 * The headline fix: "Avg time" used to average `AnalysisJob.duration`, which is
 * the SOURCE VIDEO'S LENGTH (schema.ts:1341), not processing time — the card
 * reported how long users' videos were and labelled it analysis throughput.
 * Real processing time is `completedAt − startedAt` over completed jobs, shown
 * here as median (primary) with the mean beside it, and average video length
 * reported separately as its own distinct metric.
 *
 * The page also carries a standing caveat: `analysisJobs` documents exist only
 * for videos past the 90s chunking threshold, so this counts chunked runs, not
 * all analyses.
 */

import { Cpu, CheckCircle2, XCircle, Timer } from "lucide-react";
import { MetricCard, MetricGrid } from "@/components/admin/MetricCard";
import { SectionCard } from "@/components/admin/AdminCard";
import { DataTable, CellStack, type Column } from "@/components/admin/DataTable";
import {
  BarList,
  StatusBar,
  AreaChart,
  StatusDot,
  type DayPoint,
  type Slice,
} from "@/components/admin/Charts";
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
import {
  fmtDate,
  fmtDuration,
  fmtElapsed,
  fmtNum,
  truncateMiddle,
} from "@/components/admin/format";

interface AnalysisRow {
  id: string;
  uid: string;
  projectId: string;
  projectTitle: string;
  status: string;
  engine: string;
  chunkMode: string;
  chunkCount: number;
  completedCount: number;
  failedCount: number;
  progress: number;
  videoSeconds: number;
  momentsSoFar: number;
  startedAt: number;
  completedAt: number | null;
  processingMs: number | null;
}

interface AnalysisSummary {
  byStatus: Record<string, number>;
  byEngine: Slice[];
  byChunkMode: Slice[];
  avgProcessingMs: number | null;
  medianProcessingMs: number | null;
  avgVideoSeconds: number | null;
  avgChunksPerJob: number | null;
  completedSample: number;
  perDay: DayPoint[];
}

const STATUS_OPTIONS = ["queued", "running", "complete", "failed", "cancelled"].map((s) => ({
  value: s,
  label: s,
}));

const COVERAGE_CAVEAT =
  "Chunked jobs only — videos under 90s analyze in-place and create no job document.";

export default function AdminAnalysisPage() {
  const q = useAdminListPage<AdminListResponse<AnalysisRow, AnalysisSummary>>(
    "/api/admin/analysis"
  );
  const d = q.data;
  const s = d?.summary;

  const columns: Column<AnalysisRow>[] = [
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
    { key: "status", header: "Status", render: (r) => <StatusDot status={r.status} /> },
    {
      key: "progress",
      header: "Chunks",
      hideOnMobile: true,
      render: (r) =>
        r.chunkCount > 0 ? (
          <span className="tabular-nums">
            {r.completedCount}/{r.chunkCount}
            {r.failedCount > 0 && (
              <span className="ml-1.5 text-rose-300">({r.failedCount} failed)</span>
            )}
          </span>
        ) : (
          "—"
        ),
    },
    { key: "engine", header: "Engine", hideOnMobile: true, render: (r) => r.engine },
    { key: "mode", header: "Detail", hideOnMobile: true, render: (r) => r.chunkMode },
    {
      key: "video",
      header: "Video",
      align: "right",
      hideOnMobile: true,
      render: (r) => fmtDuration(r.videoSeconds),
    },
    {
      key: "processing",
      header: "Processing",
      align: "right",
      render: (r) => fmtElapsed(r.processingMs),
    },
    { key: "started", header: "Started", align: "right", render: (r) => fmtDate(r.startedAt) },
  ];

  return (
    <PageFrame
      title="Analysis"
      subtitle="Chunked AI analysis jobs, throughput and failures."
      state={{ ...q, hasData: Boolean(d) }}
      truncated={d?.truncated}
      scanned={d?.scanned}
      toolbar={
        <Toolbar>
          <SearchInput
            value={q.search}
            onChange={q.setSearch}
            label="Search analysis jobs"
            placeholder="Project, uid, id…"
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
              label="Total jobs"
              value={fmtNum(d.windowTotal)}
              icon={<Cpu size={15} />}
              tone="accent"
              caveat={COVERAGE_CAVEAT}
            />
            <MetricCard
              label="Completed"
              value={fmtNum(s.byStatus.complete ?? 0)}
              sub={`${fmtNum(s.byStatus.running ?? 0)} running · ${fmtNum(s.byStatus.queued ?? 0)} queued`}
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
              label="Median processing time"
              value={fmtElapsed(s.medianProcessingMs)}
              sub={`mean ${fmtElapsed(s.avgProcessingMs)} · ${fmtNum(s.completedSample)} completed`}
              icon={<Timer size={15} />}
            />
          </MetricGrid>

          <ChartGrid>
            <SectionCard
              title="Jobs started per day"
              total={fmtNum(d.windowTotal)}
              subtitle="Bars sum to the total above — same query, same window."
            >
              <AreaChart data={s.perDay} label="Analysis jobs started per day" />
            </SectionCard>
            <SectionCard title="Status breakdown" total={fmtNum(d.windowTotal)}>
              <StatusBar
                counts={s.byStatus}
                order={["queued", "running", "complete", "cancelled", "failed"]}
              />
            </SectionCard>
          </ChartGrid>

          <ChartGrid>
            <SectionCard
              title="CV engine"
              subtitle="Which decoder processed each job"
              action={
                <div className="text-right">
                  <div className="text-[11px] text-text-muted">Avg video</div>
                  <div className="text-sm tabular-nums text-text-primary">
                    {fmtDuration(s.avgVideoSeconds)}
                  </div>
                </div>
              }
            >
              <BarList data={s.byEngine} total={d.windowTotal} />
            </SectionCard>
            <SectionCard
              title="Analysis detail"
              subtitle="Chunk-size preset requested"
              action={
                <div className="text-right">
                  <div className="text-[11px] text-text-muted">Avg chunks</div>
                  <div className="text-sm tabular-nums text-text-primary">
                    {s.avgChunksPerJob != null ? s.avgChunksPerJob.toFixed(1) : "—"}
                  </div>
                </div>
              }
            >
              <BarList data={s.byChunkMode} total={d.windowTotal} />
            </SectionCard>
          </ChartGrid>

          {d.rows.length === 0 ? (
            <EmptyPanel
              label="No analysis jobs match these filters"
              hint="Only videos longer than 90 seconds create a job document."
            />
          ) : (
            <>
              <DataTable
                caption="Analysis jobs across all users, newest first"
                columns={columns}
                rows={d.rows}
                rowKey={(r) => `${r.uid}:${r.id}`}
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
