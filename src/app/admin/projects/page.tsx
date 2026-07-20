"use client";

/**
 * Admin → Projects.
 *
 * Previously the only list page with zero aggregates and no search — you could
 * not find a project by title or owner at all. It now reports total, recently
 * created, analyzed and exported, plus lifecycle and analysis-status
 * distributions, all from the scan that feeds the table.
 *
 * Note: per-project moment COUNT is intentionally absent from this list. Reading
 * it requires deserializing the whole `analysis` map (transcripts, per-second
 * loudness arrays, edit diagnostics — often megabytes per document), which the
 * old route did for every row. The list now uses a field projection; the moment
 * count is available in the per-project detail this table's rows open.
 */

import * as React from "react";
import { Folder, Sparkles, Download, Clock } from "lucide-react";
import { MetricCard, MetricGrid } from "@/components/admin/MetricCard";
import { SectionCard } from "@/components/admin/AdminCard";
import { DataTable, CellStack, type Column } from "@/components/admin/DataTable";
import { BarList, AreaChart, StatusDot, type DayPoint, type Slice } from "@/components/admin/Charts";
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
  VideoPreviewModal,
  type VideoPreviewTarget,
} from "@/components/admin/VideoPreviewModal";
import { fmtBytes, fmtDate, fmtDuration, fmtNum, truncateMiddle } from "@/components/admin/format";

interface ProjectRow {
  id: string;
  uid: string;
  title: string;
  status: string;
  analysisStatus: string | null;
  duration: number | null;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ProjectSummary {
  byStatus: Record<string, number>;
  byStatusSlices: Slice[];
  byAnalysisStatus: Slice[];
  recent: number;
  analyzed: number;
  exported: number;
  failed: number;
  totalBytes: number;
  avgDurationSeconds: number | null;
  perDay: DayPoint[];
}

const STATUS_OPTIONS = [
  "uploading",
  "uploaded",
  "analyzing",
  "analyzed",
  "completed",
  "exporting",
  "exported",
  "cancelled",
  "failed",
].map((s) => ({ value: s, label: s }));

export default function AdminProjectsPage() {
  const [preview, setPreview] = React.useState<VideoPreviewTarget | null>(null);
  const q = useAdminListPage<AdminListResponse<ProjectRow, ProjectSummary>>(
    "/api/admin/projects"
  );
  const d = q.data;
  const s = d?.summary;

  const columns: Column<ProjectRow>[] = [
    {
      key: "project",
      header: "Project",
      render: (r) => (
        <CellStack
          primary={r.title}
          secondary={truncateMiddle(r.uid, 8, 4)}
          title={`${r.title} · ${r.uid}`}
        />
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusDot status={r.status} /> },
    {
      key: "analysis",
      header: "Analysis",
      hideOnMobile: true,
      render: (r) =>
        r.analysisStatus ? (
          <StatusDot status={r.analysisStatus} />
        ) : (
          <span className="text-text-muted">Not run</span>
        ),
    },
    {
      key: "duration",
      header: "Length",
      align: "right",
      hideOnMobile: true,
      render: (r) => fmtDuration(r.duration),
    },
    {
      key: "size",
      header: "Size",
      align: "right",
      hideOnMobile: true,
      render: (r) => (r.fileSize ? fmtBytes(r.fileSize) : "—"),
    },
    { key: "created", header: "Created", align: "right", render: (r) => fmtDate(r.createdAt) },
  ];

  return (
    <>
      <PageFrame
        title="Projects"
        subtitle="Every recording across all accounts, with lifecycle state."
        state={{ ...q, hasData: Boolean(d) }}
        truncated={d?.truncated}
        scanned={d?.scanned}
        toolbar={
          <Toolbar>
            <SearchInput
              value={q.search}
              onChange={q.setSearch}
              label="Search projects by title, owner or id"
              placeholder="Title, uid, id…"
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
                label="Projects in range"
                value={fmtNum(d.windowTotal)}
                sub={s.totalBytes > 0 ? `${fmtBytes(s.totalBytes)} of source video` : undefined}
                icon={<Folder size={15} />}
                tone="accent"
              />
              <MetricCard
                label="Created in last 7d"
                value={fmtNum(s.recent)}
                sub={`avg length ${fmtDuration(s.avgDurationSeconds)}`}
                icon={<Clock size={15} />}
              />
              <MetricCard
                label="Analyzed"
                value={fmtNum(s.analyzed)}
                sub="analysis completed at least once"
                icon={<Sparkles size={15} />}
                tone="good"
              />
              <MetricCard
                label="Exported"
                value={fmtNum(s.exported)}
                sub={`${fmtNum(s.failed)} failed`}
                icon={<Download size={15} />}
              />
            </MetricGrid>

            <ChartGrid>
              <SectionCard
                title="Projects created per day"
                total={fmtNum(d.windowTotal)}
                subtitle="Bars sum to the total above."
              >
                <AreaChart data={s.perDay} label="Projects created per day" />
              </SectionCard>
              <SectionCard title="Lifecycle status" total={fmtNum(d.windowTotal)}>
                <BarList data={s.byStatusSlices} total={d.windowTotal} colorByStatus />
              </SectionCard>
            </ChartGrid>

            <SectionCard
              title="Analysis status"
              total={fmtNum(d.windowTotal)}
              subtitle="Embedded analysis state per project."
            >
              <BarList data={s.byAnalysisStatus} total={d.windowTotal} colorByStatus />
            </SectionCard>

            {d.rows.length === 0 ? (
              <EmptyPanel
                label="No projects match these filters"
                hint="Try widening the date range or clearing the status filter."
              />
            ) : (
              <>
                <DataTable
                  caption="Projects across all users, newest first. Activate a row to preview the video."
                  columns={columns}
                  rows={d.rows}
                  rowKey={(r) => `${r.uid}:${r.id}`}
                  minWidth={880}
                  onRowClick={(r) => setPreview({ id: r.id, uid: r.uid, title: r.title })}
                  rowLabel={(r) => `Preview ${r.title}`}
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

      <VideoPreviewModal target={preview} onClose={() => setPreview(null)} />
    </>
  );
}
