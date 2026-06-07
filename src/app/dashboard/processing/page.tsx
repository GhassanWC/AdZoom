"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Cpu,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCcw,
  ExternalLink,
  Ban,
} from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import {
  subscribeAnalysisJobs,
  updateAnalysisJob,
  getChunks,
  updateChunk,
} from "@/lib/firebase/analysis-jobs";
import type { AnalysisJob } from "@/lib/firebase/schema";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

const ACTIVE: AnalysisJob["status"][] = ["queued", "running"];

function fmtDuration(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function fmtEta(ms?: number): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

const STATUS_STYLE: Record<
  AnalysisJob["status"],
  { label: string; chip: string; Icon: typeof Cpu }
> = {
  queued: { label: "Queued", chip: "border-white/15 bg-white/[0.04] text-fog", Icon: Clock },
  running: {
    label: "Processing",
    chip: "border-violet-400/40 bg-violet-500/15 text-violet-100",
    Icon: Loader2,
  },
  complete: {
    label: "Complete",
    chip: "border-emerald-400/40 bg-emerald-500/15 text-emerald-100",
    Icon: CheckCircle2,
  },
  failed: { label: "Failed", chip: "border-rose-400/40 bg-rose-500/15 text-rose-100", Icon: XCircle },
  cancelled: { label: "Cancelled", chip: "border-white/15 bg-white/[0.04] text-fog", Icon: Ban },
};

export default function ProcessingPage() {
  const { user } = useAuth();
  const [jobs, setJobs] = React.useState<AnalysisJob[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);

  React.useEffect(() => {
    if (!user) return;
    setLoaded(false);
    const unsub = subscribeAnalysisJobs(user.uid, (list) => {
      setJobs(list);
      setLoaded(true);
    });
    return () => unsub();
  }, [user]);

  const visible = jobs.filter((j) => (showAll ? true : ACTIVE.includes(j.status)));
  const activeCount = jobs.filter((j) => ACTIVE.includes(j.status)).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Processing"
        title="Analysis jobs"
        subtitle={`${activeCount} ${activeCount === 1 ? "job" : "jobs"} in progress. Long videos analyze in chunks — edits appear as each chunk finishes.`}
        action={
          <Button
            variant="ghost"
            size="md"
            onClick={() => setShowAll((v) => !v)}
            leftIcon={<Cpu size={14} />}
          >
            {showAll ? "Show active only" : "Show all"}
          </Button>
        }
      />

      {!loaded ? (
        <div className="glass grid place-items-center rounded-2xl p-12 text-sm text-fog">
          <Loader2 size={14} className="mr-2 inline animate-spin text-violet-300" />
          Loading jobs…
        </div>
      ) : visible.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center text-sm text-fog">
          {jobs.length === 0
            ? "No analysis jobs yet. Long videos (over 90s) analyze progressively here."
            : "No active jobs. Toggle “Show all” to see finished ones."}
        </div>
      ) : (
        <div className="space-y-4">
          {visible.map((job) => (
            <JobCard key={job.id} uid={user!.uid} job={job} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobCard({ uid, job }: { uid: string; job: AnalysisJob }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const status = STATUS_STYLE[job.status];
  const pct = Math.round((job.progress ?? 0) * 100);
  const queued = Math.max(
    0,
    job.chunkCount - job.completedCount - job.processingCount - job.failedCount
  );

  const onCancel = async () => {
    setBusy(true);
    try {
      await updateAnalysisJob(uid, job.id, {
        cancelRequested: true,
        status: "cancelled",
      });
    } finally {
      setBusy(false);
    }
  };

  const onRetry = async () => {
    setBusy(true);
    try {
      const chunks = await getChunks(uid, job.id);
      const failed = chunks.filter((c) => c.status === "failed");
      await Promise.all(
        failed.map((c) =>
          updateChunk(uid, job.id, c.id, { status: "queued", attempts: 0, errorMessage: undefined })
        )
      );
      await updateAnalysisJob(uid, job.id, {
        status: "running",
        failedCount: 0,
        cancelRequested: false,
      });
      // The editor's resume effect re-runs queued chunks on (re)open.
      router.push(`/dashboard/projects/${job.projectId}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-display text-[15px] font-semibold text-white">
              {job.projectTitle}
            </h3>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                status.chip
              )}
            >
              <status.Icon
                size={11}
                className={job.status === "running" ? "animate-spin" : undefined}
              />
              {status.label}
            </span>
          </div>
          <p className="mt-1 font-mono text-[11px] text-fog">
            {fmtDuration(job.duration)} · {job.chunkCount} chunks ·{" "}
            {job.engine === "webcodecs" ? "WebCodecs" : "compat"} engine
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            href={`/dashboard/projects/${job.projectId}`}
            variant="ghost"
            size="sm"
            leftIcon={<ExternalLink size={13} />}
          >
            Open project
          </Button>
          {job.failedCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRetry}
              disabled={busy}
              leftIcon={<RefreshCcw size={13} />}
            >
              Retry failed
            </Button>
          )}
          {ACTIVE.includes(job.status) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={busy}
              leftIcon={<Ban size={13} />}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between text-[11px] text-fog">
          <span>
            <span className="font-semibold text-white">{pct}%</span> ·{" "}
            {job.completedCount}/{job.chunkCount} chunks · {job.momentsSoFar} edits
          </span>
          {job.status === "running" && (
            <span>~{fmtEta(job.estimateRemainingMs)} remaining</span>
          )}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-[width] duration-500"
            style={{ width: `${Math.max(2, pct)}%` }}
          />
        </div>
      </div>

      {/* Chunk counters */}
      <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
        <Counter label="Completed" value={job.completedCount} tone="emerald" />
        <Counter label="Processing" value={job.processingCount} tone="violet" />
        <Counter label="Queued" value={queued} tone="fog" />
        <Counter label="Failed" value={job.failedCount} tone="rose" />
      </div>
    </div>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "emerald" | "violet" | "fog" | "rose";
}) {
  const tint =
    tone === "emerald"
      ? "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-100"
      : tone === "violet"
        ? "border-violet-400/30 bg-violet-500/[0.1] text-violet-100"
        : tone === "rose"
          ? "border-rose-400/30 bg-rose-500/[0.08] text-rose-100"
          : "border-white/10 bg-white/[0.025] text-fog";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-medium",
        tint
      )}
    >
      <span className="uppercase tracking-[0.12em] opacity-80">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  );
}
