"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Plus, Sparkles, Upload as UploadIcon } from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeProjects } from "@/lib/firebase/projects";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { RealProjectCard } from "@/components/dashboard/RealProjectCard";

export function DashboardHome() {
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

  const recent = projects.slice(0, 6);
  const totals = React.useMemo(() => {
    const ready = projects.filter((p) => p.status === "analyzed" || p.status === "exported").length;
    const analyzing = projects.filter((p) => p.status === "analyzing").length;
    const totalMoments = projects.reduce(
      (acc, p) => acc + (p.analysis?.detectedMoments?.length ?? 0),
      0
    );
    return { ready, analyzing, totalMoments };
  }, [projects]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace"
        title={greeting(user?.displayName)}
        subtitle="Upload a recording, let the AI plan the cinematic cut, then export it cleanly."
        action={
          <div className="flex gap-2">
            <Button href="/dashboard/upload" variant="primary" size="md" leftIcon={<UploadIcon size={14} />}>
              Upload
            </Button>
            {projects.length > 0 && (
              <Button href="/dashboard/projects" variant="ghost" size="md">
                All projects
              </Button>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label="Projects"
          value={projects.length}
          hint={`${totals.ready} ready · ${totals.analyzing} analyzing`}
        />
        <Stat
          label="Detected moments"
          value={totals.totalMoments}
          hint="Across all projects"
          icon={<Sparkles size={11} className="text-violet-300" />}
        />
        <Stat
          label="Status"
          value={projects.length ? "Active" : "Empty"}
          hint={projects.length ? "Workspace healthy" : "Upload to get started"}
        />
      </div>

      {!loaded ? (
        <div className="glass grid place-items-center rounded-2xl p-12 text-sm text-fog">
          Loading projects…
        </div>
      ) : projects.length === 0 ? (
        <EmptyState />
      ) : (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Recent projects</h2>
            <Link
              href="/dashboard/projects"
              className="inline-flex items-center gap-1 text-xs text-fog hover:text-white"
            >
              View all
              <ArrowRight size={11} />
            </Link>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {recent.map((p) => (
              <RealProjectCard key={p.id} project={p} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function greeting(name?: string | null): string {
  const first = name?.split(" ")[0];
  return first ? `Welcome back, ${first}` : "Welcome back";
}

function Stat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: number | string;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="glass rounded-xl p-5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
        {icon}
        {label}
      </div>
      <div className="mt-2 font-display text-2xl font-semibold text-white">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-fog">{hint}</div>}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="glass relative overflow-hidden rounded-2xl p-10 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-48 w-96 -translate-x-1/2 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.18),transparent_60%)] blur-2xl"
      />
      <div className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl border border-violet-400/30 bg-violet-500/10 text-violet-300">
        <Sparkles size={22} />
      </div>
      <h3 className="mt-5 font-display text-xl font-semibold tracking-tight text-white">
        No projects yet
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-fog">
        Upload your first screen recording and AdZoom's AI will plan a cinematic cut for you in seconds.
      </p>
      <div className="mt-6">
        <Button href="/dashboard/upload" variant="primary" size="md" leftIcon={<Plus size={14} />}>
          Upload your first video
        </Button>
      </div>
    </div>
  );
}
