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
  Cloud,
  Zap,
  RefreshCw,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeExports } from "@/lib/firebase/exports";
import {
  subscribeExportJobs,
  isActiveJob,
  progressPercent,
  type ExportJobView,
} from "@/lib/firebase/export-jobs";
import { useExport } from "@/components/export/ExportProvider";
import type { ExportDoc } from "@/lib/firebase/schema";
import { downloadFile } from "@/lib/download";
import { cn } from "@/lib/cn";

const TONE: Record<string, string> = {
  ready: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  exporting: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  rendering: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  uploading: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300",
  permitted: "border-violet-400/20 bg-violet-400/[0.06] text-fog",
  queued: "border-white/10 bg-white/[0.03] text-fog",
  batch_submitted: "border-white/10 bg-white/[0.03] text-fog",
  failed: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  canceled: "border-white/10 bg-white/[0.03] text-fog/70",
};

/** Friendly label for the status pill (raw status → human text). */
const STATUS_LABEL: Record<string, string> = {
  batch_submitted: "preparing",
};

/** A browser export or a cloud export job, normalized for the unified table. */
interface UnifiedRow {
  id: string;
  source: "browser" | "cloud";
  projectId: string;
  projectTitle: string;
  format: string;
  /** File extension for the download filename ("mp4" | "webm"). */
  ext: string;
  size?: number;
  createdAt: number;
  status: string;
  downloadUrl?: string;
  progress: number;
  active: boolean;
  priority: boolean;
  cancelable: boolean;
  /** Cloud terminal failures can be retried into a fresh job. */
  retryable: boolean;
  // ── Failure diagnostics (cloud) ──
  errorCode?: string;
  errorMessage?: string;
  failedAt?: number;
  buildVersion?: string;
  workerId?: string;
}

/** Build a safe download filename from a project title + extension. */
function downloadName(row: UnifiedRow): string {
  const base = (row.projectTitle || "framevo-export").replace(/[^\w.-]+/g, "_");
  return `${base}.${row.ext}`;
}

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

function containerLabel(row: ExportDoc): string {
  const ext = row.storagePath?.split(".").pop()?.toLowerCase();
  if (ext === "mp4" || ext === "webm") return ext.toUpperCase();
  return row.container ? row.container.toUpperCase() : "";
}

function browserRow(r: ExportDoc): UnifiedRow {
  const ext = containerLabel(r);
  return {
    id: r.id,
    source: "browser",
    projectId: r.projectId,
    projectTitle: r.projectTitle,
    format: `${r.format} · ${r.resolution} · ${r.fps}fps${ext ? ` · ${ext}` : ""}`,
    ext: (ext || "webm").toLowerCase(),
    size: r.fileSize,
    createdAt: r.createdAt,
    status: r.status,
    downloadUrl: r.exportUrl,
    progress: 0,
    active: r.status === "exporting",
    priority: false,
    cancelable: false,
    retryable: false,
  };
}

function cloudRow(j: ExportJobView): UnifiedRow {
  const active = isActiveJob(j);
  return {
    id: j.id,
    source: "cloud",
    projectId: j.projectId,
    projectTitle: j.projectTitle,
    format: `MP4 · ${j.outputWidth}×${j.outputHeight} · ${j.fps}fps`,
    ext: "mp4",
    size: undefined,
    createdAt: j.createdAt,
    status: j.status,
    downloadUrl: j.downloadUrl,
    progress: j.progress ?? 0,
    active,
    priority: j.priority === "priority",
    cancelable: active,
    retryable: j.status === "failed" || j.status === "canceled",
    errorCode: j.errorCode,
    errorMessage: j.errorMessage,
    failedAt: j.failedAt,
    buildVersion: j.buildVersion,
    workerId: j.workerId,
  };
}

export default function ExportsPage() {
  const { user, getIdToken } = useAuth();
  const { job, isExporting, cancelExport, downloadCurrent, clearJob } = useExport();
  const [rows, setRows] = React.useState<ExportDoc[]>([]);
  const [cloudJobs, setCloudJobs] = React.useState<ExportJobView[]>([]);
  const [loadedBrowser, setLoadedBrowser] = React.useState(false);
  const [loadedCloud, setLoadedCloud] = React.useState(false);
  const [retryingId, setRetryingId] = React.useState<string | null>(null);
  const loaded = loadedBrowser && loadedCloud;

  React.useEffect(() => {
    if (!user) return;
    const unsubB = subscribeExports(user.uid, (next) => {
      setRows(next);
      setLoadedBrowser(true);
    });
    const unsubC = subscribeExportJobs(user.uid, (next) => {
      setCloudJobs(next);
      setLoadedCloud(true);
    });
    return () => {
      unsubB();
      unsubC();
    };
  }, [user]);

  const cancelCloud = React.useCallback(
    async (jobId: string) => {
      try {
        const token = await getIdToken();
        if (!token) return;
        await fetch("/api/export/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jobId }),
        });
      } catch (err) {
        console.warn("[exports] cancel failed", err);
      }
    },
    [getIdToken]
  );

  // Retry a failed/canceled cloud export → fresh job (server dedups if an
  // identical export is somehow already active). Spam-proof per row.
  const retryCloud = React.useCallback(
    async (jobId: string) => {
      if (retryingId) return;
      setRetryingId(jobId);
      try {
        const token = await getIdToken();
        if (!token) return;
        const res = await fetch("/api/export/retry", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jobId }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; jobId?: string };
        console.log("[exports] retry", { fromJobId: jobId, jobId: data.jobId, ok: data.ok });
      } catch (err) {
        console.warn("[exports] retry failed", err);
      } finally {
        setRetryingId(null);
      }
    },
    [getIdToken, retryingId]
  );

  // The live browser session job owns the card above; hide its persisted doc so
  // it isn't shown twice. Merge browser + cloud, newest first, then split into
  // ACTIVE (in-flight) vs HISTORY (terminal) so the page reads cleanly.
  const { active, history } = React.useMemo(() => {
    const browser = (job ? rows.filter((r) => r.id !== job.id) : rows).map(browserRow);
    const cloud = cloudJobs.map(cloudRow);
    const all = [...browser, ...cloud].sort((a, b) => b.createdAt - a.createdAt);
    return {
      active: all.filter((r) => r.active),
      history: all.filter((r) => !r.active),
    };
  }, [rows, cloudJobs, job]);

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
              <span className="truncate text-sm font-medium text-white">{job.projectTitle}</span>
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
      ) : active.length === 0 && history.length === 0 ? (
        !job && (
          <div className="glass rounded-2xl p-12 text-center text-sm text-fog">
            No exports yet. Open a project and click{" "}
            <strong className="text-white">Export</strong> to render one.
          </div>
        )
      ) : (
        <div className="space-y-6">
          {active.length > 0 && (
            <Section title="Active" hint="Currently rendering">
              {active.map((row, i) => (
                <RowItem
                  key={`${row.source}:${row.id}`}
                  row={row}
                  last={i === active.length - 1}
                  retryingId={retryingId}
                  onCancel={cancelCloud}
                  onRetry={retryCloud}
                />
              ))}
            </Section>
          )}

          {history.length > 0 && (
            <Section title="History" hint="Previous exports">
              {history.map((row, i) => (
                <RowItem
                  key={`${row.source}:${row.id}`}
                  row={row}
                  last={i === history.length - 1}
                  retryingId={retryingId}
                  onCancel={cancelCloud}
                  onRetry={retryCloud}
                />
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fog">{title}</h3>
        <span className="text-[11px] text-fog/60">{hint}</span>
      </div>
      <div className="glass overflow-hidden rounded-2xl">
        <div className="hidden grid-cols-[1fr_140px_120px_120px_140px_120px] gap-4 border-b border-white/[0.06] px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog md:grid">
          <div>Project</div>
          <div>Format</div>
          <div>Size</div>
          <div>Date</div>
          <div>Status</div>
          <div />
        </div>
        {children}
      </div>
    </div>
  );
}

function RowItem({
  row,
  last,
  retryingId,
  onCancel,
  onRetry,
}: {
  row: UnifiedRow;
  last: boolean;
  retryingId: string | null;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
}) {
  const isFailed = row.status === "failed";
  return (
    <div className={cn(!last && "border-b border-white/[0.04]")}>
      <div className="grid grid-cols-1 gap-3 px-5 py-4 text-sm md:grid-cols-[1fr_140px_120px_120px_140px_120px] md:items-center md:gap-4 md:py-3">
        <Link
          href={`/dashboard/projects/${row.projectId}`}
          className="truncate font-medium text-white hover:text-violet-300"
        >
          {row.projectTitle}
        </Link>
        <div className="flex flex-wrap items-center gap-1.5 text-fog">
          <span>{row.format}</span>
          {row.source === "cloud" && (
            <span className="inline-flex items-center gap-1 rounded-full border border-violet-400/25 bg-violet-500/10 px-1.5 py-0.5 text-[9.5px] font-semibold text-violet-200">
              <Cloud size={9} /> Cloud
            </span>
          )}
          {row.priority && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-1.5 py-0.5 text-[9.5px] font-semibold text-amber-200">
              <Zap size={9} /> Priority
            </span>
          )}
        </div>
        <div className="font-mono text-xs tabular-nums text-fog">{fmtBytes(row.size)}</div>
        <div className="text-fog">{relTime(row.createdAt)}</div>
        <div>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
              TONE[row.status] ?? TONE.queued
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                row.status === "ready" && "bg-emerald-400",
                (row.status === "exporting" ||
                  row.status === "rendering" ||
                  row.status === "uploading" ||
                  row.status === "batch_submitted") &&
                  "animate-pulse bg-violet-400",
                (row.status === "queued" || row.status === "canceled") && "bg-fog",
                row.status === "failed" && "bg-rose-400"
              )}
            />
            {STATUS_LABEL[row.status] ?? row.status}
            {row.active && row.source === "cloud" && row.progress > 0
              ? ` ${progressPercent(row)}%`
              : ""}
          </span>
        </div>
        <div className="flex justify-end gap-1.5">
          {row.cancelable && (
            <button
              onClick={() => void onCancel(row.id)}
              aria-label="Cancel"
              className="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] text-fog transition-colors duration-200 hover:border-rose-300/40 hover:text-rose-200"
            >
              <X size={13} />
            </button>
          )}
          {row.retryable && row.source === "cloud" && (
            <button
              onClick={() => void onRetry(row.id)}
              disabled={retryingId === row.id}
              aria-label="Retry export"
              title="Retry export"
              className="inline-flex size-8 items-center justify-center rounded-md border border-violet-400/30 bg-violet-500/10 text-violet-200 transition-colors duration-200 hover:bg-violet-500/20 disabled:opacity-50"
            >
              {retryingId === row.id ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
            </button>
          )}
          {row.downloadUrl && (
            <button
              type="button"
              onClick={() => void downloadFile(row.downloadUrl!, downloadName(row))}
              aria-label="Download previous export"
              title="Download previous export"
              className="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] text-fog transition-colors duration-200 hover:border-white/20 hover:text-white"
            >
              <Download size={13} />
            </button>
          )}
          {row.downloadUrl && (
            <a
              href={row.downloadUrl}
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

      {/* Failed-row diagnostics — exact reason, not just "failed". */}
      {isFailed && (row.errorMessage || row.errorCode) && (
        <div className="border-t border-rose-400/10 bg-rose-500/[0.03] px-5 py-3">
          <div className="flex items-start gap-2 text-[12px] text-rose-100/90">
            <AlertCircle size={13} className="mt-0.5 shrink-0 text-rose-300" />
            <span className="min-w-0">{row.errorMessage || "Export failed."}</span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] sm:grid-cols-4">
            <Meta label="Error code" value={row.errorCode} mono />
            <Meta label="Failed" value={row.failedAt ? relTime(row.failedAt) : undefined} />
            <Meta label="Build" value={row.buildVersion} mono />
            <Meta label="Worker" value={row.workerId} mono />
          </dl>
        </div>
      )}
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex flex-col">
      <dt className="text-rose-200/50">{label}</dt>
      <dd className={cn("truncate text-rose-100/90", mono && "font-mono")}>{value}</dd>
    </div>
  );
}
