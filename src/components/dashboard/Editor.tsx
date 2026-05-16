"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { EditorProvider } from "./editor-state";
import { VideoPlayer } from "./VideoPlayer";
import { TimelineTrack } from "./TimelineTrack";
import { EffectsPanel } from "./EffectsPanel";
import { PresetsRow } from "./PresetsRow";
import { ExportPanel } from "./ExportPanel";
import { ProcessingOverlay } from "./ProcessingOverlay";
import { ProjectCard } from "./ProjectCard";
import { projects } from "@/lib/mockData";

export function Editor() {
  const recent = projects.slice(0, 3);

  return (
    <EditorProvider>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-fog">
              <span className="size-1.5 rounded-full bg-violet-400" />
              Editor
            </div>
            <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              Linear walkthrough — v2
            </h1>
            <p className="mt-1 text-sm text-fog">
              AI detected 5 zoom regions and 12 click events.
            </p>
          </div>
          <Link
            href="/dashboard/projects"
            className="inline-flex items-center gap-1.5 text-sm text-fog transition-colors duration-200 hover:text-white"
          >
            All projects
            <ArrowRight size={14} />
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_360px]">
          {/* Left: player + timeline + presets + recent */}
          <div className="space-y-5">
            <VideoPlayer />
            <TimelineTrack />
            <PresetsRow />

            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">Recent projects</h2>
                <Link
                  href="/dashboard/projects"
                  className="text-xs text-fog hover:text-white"
                >
                  View all
                </Link>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {recent.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            </div>
          </div>

          {/* Right: effects + export */}
          <div className="space-y-5 xl:sticky xl:top-24 xl:self-start">
            <EffectsPanel />
            <ExportPanel />
          </div>
        </div>
      </div>

      <ProcessingOverlay />
    </EditorProvider>
  );
}
