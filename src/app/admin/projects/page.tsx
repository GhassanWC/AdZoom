"use client";

import * as React from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { Tag, statusTone } from "@/components/admin/Tag";
import { FilterSelect } from "@/components/admin/FilterSelect";
import { LoadMore } from "@/components/admin/LoadMore";
import {
  LoadingPanel,
  ErrorPanel,
  EmptyPanel,
  IndexBuildingPanel,
} from "@/components/admin/StatePanels";
import { useAdminList } from "@/components/admin/useAdminList";
import {
  VideoPreviewModal,
  type VideoPreviewTarget,
} from "@/components/admin/VideoPreviewModal";
import { fmtBytes, fmtDate, fmtDuration, truncateMiddle } from "@/components/admin/format";

interface ProjectRow {
  id: string;
  uid: string;
  title: string;
  status: string;
  duration: number | null;
  fileSize: number | null;
  interactionScope: string | null;
  analysisStatus: string | null;
  momentCount: number;
  createdAt: number;
}

const STATUS_OPTIONS = [
  "uploaded",
  "analyzing",
  "analyzed",
  "exported",
  "failed",
  "cancelled",
].map((s) => ({ value: s, label: s }));

export default function AdminProjectsPage() {
  const [status, setStatus] = React.useState("");
  const [preview, setPreview] = React.useState<VideoPreviewTarget | null>(null);
  const list = useAdminList<ProjectRow>("/api/admin/projects", { status: status || undefined });

  const columns: Column<ProjectRow>[] = [
    {
      key: "title",
      header: "Project",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-white/90">{r.title}</div>
          <div className="truncate text-xs text-fog" title={r.uid}>
            {truncateMiddle(r.uid, 8, 4)}
          </div>
        </div>
      ),
    },
    { key: "status", header: "Status", render: (r) => <Tag label={r.status} tone={statusTone(r.status)} /> },
    {
      key: "source",
      header: "Source",
      render: (r) => (r.interactionScope === "tab" ? "Recording" : "Upload"),
    },
    { key: "duration", header: "Duration", render: (r) => fmtDuration(r.duration) },
    { key: "size", header: "Size", render: (r) => (r.fileSize ? fmtBytes(r.fileSize) : "—") },
    {
      key: "analysis",
      header: "Analysis",
      render: (r) =>
        r.analysisStatus ? (
          <span className="text-fog">
            {r.analysisStatus}
            {r.momentCount ? ` · ${r.momentCount} moments` : ""}
          </span>
        ) : (
          "—"
        ),
    },
    { key: "created", header: "Created", align: "right", render: (r) => fmtDate(r.createdAt) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Projects"
        subtitle="Every project across all users."
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
        <LoadingPanel label="Loading projects…" />
      ) : list.error ? (
        <ErrorPanel message={list.error} />
      ) : list.indexBuilding ? (
        <IndexBuildingPanel />
      ) : list.rows.length === 0 ? (
        <EmptyPanel label="No projects yet" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={list.rows}
            rowKey={(r) => r.id}
            minWidth={820}
            onRowClick={(r) => setPreview({ id: r.id, uid: r.uid, title: r.title })}
          />
          <LoadMore
            hasMore={list.hasMore}
            loading={list.loadingMore}
            onClick={list.loadMore}
            count={list.rows.length}
          />
        </>
      )}

      <VideoPreviewModal target={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
