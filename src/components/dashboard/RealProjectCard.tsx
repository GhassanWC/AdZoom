"use client";

import Link from "next/link";
import { Play, Clock, Sparkles, AlertCircle, Loader2 } from "lucide-react";
import type { ProjectDoc, ProjectStatus } from "@/lib/firebase/schema";
import { cn } from "@/lib/cn";

function fmtDuration(sec?: number) {
  if (!sec || !Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function relativeTime(ms?: number) {
  if (!ms) return "just now";
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / (7 * 86400))}w ago`;
}

const STATUS_PILL: Record<ProjectStatus, { label: string; tone: string; icon?: typeof Sparkles }> = {
  uploading: { label: "Uploading", tone: "violet", icon: Loader2 },
  uploaded: { label: "Ready", tone: "fog" },
  scanning_frames: { label: "Scanning", tone: "violet", icon: Loader2 },
  preparing: { label: "Preparing", tone: "violet", icon: Loader2 },
  uploading_to_gemini: { label: "Uploading", tone: "violet", icon: Loader2 },
  extracting_frames: { label: "Extracting", tone: "violet", icon: Loader2 },
  analyzing: { label: "Analyzing", tone: "violet", icon: Loader2 },
  generating_timeline: { label: "Building", tone: "violet", icon: Loader2 },
  generating_presets: { label: "Generating", tone: "violet", icon: Loader2 },
  analyzed: { label: "Analyzed", tone: "emerald", icon: Sparkles },
  completed: { label: "Analyzed", tone: "emerald", icon: Sparkles },
  exporting: { label: "Exporting", tone: "violet", icon: Loader2 },
  exported: { label: "Exported", tone: "emerald" },
  cancelled: { label: "Cancelled", tone: "fog" },
  failed: { label: "Failed", tone: "rose", icon: AlertCircle },
};

const TONE_CLASS: Record<string, string> = {
  violet: "border-violet-400/30 bg-violet-500/10 text-violet-200",
  emerald: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  rose: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  fog: "border-white/10 bg-white/[0.03] text-fog",
};

export function RealProjectCard({ project }: { project: ProjectDoc }) {
  const pill = STATUS_PILL[project.status];
  const PillIcon = pill?.icon;
  const aspect =
    project.width && project.height ? project.width / project.height : 16 / 9;
  const isVertical = aspect < 1;
  const moments = project.analysis?.detectedMoments?.length ?? 0;
  const previewURL = project.originalVideoUrl;

  return (
    <Link
      href={`/dashboard/projects/${project.id}`}
      className="group glass block overflow-hidden rounded-xl transition-colors duration-200 hover:border-white/[0.12]"
    >
      <div className="relative aspect-[16/10] overflow-hidden border-b border-white/[0.06] bg-black">
        {previewURL ? (
          <video
            src={previewURL}
            muted
            playsInline
            preload="metadata"
            className={cn(
              "absolute inset-0",
              isVertical ? "h-full w-full object-contain" : "h-full w-full object-cover"
            )}
            crossOrigin="anonymous"
          >
            <track kind="captions" />
          </video>
        ) : (
          <div className="absolute inset-0 grid place-items-center text-xs text-fog">
            No preview
          </div>
        )}

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />

        <span
          className={cn(
            "absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            TONE_CLASS[pill.tone]
          )}
        >
          {PillIcon && <PillIcon size={10} className={pill.icon === Loader2 ? "animate-spin" : ""} />}
          {pill.label}
        </span>

        {moments > 0 && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-200">
            <Sparkles size={9} />
            {moments} moments
          </span>
        )}

        <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="inline-flex size-11 items-center justify-center rounded-full bg-white/95 text-ink shadow-cinematic backdrop-blur-md">
            <Play size={16} className="fill-ink" />
          </span>
        </span>
      </div>
      <div className="px-4 py-3.5">
        <h3 className="truncate text-sm font-medium text-white">{project.title}</h3>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-fog">
          <span className="inline-flex items-center gap-1">
            <Clock size={10} />
            {fmtDuration(project.duration)}
          </span>
          <span>·</span>
          <span>Edited {relativeTime(project.updatedAt)}</span>
        </div>
      </div>
    </Link>
  );
}
