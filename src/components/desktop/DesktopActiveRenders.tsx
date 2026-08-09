"use client";

import * as React from "react";
import Link from "next/link";
import { Ban, Cpu, Loader2 } from "lucide-react";
import { useDesktopExport } from "@/components/export/DesktopExportProvider";
import { Button } from "@/components/ui/Button";
import { projectHref } from "./project-route";

const STAGE_LABEL: Record<string, string> = {
  preparing: "Preparing",
  rendering: "Rendering frames",
  encoding: "Encoding video",
};

function fmtEta(ms?: number): string {
  if (!ms || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `about ${s}s left`;
  const m = Math.floor(s / 60);
  return `about ${m}m ${s % 60}s left`;
}

/**
 * The render running in THIS app right now.
 *
 * Its progress is real: the numbers come from the render child process's own
 * frame counter over IPC, not from a timer pretending to be one. There is at
 * most one at a time by design — the export provider refuses a second while one
 * is in flight, because they would contend for the same CPU and both get slower.
 */
export function DesktopActiveRenders() {
  const desktopExport = useDesktopExport();
  const job = desktopExport?.job ?? null;
  const active = desktopExport?.isExporting ?? false;

  if (!desktopExport || !job || !active) return null;

  const pct = Math.round(Math.min(1, Math.max(0, job.progress)) * 100);
  const eta = fmtEta(job.etaMs);

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
        <Cpu size={14} className="text-violet-300" />
        Rendering on this computer
      </h2>

      <div className="glass rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={projectHref(job.projectId)}
              className="truncate text-sm font-medium text-white underline-offset-4 hover:underline"
            >
              {job.projectTitle}
            </Link>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-fog">
              <Loader2 size={11} className="animate-spin text-violet-300" />
              {STAGE_LABEL[job.status] ?? "Working"}
              {eta && <span>· {eta}</span>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm tabular-nums text-white">{pct}%</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => desktopExport.cancelExport()}
              leftIcon={<Ban size={13} />}
            >
              Cancel
            </Button>
          </div>
        </div>

        <div
          className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${job.projectTitle} export progress`}
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </section>
  );
}
