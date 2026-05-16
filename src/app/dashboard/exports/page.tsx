"use client";

import * as React from "react";
import Link from "next/link";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { getFirebase } from "@/lib/firebase/client";
import type { ExportDoc } from "@/lib/firebase/schema";
import { cn } from "@/lib/cn";

const TONE: Record<string, string> = {
  ready: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  exporting: "border-violet-400/30 bg-violet-400/10 text-violet-300",
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
  const [rows, setRows] = React.useState<ExportDoc[]>([]);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    const q = query(
      collection(db, "users", user.uid, "exports"),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(q, (snap) => {
      const next: ExportDoc[] = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        const createdAt = data.createdAt as { toMillis?: () => number } | undefined;
        const completedAt = data.completedAt as { toMillis?: () => number } | undefined;
        return {
          id: d.id,
          projectId: (data.projectId as string) ?? "",
          projectTitle: (data.projectTitle as string) ?? "Untitled",
          format: (data.format as ExportDoc["format"]) ?? "1080p",
          resolution: (data.resolution as ExportDoc["resolution"]) ?? "1080p",
          fps: (data.fps as ExportDoc["fps"]) ?? 30,
          exportUrl: data.exportUrl as string | undefined,
          storagePath: data.storagePath as string | undefined,
          fileSize: data.fileSize as number | undefined,
          status: (data.status as ExportDoc["status"]) ?? "queued",
          errorMessage: data.errorMessage as string | undefined,
          createdAt: createdAt?.toMillis?.() ?? Date.now(),
          completedAt: completedAt?.toMillis?.(),
        };
      });
      setRows(next);
      setLoaded(true);
    });
    return () => unsub();
  }, [user]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Exports"
        title="Export history"
        subtitle="Every render kept in your workspace. Download anytime."
      />

      {!loaded ? (
        <div className="glass grid place-items-center rounded-2xl p-12 text-sm text-fog">
          <Loader2 size={14} className="mr-2 inline animate-spin text-violet-300" />
          Loading exports…
        </div>
      ) : rows.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center text-sm text-fog">
          No exports yet. Open a project and click <strong className="text-white">Export</strong> to render one.
        </div>
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
          {rows.map((row, i) => (
            <div
              key={row.id}
              className={cn(
                "grid grid-cols-1 gap-3 px-5 py-4 text-sm md:grid-cols-[1fr_140px_120px_120px_140px_120px] md:items-center md:gap-4 md:py-3",
                i !== rows.length - 1 && "border-b border-white/[0.04]"
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
