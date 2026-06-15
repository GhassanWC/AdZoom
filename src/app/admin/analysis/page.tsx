"use client";

import * as React from "react";
import { Cpu, CheckCircle2, XCircle, Timer } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { MetricCard } from "@/components/admin/MetricCard";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { Tag, statusTone } from "@/components/admin/Tag";
import { FilterSelect } from "@/components/admin/FilterSelect";
import { BarList } from "@/components/admin/Charts";
import { LoadMore } from "@/components/admin/LoadMore";
import {
  LoadingPanel,
  ErrorPanel,
  EmptyPanel,
  IndexBuildingPanel,
} from "@/components/admin/StatePanels";
import { useAdminList } from "@/components/admin/useAdminList";
import { fmtDate, fmtDuration, fmtNum, truncateMiddle } from "@/components/admin/format";

interface AnalysisRow {
  id: string;
  uid: string;
  projectId: string;
  projectTitle: string;
  status: string;
  engine: string | null;
  chunkMode: string | null;
  chunkCount: number;
  completedCount: number;
  failedCount: number;
  progress: number;
  duration: number;
  startedAt: number;
  completedAt: number;
}

interface AnalysisExtra {
  statusBreakdown: Record<string, number>;
  engineUsage: Record<string, number>;
  chunkModes: Record<string, number>;
  avgDurationSeconds: number;
  avgChunksPerVideo: number;
}

const STATUS_OPTIONS = ["queued", "running", "complete", "failed", "cancelled"].map((s) => ({
  value: s,
  label: s,
}));

export default function AdminAnalysisPage() {
  const [status, setStatus] = React.useState("");
  const list = useAdminList<AnalysisRow, AnalysisExtra>("/api/admin/analysis", {
    status: status || undefined,
  });
  const e = list.extra;
  const breakdown = e.statusBreakdown ?? {};
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  const columns: Column<AnalysisRow>[] = [
    {
      key: "project",
      header: "Project",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-white/90">{r.projectTitle}</div>
          <div className="truncate text-xs text-fog" title={r.uid}>
            {truncateMiddle(r.uid, 8, 4)}
          </div>
        </div>
      ),
    },
    { key: "status", header: "Status", render: (r) => <Tag label={r.status} tone={statusTone(r.status)} /> },
    { key: "engine", header: "Engine", render: (r) => r.engine ?? "—" },
    { key: "mode", header: "Detail", render: (r) => r.chunkMode ?? "—" },
    {
      key: "chunks",
      header: "Chunks",
      align: "right",
      render: (r) => `${r.completedCount}/${r.chunkCount}${r.failedCount ? ` (${r.failedCount} failed)` : ""}`,
    },
    { key: "duration", header: "Video", render: (r) => fmtDuration(r.duration) },
    { key: "started", header: "Started", align: "right", render: (r) => fmtDate(r.startedAt) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Analysis"
        subtitle="Chunked analysis jobs, engines and outcomes."
        action={
          <FilterSelect
            value={status}
            onChange={setStatus}
            options={STATUS_OPTIONS}
            allLabel="All statuses"
            ariaLabel="Filter by status"
          />
        }
      />

      {list.loading ? (
        <LoadingPanel label="Loading analysis jobs…" />
      ) : list.error ? (
        <ErrorPanel message={list.error} />
      ) : list.indexBuilding ? (
        <IndexBuildingPanel />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label="Total jobs" value={fmtNum(total)} icon={<Cpu size={16} />} />
            <MetricCard
              label="Completed"
              value={fmtNum(breakdown.complete ?? 0)}
              icon={<CheckCircle2 size={16} />}
              tone="good"
            />
            <MetricCard
              label="Failed"
              value={fmtNum(breakdown.failed ?? 0)}
              icon={<XCircle size={16} />}
              tone={breakdown.failed ? "bad" : "default"}
            />
            <MetricCard
              label="Avg time / chunks"
              value={fmtDuration(e.avgDurationSeconds ?? 0)}
              sub={`${fmtNum(e.avgChunksPerVideo ?? 0)} chunks/video avg`}
              icon={<Timer size={16} />}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <GlassCard>
              <div className="mb-4 text-sm font-medium text-white">Engine usage</div>
              {e.engineUsage && Object.keys(e.engineUsage).length ? (
                <BarList
                  data={Object.entries(e.engineUsage).map(([label, value]) => ({ label, value }))}
                />
              ) : (
                <EmptyInline />
              )}
            </GlassCard>
            <GlassCard>
              <div className="mb-4 text-sm font-medium text-white">Analysis detail (chunk mode)</div>
              {e.chunkModes && Object.keys(e.chunkModes).length ? (
                <BarList
                  data={Object.entries(e.chunkModes).map(([label, value]) => ({ label, value }))}
                />
              ) : (
                <EmptyInline />
              )}
            </GlassCard>
          </div>

          {list.rows.length === 0 ? (
            <EmptyPanel label="No analysis jobs yet" />
          ) : (
            <>
              <DataTable columns={columns} rows={list.rows} rowKey={(r) => r.id} minWidth={840} />
              <LoadMore
                hasMore={list.hasMore}
                loading={list.loadingMore}
                onClick={list.loadMore}
                count={list.rows.length}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function EmptyInline() {
  return <div className="grid h-24 place-items-center text-xs text-fog">No data yet.</div>;
}
