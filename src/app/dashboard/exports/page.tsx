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
  Monitor,
  Zap,
  Clock,
  RefreshCw,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeExports } from "@/lib/firebase/exports";
import {
  subscribeExportJobs,
  isActiveJob,
  isWaitingForSlot,
  progressPercent,
  WAITING_FOR_SLOT_MESSAGE,
  type ExportJobView,
} from "@/lib/firebase/export-jobs";
import { useExport } from "@/components/export/ExportProvider";
import type { ExportDoc } from "@/lib/firebase/schema";
import { downloadFile, startServerDownload } from "@/lib/download";
import { cn } from "@/lib/cn";

/**
 * The unified engine-agnostic view of one export, whatever produced it:
 *   • "cloud"     — a server render job (`exportJobs`).
 *   • "editframe" — an in-browser render, logged for visibility. Not stored, so
 *                   the row is a record of the activity with no re-download.
 *   • "browser"   — a legacy permit-flow browser upload (has a stored file).
 */
interface UnifiedRow {
  id: string;
  source: "browser" | "cloud";
  engine?: "browser" | "editframe" | "cloud";
  /** In-browser renders aren't kept in storage — the row shows no download. */
  stored?: boolean;
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
  /** Deferred waiting for a global export slot (status pill shows it). */
  waitingForSlot?: boolean;
  // ── Failure diagnostics (cloud) ──
  errorCode?: string;
  errorMessage?: string;
  failedAt?: number;
  buildVersion?: string;
  workerId?: string;
}

/**
 * One visual identity per status: the left glyph, the pill tone, and the label.
 * Keeping it in one place is what makes every row read the same at a glance.
 */
type StatusKind = "ready" | "active" | "queued" | "failed" | "canceled";

function statusKind(status: string): StatusKind {
  if (status === "ready" || status === "completed") return "ready";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  if (status === "queued" || status === "permitted") return "queued";
  return "active"; // exporting | rendering | uploading | batch_submitted
}

const STATUS_STYLE: Record<
  StatusKind,
  { label: string; pill: string; dot: string; glyph: string; Icon: typeof CheckCircle2; spin?: boolean }
> = {
  ready: {
    label: "Ready",
    pill: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    dot: "bg-emerald-400",
    glyph: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/20",
    Icon: CheckCircle2,
  },
  active: {
    label: "Rendering",
    pill: "border-violet-400/30 bg-violet-400/10 text-violet-200",
    dot: "animate-pulse bg-violet-400",
    glyph: "bg-violet-500/15 text-violet-300 ring-violet-400/20",
    Icon: Loader2,
    spin: true,
  },
  queued: {
    label: "Queued",
    pill: "border-white/10 bg-white/[0.04] text-fog",
    dot: "bg-fog/70",
    glyph: "bg-white/[0.05] text-fog ring-white/10",
    Icon: Clock,
  },
  failed: {
    label: "Failed",
    pill: "border-rose-400/30 bg-rose-400/10 text-rose-300",
    dot: "bg-rose-400",
    glyph: "bg-rose-500/15 text-rose-300 ring-rose-400/20",
    Icon: AlertCircle,
  },
  canceled: {
    label: "Canceled",
    pill: "border-white/10 bg-white/[0.03] text-fog/70",
    dot: "bg-fog/50",
    glyph: "bg-white/[0.04] text-fog/70 ring-white/10",
    Icon: Ban,
  },
};

/** Per-status pill text, honoring the "queued for a slot" and "saving" nuances. */
function pillLabel(row: UnifiedRow): string {
  if (row.waitingForSlot) return WAITING_FOR_SLOT_MESSAGE;
  if (row.status === "uploading") return "Saving";
  if (row.status === "batch_submitted") return "Preparing";
  const base = STATUS_STYLE[statusKind(row.status)].label;
  if (row.active && row.source === "cloud" && row.progress > 0) {
    return `${base} · ${progressPercent(row)}%`;
  }
  return base;
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
  if (!bytes) return null;
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
  const isEditframe = r.engine === "editframe";
  const ext = containerLabel(r);
  const dims =
    r.outputWidth && r.outputHeight ? `${r.outputWidth}×${r.outputHeight}` : r.resolution;
  const format = isEditframe
    ? `${ext || "MP4"} · ${dims} · ${r.fps}fps`
    : `${r.format} · ${r.resolution} · ${r.fps}fps${ext ? ` · ${ext}` : ""}`;
  return {
    id: r.id,
    source: "browser",
    engine: r.engine,
    stored: r.stored,
    projectId: r.projectId,
    projectTitle: r.projectTitle,
    format,
    ext: (ext || "mp4").toLowerCase(),
    size: r.fileSize,
    createdAt: r.createdAt,
    status: r.status,
    downloadUrl: r.exportUrl,
    progress: 0,
    active: r.status === "exporting",
    priority: false,
    cancelable: false,
    retryable: false,
    errorMessage: r.errorMessage,
    failedAt: r.status === "failed" ? r.completedAt : undefined,
  };
}

function cloudRow(j: ExportJobView): UnifiedRow {
  const active = isActiveJob(j);
  return {
    id: j.id,
    source: "cloud",
    engine: "cloud",
    stored: true,
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
    waitingForSlot: isWaitingForSlot(j),
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

  // Download a finished export. Cloud rows go through the secure direct-download
  // route (signed URL, no Blob/proxy — fast for large MP4s); browser rows keep
  // the existing object-URL save (their bytes are already public/local).
  const downloadRow = React.useCallback(
    async (row: UnifiedRow) => {
      if (row.source === "cloud") {
        try {
          const token = await getIdToken();
          if (!token) throw new Error("not-signed-in");
          await startServerDownload(row.id, token);
          return;
        } catch (err) {
          console.warn("[exports] cloud download failed", err);
          if (row.downloadUrl) window.open(row.downloadUrl, "_blank", "noreferrer");
          return;
        }
      }
      if (row.downloadUrl) void downloadFile(row.downloadUrl, downloadName(row));
    },
    [getIdToken]
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

  const readyCount = history.filter((r) => statusKind(r.status) === "ready").length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Exports"
        title="Export history"
        subtitle="Every render you've started — in-browser or on our servers — kept in one place."
      />

      {job && <LiveJobCard
        job={job}
        isExporting={isExporting}
        onCancel={cancelExport}
        onDownload={downloadCurrent}
        onDismiss={clearJob}
      />}

      {!loaded ? (
        <div className="glass grid place-items-center rounded-2xl p-16 text-sm text-fog">
          <Loader2 size={16} className="mb-3 animate-spin text-violet-300" />
          Loading your exports…
        </div>
      ) : active.length === 0 && history.length === 0 ? (
        !job && <EmptyState />
      ) : (
        <div className="space-y-8">
          {active.length > 0 && (
            <Section
              title="In progress"
              hint={`${active.length} rendering now`}
              rows={active}
              retryingId={retryingId}
              onCancel={cancelCloud}
              onRetry={retryCloud}
              onDownload={downloadRow}
            />
          )}
          {history.length > 0 && (
            <Section
              title="History"
              hint={
                readyCount > 0
                  ? `${history.length} total · ${readyCount} ready to download`
                  : `${history.length} total`
              }
              rows={history}
              retryingId={retryingId}
              onCancel={cancelCloud}
              onRetry={retryCloud}
              onDownload={downloadRow}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Live session card (legacy browser render) ───────────────────────────────
function LiveJobCard({
  job,
  isExporting,
  onCancel,
  onDownload,
  onDismiss,
}: {
  job: NonNullable<ReturnType<typeof useExport>["job"]>;
  isExporting: boolean;
  onCancel: () => void;
  onDownload: () => void;
  onDismiss: () => void;
}) {
  const kind = statusKind(job.status === "completed" ? "ready" : job.status);
  const s = STATUS_STYLE[kind];
  return (
    <div
      className={cn(
        "glass flex items-center gap-4 rounded-2xl p-4",
        kind === "ready" && "border-emerald-400/20",
        kind === "failed" && "border-rose-400/20"
      )}
    >
      <span
        className={cn(
          "inline-flex size-10 shrink-0 items-center justify-center rounded-xl ring-1",
          s.glyph
        )}
      >
        <s.Icon size={17} className={cn(s.spin && "animate-spin")} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-white">{job.projectTitle}</span>
          {isExporting && (
            <span className="font-mono text-[11px] tabular-nums text-fog">
              {Math.round((job.progress || 0) * 100)}%
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11.5px] text-fog">
          {job.outputFormat} · {relTime(job.startedAt)}
        </div>
        {isExporting && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-200"
              style={{ width: `${Math.max(2, (job.progress || 0) * 100)}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {isExporting ? (
          <ActionBtn label="Cancel export" onClick={onCancel} tone="danger" text="Cancel" />
        ) : job.status === "completed" ? (
          <>
            <ActionBtn label="Download" onClick={onDownload} tone="primary" icon={<Download size={14} />} />
            <ActionBtn label="Dismiss" onClick={onDismiss} icon={<X size={14} />} />
          </>
        ) : (
          <ActionBtn label="Dismiss" onClick={onDismiss} icon={<X size={14} />} />
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="glass rounded-2xl px-6 py-16 text-center">
      <span className="mx-auto mb-4 inline-flex size-12 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-300 ring-1 ring-violet-400/20">
        <Download size={20} />
      </span>
      <h3 className="text-base font-semibold text-white">No exports yet</h3>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-fog">
        Open a project and click <strong className="font-medium text-white">Export</strong> — your
        renders will show up here, ready to download.
      </p>
      <Link
        href="/dashboard/projects"
        className="mt-5 inline-flex h-10 items-center justify-center rounded-xl bg-violet-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-violet-400"
      >
        Go to projects
      </Link>
    </div>
  );
}

// ── Section (a titled group of rows) ─────────────────────────────────────────
function Section({
  title,
  hint,
  rows,
  retryingId,
  onCancel,
  onRetry,
  onDownload,
}: {
  title: string;
  hint: string;
  rows: UnifiedRow[];
  retryingId: string | null;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  onDownload: (row: UnifiedRow) => void;
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2.5 px-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/80">
          {title}
        </h2>
        <span className="text-[11px] text-fog/60">{hint}</span>
      </div>
      <div className="glass overflow-hidden rounded-2xl">
        {rows.map((row, i) => (
          <RowItem
            key={`${row.source}:${row.id}`}
            row={row}
            last={i === rows.length - 1}
            retryingId={retryingId}
            onCancel={onCancel}
            onRetry={onRetry}
            onDownload={onDownload}
          />
        ))}
      </div>
    </section>
  );
}

// ── One export row ───────────────────────────────────────────────────────────
function RowItem({
  row,
  last,
  retryingId,
  onCancel,
  onRetry,
  onDownload,
}: {
  row: UnifiedRow;
  last: boolean;
  retryingId: string | null;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  onDownload: (row: UnifiedRow) => void;
}) {
  const kind = statusKind(row.status);
  const s = STATUS_STYLE[kind];
  const size = fmtBytes(row.size);
  const inBrowser = row.engine === "editframe";
  const canDownload = !!row.downloadUrl || (row.source === "cloud" && row.status === "ready");
  const isFailed = kind === "failed";

  return (
    <div className={cn("transition-colors duration-150 hover:bg-white/[0.015]", !last && "border-b border-white/[0.05]")}>
      <div className="flex items-center gap-3.5 px-4 py-3.5 sm:px-5">
        {/* Status glyph */}
        <span
          className={cn(
            "hidden size-9 shrink-0 items-center justify-center rounded-xl ring-1 sm:inline-flex",
            s.glyph
          )}
          aria-hidden
        >
          <s.Icon size={15} className={cn(s.spin && "animate-spin")} />
        </span>

        {/* Title + meta */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={`/dashboard/projects/${row.projectId}`}
              className="truncate text-sm font-semibold text-white transition-colors hover:text-violet-300"
              dir="auto"
            >
              {row.projectTitle || "Untitled"}
            </Link>
            {row.source === "cloud" ? (
              <Badge tone="violet" icon={<Cloud size={9} />}>Cloud</Badge>
            ) : inBrowser ? (
              <Badge tone="sky" icon={<Monitor size={9} />}>In-browser</Badge>
            ) : null}
            {row.priority && (
              <Badge tone="amber" icon={<Zap size={9} />}>Priority</Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-fog">
            <span className="tabular-nums">{row.format}</span>
            <Dot />
            <span>{relTime(row.createdAt)}</span>
            {size && (
              <>
                <Dot />
                <span className="font-mono tabular-nums">{size}</span>
              </>
            )}
            {inBrowser && kind === "ready" && (
              <>
                <Dot />
                <span className="text-fog/60">downloaded when it finished</span>
              </>
            )}
          </div>
        </div>

        {/* Status pill */}
        <span
          className={cn(
            "hidden shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium sm:inline-flex",
            s.pill
          )}
        >
          <span className={cn("size-1.5 rounded-full", s.dot)} />
          {pillLabel(row)}
        </span>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          {row.cancelable && (
            <ActionBtn
              label="Cancel export"
              onClick={() => void onCancel(row.id)}
              tone="danger"
              icon={<X size={14} />}
            />
          )}
          {row.retryable && row.source === "cloud" && (
            <ActionBtn
              label="Retry export"
              onClick={() => void onRetry(row.id)}
              tone="primary"
              disabled={retryingId === row.id}
              icon={
                retryingId === row.id ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <RefreshCw size={14} />
                )
              }
            />
          )}
          {canDownload && (
            <ActionBtn
              label="Download export"
              onClick={() => onDownload(row)}
              tone="ready"
              icon={<Download size={14} />}
            />
          )}
          {row.downloadUrl && (
            <a
              href={row.downloadUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Open in new tab"
              title="Open in new tab"
              className="inline-flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.02] text-fog transition-colors duration-150 hover:border-white/20 hover:text-white"
            >
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      </div>

      {/* Mobile status pill (glyph column is hidden on small screens) */}
      <div className="flex items-center gap-2 px-4 pb-3 sm:hidden">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
            s.pill
          )}
        >
          <span className={cn("size-1.5 rounded-full", s.dot)} />
          {pillLabel(row)}
        </span>
      </div>

      {/* Failed-row diagnostics — the exact reason, not just "failed". */}
      {isFailed && (row.errorMessage || row.errorCode) && (
        <div className="border-t border-rose-400/10 bg-rose-500/[0.03] px-4 py-3 sm:px-5">
          <div className="flex items-start gap-2 text-[12px] text-rose-100/90">
            <AlertCircle size={13} className="mt-0.5 shrink-0 text-rose-300" />
            <span className="min-w-0">{row.errorMessage || "Export failed."}</span>
          </div>
          {(row.errorCode || row.failedAt || row.buildVersion || row.workerId) && (
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] sm:grid-cols-4">
              <Meta label="Error code" value={row.errorCode} mono />
              <Meta label="Failed" value={row.failedAt ? relTime(row.failedAt) : undefined} />
              <Meta label="Build" value={row.buildVersion} mono />
              <Meta label="Worker" value={row.workerId} mono />
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

// ── Small building blocks ────────────────────────────────────────────────────
function Dot() {
  return <span className="text-fog/30">·</span>;
}

function Badge({
  tone,
  icon,
  children,
}: {
  tone: "violet" | "sky" | "amber";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const tones = {
    violet: "border-violet-400/25 bg-violet-500/10 text-violet-200",
    sky: "border-sky-400/25 bg-sky-500/10 text-sky-200",
    amber: "border-amber-300/30 bg-amber-400/10 text-amber-200",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide",
        tones[tone]
      )}
    >
      {icon}
      {children}
    </span>
  );
}

function ActionBtn({
  label,
  onClick,
  icon,
  text,
  tone,
  disabled,
}: {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  text?: string;
  tone?: "primary" | "ready" | "danger";
  disabled?: boolean;
}) {
  const toneCls =
    tone === "ready"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20"
      : tone === "primary"
        ? "border-violet-400/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20"
        : tone === "danger"
          ? "border-white/10 bg-white/[0.02] text-fog hover:border-rose-300/40 hover:text-rose-200"
          : "border-white/10 bg-white/[0.02] text-fog hover:border-white/20 hover:text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border text-[12px] font-medium transition-colors duration-150 disabled:opacity-50",
        text ? "px-3" : "size-8",
        toneCls
      )}
    >
      {icon}
      {text}
    </button>
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
