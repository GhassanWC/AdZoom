"use client";

import * as React from "react";
import Link from "next/link";
import {
  Download,
  ExternalLink,
  Loader2,
  X,
  CheckCircle2,
  AlertCircle,
  Ban,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeExports } from "@/lib/firebase/exports";
import { useExport } from "@/components/export/ExportProvider";
import type { ExportDoc } from "@/lib/firebase/schema";
import { cn } from "@/lib/cn";

const TONE: Record<string, string> = {
  ready: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  exporting: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  permitted: "border-violet-400/20 bg-violet-400/[0.06] text-fog",
  queued: "border-white/10 bg-white/[0.03] text-fog",
  failed: "border-rose-400/30 bg-rose-400/10 text-rose-300",
};

function relTime(ms?: number) {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtBytes(bytes?: number) {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export default function ExportsPage() {
  const { user } = useAuth();
  const { job, isExporting, cancelExport, downloadCurrent, clearJob } =
    useExport();
  const [rows, setRows] = React.useState<ExportDoc[]>([]);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (!user) return;
    const unsub = subscribeExports(user.uid, (next) => {
      setRows(next);
      setLoaded(true);
    });
    return () => unsub();
  }, [user]);

  // The live session job owns its row (with progress + cancel + instant
  // download); hide the matching persisted doc so it isn't shown twice.
  const persisted = job ? rows.filter((r) => r.id !== job.id) : rows;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Exports"
        title="Export history"
        subtitle="Every render kept in your workspace. Download anytime."
      />

      {job && (
        <div
          className={cn(
            "glass flex items-center gap-3 rounded-2xl p-4",
            job.status === "completed" && "border-emerald-400/20",
            job.status === "failed" && "border-rose-400/20"
          )}
        >
          <span
            className={cn(
              "inline-flex size-9 shrink-0 items-center justify-center rounded-lg",
              job.status === "completed"
                ? "bg-emerald-500/15 text-emerald-300"
                : job.status === "failed"
                  ? "bg-rose-500/15 text-rose-300"
                  : job.status === "canceled"
                    ? "bg-white/[0.06] text-fog"
                    : "bg-violet-500/15 text-violet-300"
            )}
          >
            {job.status === "completed" ? (
              <CheckCircle2 size={15} />
            ) : job.status === "failed" ? (
              <AlertCircle size={15} />
            ) : job.status === "canceled" ? (
              <Ban size={15} />
            ) : (
              <Loader2 size={15} className="animate-spin" />
            )}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-white">
                {job.projectTitle}
              </span>
              <span className="font-mono text-[11px] tabular-nums text-fog">
                {isExporting ? `${Math.round((job.progress || 0) * 100)}%` : ""}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] text-fog">
              {job.outputFormat} ·{" "}
              {job.status === "preparing"
                ? "preparing"
                : job.status === "rendering"
                  ? "rendering"
                  : job.status === "uploading"
                    ? "saving"
                    : job.status}{" "}
              · {relTime(job.startedAt)}
            </div>
            {isExporting && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-200"
                  style={{ width: `${Math.max(2, (job.progress || 0) * 100)}%` }}
                />
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {isExporting ? (
              <button
                onClick={cancelExport}
                className="rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-[11px] font-medium text-fog transition-colors hover:border-rose-300/40 hover:text-rose-200"
              >
                Cancel
              </button>
            ) : job.status === "completed" ? (
              <>
                <button
                  onClick={downloadCurrent}
                  aria-label="Download"
                  className="inline-flex size-8 items-center justify-center rounded-md border border-emerald-400/30 bg-emerald-400/10 text-emerald-300 transition-colors hover:bg-emerald-400/20"
                >
                  <Download size={13} />
                </button>
                <button
                  onClick={clearJob}
                  aria-label="Dismiss"
                  className="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] text-fog transition-colors hover:text-white"
                >
                  <X size={13} />
                </button>
              </>
            ) : (
              <button
                onClick={clearJob}
                aria-label="Dismiss"
                className="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] text-fog transition-colors hover:text-white"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      {!loaded ? (
        <div className="glass grid place-items-center rounded-2xl p-12 text-sm text-fog">
          <Loader2 size={14} className="mr-2 inline animate-spin text-violet-300" />
          Loading exports…
        </div>
      ) : persisted.length === 0 ? (
        !job && (
          <div className="glass rounded-2xl p-12 text-center text-sm text-fog">
            No exports yet. Open a project and click{" "}
            <strong className="text-white">Export</strong> to render one.
          </div>
        )
      ) : (
        <div className="glass overflow-hidden rounded-2xl">
          <div className="hidden grid-cols-[1fr_140px_120px_120px_140px_120px] gap-4 border-b border-white/[0.06] px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog md:grid">
            <div>Project</div>
            <div>Format</div>
            <div>Size</div>
            <div>Date</div>
            <div>Status</div>
            <div />
          </div>
          {persisted.map((row, i) => (
            <div
              key={row.id}
              className={cn(
                "grid grid-cols-1 gap-3 px-5 py-4 text-sm md:grid-cols-[1fr_140px_120px_120px_140px_120px] md:items-center md:gap-4 md:py-3",
                i !== persisted.length - 1 && "border-b border-white/[0.04]"
              )}
            >
              <Link
                href={`/dashboard/projects/${row.projectId}`}
                className="truncate font-medium text-white hover:text-violet-300"
              >
                {row.projectTitle}
              </Link>
              <div className="text-fog">
                {row.format} · {row.resolution} · {row.fps}fps
              </div>
              <div className="font-mono text-xs tabular-nums text-fog">
                {fmtBytes(row.fileSize)}
              </div>
              <div className="text-fog">{relTime(row.createdAt)}</div>
              <div>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                    TONE[row.status]
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      row.status === "ready" && "bg-emerald-400",
                      row.status === "exporting" && "animate-pulse bg-violet-400",
                      row.status === "queued" && "bg-fog",
                      row.status === "failed" && "bg-rose-400"
                    )}
                  />
                  {row.status}
                </span>
              </div>
              <div className="flex justify-end gap-1.5">
                {row.exportUrl && (
                  <a
                    href={row.exportUrl}
                    download
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Download"
                    className="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] text-fog transition-colors duration-200 hover:border-white/20 hover:text-white"
                  >
                    <Download size={13} />
                  </a>
                )}
                {row.exportUrl && (
                  <a
                    href={row.exportUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open in new tab"
                    className="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] text-fog transition-colors duration-200 hover:border-white/20 hover:text-white"
                  >
                    <ExternalLink size={13} />
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
