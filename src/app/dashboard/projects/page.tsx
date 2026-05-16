"use client";

import * as React from "react";
import { Plus, Search, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeProjects } from "@/lib/firebase/projects";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { RealProjectCard } from "@/components/dashboard/RealProjectCard";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

const filters = ["All", "Ready", "Processing", "Draft"] as const;

const PROCESSING: ProjectDoc["status"][] = [
  "uploading",
  "preparing",
  "uploading_to_gemini",
  "extracting_frames",
  "analyzing",
  "generating_timeline",
  "generating_presets",
  "exporting",
];
const READY: ProjectDoc["status"][] = ["analyzed", "completed", "exported"];
const DRAFT: ProjectDoc["status"][] = ["uploaded", "failed", "cancelled"];

function matchesFilter(p: ProjectDoc, f: (typeof filters)[number]) {
  if (f === "All") return true;
  if (f === "Processing") return PROCESSING.includes(p.status);
  if (f === "Ready") return READY.includes(p.status);
  if (f === "Draft") return DRAFT.includes(p.status);
  return true;
}

export default function ProjectsPage() {
  const { user } = useAuth();
  const [projects, setProjects] = React.useState<ProjectDoc[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [filter, setFilter] = React.useState<(typeof filters)[number]>("All");
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    if (!user) return;
    setLoaded(false);
    const unsub = subscribeProjects(user.uid, (list) => {
      setProjects(list);
      setLoaded(true);
    });
    return () => unsub();
  }, [user]);

  const filtered = projects.filter((p) => {
    if (!matchesFilter(p, filter)) return false;
    if (q && !p.title.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Projects"
        title="Your library"
        subtitle={`${projects.length} ${projects.length === 1 ? "recording" : "recordings"} in your workspace.`}
        action={
          <Button href="/dashboard/upload" variant="primary" size="md" leftIcon={<Plus size={14} />}>
            New project
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fog"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects"
            className="h-9 w-full rounded-lg border border-white/10 bg-white/[0.02] pl-9 pr-3 text-sm text-white placeholder:text-fog/70 outline-none transition-colors duration-200 focus:border-white/20"
          />
        </div>
        <div className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
          {filters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150",
                filter === f
                  ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/30"
                  : "text-fog hover:bg-white/[0.04] hover:text-white"
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {!loaded ? (
        <div className="glass grid place-items-center rounded-2xl p-12 text-sm text-fog">
          <Loader2 size={14} className="mr-2 inline animate-spin text-violet-300" />
          Loading projects…
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center text-sm text-fog">
          {projects.length === 0 ? (
            <>
              <p>No projects yet.</p>
              <div className="mt-4">
                <Button href="/dashboard/upload" variant="primary" size="sm">
                  Upload your first video
                </Button>
              </div>
            </>
          ) : (
            "No projects match those filters."
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <RealProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}
