import { Play, Clock } from "lucide-react";
import type { Project } from "@/lib/types";
import { StatusPill } from "@/components/ui/StatusPill";
import { ProjectThumb } from "./ProjectThumb";

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ProjectCard({ project }: { project: Project }) {
  return (
    <article className="group glass overflow-hidden rounded-xl transition-colors duration-200 hover:border-white/[0.12]">
      <div className="relative aspect-[16/10] overflow-hidden border-b border-white/[0.06]">
        <ProjectThumb project={project} />
        <span className="pointer-events-none absolute right-2 top-2">
          <StatusPill status={project.status} />
        </span>
        <button
          aria-label={`Open ${project.title}`}
          className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        >
          <span className="inline-flex size-11 items-center justify-center rounded-full bg-white/95 text-ink shadow-cinematic backdrop-blur-md">
            <Play size={16} className="fill-ink" />
          </span>
        </button>
      </div>
      <div className="px-4 py-3.5">
        <h3 className="truncate text-sm font-medium text-white">{project.title}</h3>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-fog">
          <span className="inline-flex items-center gap-1">
            <Clock size={10} />
            {fmt(project.durationSec)}
          </span>
          <span>·</span>
          <span>Edited {project.editedAt}</span>
        </div>
      </div>
    </article>
  );
}
