"use client";

/**
 * Cross-recording edit-coverage audit (internal / dev-only).
 *
 * Reads the per-recording `analysis.editDiagnostics` persisted by the analyze
 * route across all of the user's projects, aggregates the funnel, and reports
 * the dominant bottleneck — so we can answer, with numbers across many
 * recordings, "out of N meaningful interactions, how many does Framevo edit?".
 * Reporting-only; never mutates projects.
 */

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeProjects } from "@/lib/firebase/projects";
import { PageHeader } from "@/components/dashboard/PageHeader";
import {
  BOTTLENECK_LABEL,
  classifyBottleneck,
} from "@/lib/diagnostics/edit-diagnostics";
import type {
  EditBottleneck,
  EditDiagnostics,
  ProjectDoc,
} from "@/lib/firebase/schema";

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function covClass(cov: number): string {
  if (cov >= 0.7) return "text-emerald-300";
  if (cov >= 0.4) return "text-amber-300";
  return "text-rose-300";
}

interface Row {
  project: ProjectDoc;
  diag: EditDiagnostics;
  bottleneck: EditBottleneck;
  evidence: string;
}

export default function DiagnosticsPage() {
  const { user } = useAuth();
  const [projects, setProjects] = React.useState<ProjectDoc[]>([]);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (!user) return;
    setLoaded(false);
    const unsub = subscribeProjects(user.uid, (list) => {
      setProjects(list);
      setLoaded(true);
    });
    return () => unsub();
  }, [user]);

  const rows: Row[] = React.useMemo(() => {
    return projects
      .filter((p) => p.analysis?.editDiagnostics)
      .map((p) => {
        const diag = p.analysis!.editDiagnostics!;
        const v = classifyBottleneck(diag);
        return { project: p, diag, bottleneck: v.kind, evidence: v.evidence };
      });
  }, [projects]);

  const agg = React.useMemo(() => {
    const sum = (sel: (d: EditDiagnostics) => number) =>
      rows.reduce((a, r) => a + sel(r.diag), 0);
    const importantTotal = sum((d) => d.importantDetected);
    // Pooled coverage: weight each recording's adjusted coverage by how many
    // important moments it had, so big recordings count proportionally.
    const weightedCov =
      importantTotal > 0
        ? sum((d) => d.coverageAdjusted * d.importantDetected) / importantTotal
        : 0;
    const bottleneckCounts = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.bottleneck] = (acc[r.bottleneck] ?? 0) + 1;
      return acc;
    }, {});
    const dominant = (Object.entries(bottleneckCounts).sort(
      (a, b) => b[1] - a[1]
    )[0]?.[0] ?? "healthy") as EditBottleneck;
    return {
      n: rows.length,
      clicks: sum((d) => d.totalClicks),
      scroll: sum((d) => d.totalScroll),
      hover: sum((d) => d.totalHover),
      nav: sum((d) => d.navScene),
      important: importantTotal,
      generated: sum((d) => d.aiProposed),
      applied: sum((d) => d.timelineApplied),
      intentional: sum((d) => d.intentionalDrops),
      suppressed: sum((d) => d.suppressedDrops),
      weightedCov,
      bottleneckCounts,
      dominant,
    };
  }, [rows]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Internal"
        title="Edit-coverage audit"
        subtitle="Aggregate editing funnel across all analyzed recordings. Reporting-only — no tuning."
      />

      {!loaded && (
        <div className="flex items-center gap-2 text-sm text-fog">
          <Loader2 size={14} className="animate-spin" /> Loading projects…
        </div>
      )}

      {loaded && rows.length === 0 && (
        <p className="glass rounded-2xl border border-white/10 px-4 py-6 text-sm text-fog">
          No recordings have edit diagnostics yet. Analyze a recording (the
          analyze route populates <code>analysis.editDiagnostics</code>), then
          return here.
        </p>
      )}

      {loaded && rows.length > 0 && (
        <>
          {/* Headline aggregate */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            <AggStat label="Recordings" value={String(agg.n)} />
            <AggStat label="Clicks" value={String(agg.clicks)} />
            <AggStat label="Scroll" value={String(agg.scroll)} />
            <AggStat label="Hover" value={String(agg.hover)} />
            <AggStat label="Navigation" value={String(agg.nav)} />
            <AggStat label="Important moments" value={String(agg.important)} />
            <AggStat label="AI edits generated" value={String(agg.generated)} />
            <AggStat label="Edits applied" value={String(agg.applied)} />
            <AggStat
              label="Intentional drops"
              value={String(agg.intentional)}
            />
            <AggStat label="Suppressed drops" value={String(agg.suppressed)} />
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-fog">
                Pooled coverage
              </div>
              <div
                className={`text-[20px] font-semibold ${covClass(agg.weightedCov)}`}
              >
                {pct(agg.weightedCov)}
              </div>
            </div>
            <div className="rounded-xl border border-violet-400/20 bg-violet-500/[0.06] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-violet-200">
                Dominant bottleneck
              </div>
              <div className="text-[15px] font-semibold text-white">
                {BOTTLENECK_LABEL[agg.dominant]}
              </div>
            </div>
          </div>

          {/* Bottleneck distribution */}
          <div className="glass rounded-2xl border border-white/10 p-4">
            <h3 className="mb-3 text-[13px] font-semibold text-white">
              Bottleneck distribution
            </h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(agg.bottleneckCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([kind, n]) => (
                  <span
                    key={kind}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[12px] text-white/85"
                  >
                    {BOTTLENECK_LABEL[kind as EditBottleneck]}
                    <span className="font-mono text-fog">{n}</span>
                  </span>
                ))}
            </div>
          </div>

          {/* Per-recording table */}
          <div className="glass overflow-hidden rounded-2xl border border-white/10">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-ink/60 text-fog">
                <tr>
                  <th className="px-3 py-2">Recording</th>
                  <th className="px-3 py-2">Clicks</th>
                  <th className="px-3 py-2">Important</th>
                  <th className="px-3 py-2">Generated</th>
                  <th className="px-3 py-2">Applied</th>
                  <th className="px-3 py-2">Coverage</th>
                  <th className="px-3 py-2">Bottleneck</th>
                </tr>
              </thead>
              <tbody className="text-white/85">
                {rows.map(({ project, diag, bottleneck }) => (
                  <tr key={project.id} className="border-t border-white/5">
                    <td className="px-3 py-2">
                      <Link
                        href={`/dashboard/projects/${project.id}?debug=1`}
                        className="text-violet-300 hover:underline"
                      >
                        {project.title || project.id}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono">{diag.totalClicks}</td>
                    <td className="px-3 py-2 font-mono">
                      {diag.importantDetected}
                    </td>
                    <td className="px-3 py-2 font-mono">{diag.aiProposed}</td>
                    <td className="px-3 py-2 font-mono">
                      {diag.timelineApplied}
                    </td>
                    <td
                      className={`px-3 py-2 font-mono ${covClass(diag.coverageAdjusted)}`}
                    >
                      {pct(diag.coverageAdjusted)}
                    </td>
                    <td className="px-3 py-2">
                      {BOTTLENECK_LABEL[bottleneck]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function AggStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-fog">
        {label}
      </div>
      <div className="text-[20px] font-semibold text-white">{value}</div>
    </div>
  );
}
