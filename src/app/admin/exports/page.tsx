"use client";

import * as React from "react";
import { Download, CheckCircle2, XCircle, Droplet } from "lucide-react";
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
import { fmtBytes, fmtDate, fmtElapsed, fmtNum, truncateMiddle } from "@/components/admin/format";

interface ExportRow {
  id: string;
  uid: string;
  projectId: string;
  projectTitle: string;
  format: string;
  resolution: string;
  fps: number;
  status: string;
  applyWatermark: boolean;
  fileSize: number | null;
  monthlyBucket: string | null;
  errorMessage: string | null;
  createdAt: number;
  completedAt: number;
  durationMs: number | null;
}

interface ExportExtra {
  byStatus: Record<string, number>;
  byFormat: Record<string, number>;
  byResolution: Record<string, number>;
  watermarked: number;
}

const STATUS_OPTIONS = ["queued", "permitted", "exporting", "ready", "failed"].map((s) => ({
  value: s,
  label: s,
}));

export default function AdminExportsPage() {
  const [status, setStatus] = React.useState("");
  const list = useAdminList<ExportRow, ExportExtra>("/api/admin/exports", {
    status: status || undefined,
  });
  const e = list.extra;
  const byStatus = e.byStatus ?? {};
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const columns: Column<ExportRow>[] = [
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
    { key: "format", header: "Format", render: (r) => r.format },
    { key: "res", header: "Quality", render: (r) => `${r.resolution} · ${r.fps}fps` },
    { key: "size", header: "Size", render: (r) => (r.fileSize ? fmtBytes(r.fileSize) : "—") },
    {
      key: "wm",
      header: "Watermark",
      align: "center",
      render: (r) => (r.applyWatermark ? "Yes" : "No"),
    },
    { key: "dur", header: "Render", render: (r) => fmtElapsed(r.durationMs) },
    { key: "created", header: "Created", align: "right", render: (r) => fmtDate(r.createdAt) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Exports"
        subtitle="Render outcomes, formats and watermark usage."
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
        <LoadingPanel label="Loading exports…" />
      ) : list.error ? (
        <ErrorPanel message={list.error} />
      ) : list.indexBuilding ? (
        <IndexBuildingPanel />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label="Total exports" value={fmtNum(total)} icon={<Download size={16} />} />
            <MetricCard
              label="Ready"
              value={fmtNum(byStatus.ready ?? 0)}
              icon={<CheckCircle2 size={16} />}
              tone="good"
            />
            <MetricCard
              label="Failed"
              value={fmtNum(byStatus.failed ?? 0)}
              icon={<XCircle size={16} />}
              tone={byStatus.failed ? "bad" : "default"}
            />
            <MetricCard
              label="Watermarked"
              value={fmtNum(e.watermarked ?? 0)}
              sub="free-tier renders (sample)"
              icon={<Droplet size={16} />}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <GlassCard>
              <div className="mb-4 text-sm font-medium text-white">Output format</div>
              {e.byFormat && Object.keys(e.byFormat).length ? (
                <BarList data={Object.entries(e.byFormat).map(([label, value]) => ({ label, value }))} />
              ) : (
                <EmptyInline />
              )}
            </GlassCard>
            <GlassCard>
              <div className="mb-4 text-sm font-medium text-white">Resolution</div>
              {e.byResolution && Object.keys(e.byResolution).length ? (
                <BarList
                  data={Object.entries(e.byResolution).map(([label, value]) => ({ label, value }))}
                />
              ) : (
                <EmptyInline />
              )}
            </GlassCard>
          </div>

          {list.rows.length === 0 ? (
            <EmptyPanel label="No exports yet" />
          ) : (
            <>
              <DataTable columns={columns} rows={list.rows} rowKey={(r) => r.id} minWidth={860} />
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
