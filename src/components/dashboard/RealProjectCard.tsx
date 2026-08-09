"use client";

import * as React from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { Play, Clock, Sparkles, AlertCircle, Loader2, Trash2, Pencil } from "lucide-react";
import type { ProjectDoc, ProjectStatus } from "@/lib/firebase/schema";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { deleteProject, updateProject } from "@/lib/firebase/projects";
import { usePlatform, isLocalProject } from "@/lib/platform";
import type { ProjectSummary } from "@/lib/platform/types";
import { useToast } from "@/components/ui/Toast";
import { CloudTransferControl } from "@/components/dashboard/CloudTransferControl";
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

export function RealProjectCard({
  project,
  local: localRow,
}: {
  project: ProjectDoc;
  /**
   * The row behind this card in THIS computer's library, when there is one.
   *
   * Only the desktop passes it, and only it can answer the question the cloud
   * controls need: is the video on this disk, or only in the cloud? A
   * `ProjectDoc` is the same shape on the web and cannot say.
   */
  local?: ProjectSummary;
}) {
  const pill = STATUS_PILL[project.status];
  const PillIcon = pill?.icon;
  const aspect =
    project.width && project.height ? project.width / project.height : 16 / 9;
  const isVertical = aspect < 1;
  const moments = project.analysis?.detectedMoments?.length ?? 0;
  const previewURL = project.originalVideoUrl;

  const { user } = useAuth();
  const platform = usePlatform();
  const toast = useToast();
  // A card in the desktop library can be either backend's. The document names
  // its own home (the local sentinel uid vs. a Firebase uid), so rename and
  // delete follow the document rather than the shell — otherwise deleting a
  // local project would issue a Firestore write for an id that isn't there.
  const local = isLocalProject(project);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);

  const askDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirmOpen(true);
  };

  const askRename = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRenameOpen(true);
  };

  const handleConfirm = async () => {
    if (deleting || (!local && !user)) return;
    setDeleting(true);
    try {
      if (local) {
        // Removes the project and its edit history. The user's source video is
        // never touched — the app doesn't own that file.
        await platform.projects.delete?.(project.id);
      } else {
        await deleteProject(user!.uid, project.id, project.storagePath);
      }
      toast.success("Project deleted", project.title);
      setConfirmOpen(false);
    } catch (err) {
      console.error("[delete project]", err);
      toast.error("Couldn't delete project", err instanceof Error ? err.message : undefined);
    } finally {
      setDeleting(false);
    }
  };

  const handleRename = async (next: string) => {
    if (renaming || (!local && !user)) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === project.title) {
      setRenameOpen(false);
      return;
    }
    setRenaming(true);
    try {
      if (local) {
        await platform.projects.write(project.id, { title: trimmed });
      } else {
        await updateProject(user!.uid, project.id, { title: trimmed });
      }
      toast.success("Project renamed", trimmed);
      setRenameOpen(false);
    } catch (err) {
      console.error("[rename project]", err);
      toast.error("Couldn't rename project", err instanceof Error ? err.message : undefined);
    } finally {
      setRenaming(false);
    }
  };

  return (
    <div className="group glass relative overflow-hidden rounded-xl transition-colors duration-200 hover:border-white/[0.12]">
      <Link
        href={`/dashboard/projects/${project.id}`}
        aria-label={`Open ${project.title}`}
        className="absolute inset-0 z-10 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/50"
      />
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
          />
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
      <div className="flex items-start gap-2 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-white">{project.title}</h3>
          <div className="mt-1 flex items-center gap-3 text-[11px] text-fog">
            <span className="inline-flex items-center gap-1">
              <Clock size={10} />
              {fmtDuration(project.duration)}
            </span>
            <span>·</span>
            <span>Edited {relativeTime(project.updatedAt)}</span>
          </div>
          {/* Only for projects this computer actually has a row for. A pure
              cloud project on the desktop has nothing local to move, and on the
              web the control renders nothing at all. */}
          {localRow && (
            <div className="mt-2.5">
              <CloudTransferControl
                projectId={localRow.id}
                cloudOnly={Boolean(localRow.cloudOnly)}
                // Neither direction is possible: no file here and nothing in
                // the cloud to fetch.
                disabled={Boolean(localRow.mediaMissing)}
                onNotice={(message) => toast.info(message)}
              />
            </div>
          )}
        </div>
        <div className="-mt-1 flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={askRename}
            aria-label="Rename project"
            title="Rename"
            className="relative z-20 inline-flex size-8 items-center justify-center rounded-md text-fog opacity-0 transition-all duration-150 hover:bg-white/[0.06] hover:text-white focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-400/40 group-hover:opacity-100"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={askDelete}
            aria-label="Delete project"
            title="Delete"
            className="relative z-20 -mr-1.5 inline-flex size-8 items-center justify-center rounded-md text-fog opacity-0 transition-all duration-150 hover:bg-rose-500/15 hover:text-rose-300 focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-rose-400/40 group-hover:opacity-100"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {confirmOpen && (
        <DeleteConfirmModal
          title={project.title}
          deleting={deleting}
          onCancel={() => {
            if (!deleting) setConfirmOpen(false);
          }}
          onConfirm={() => {
            void handleConfirm();
          }}
        />
      )}

      {renameOpen && (
        <RenameProjectModal
          initialTitle={project.title}
          saving={renaming}
          onCancel={() => {
            if (!renaming) setRenameOpen(false);
          }}
          onSubmit={(next) => {
            void handleRename(next);
          }}
        />
      )}
    </div>
  );
}

function DeleteConfirmModal({
  title,
  deleting,
  onCancel,
  onConfirm,
}: {
  title: string;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deleting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleting, onCancel]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={() => {
        if (!deleting) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="glass w-full max-w-sm rounded-2xl border border-white/10 bg-surface/95 p-5 shadow-cinematic"
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-rose-400/30 bg-rose-500/15 text-rose-300">
            <Trash2 size={16} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white">Delete this project?</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-fog">
              <span className="truncate text-white/80">&ldquo;{title}&rdquo;</span> and its original
              recording will be permanently removed. This can&rsquo;t be undone.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-white/[0.07] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-400/30 bg-rose-500/20 px-3 py-1.5 text-xs font-medium text-rose-100 transition-colors duration-150 hover:bg-rose-500/30 disabled:opacity-60"
          >
            {deleting && <Loader2 size={11} className="animate-spin" />}
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function RenameProjectModal({
  initialTitle,
  saving,
  onCancel,
  onSubmit,
}: {
  initialTitle: string;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (next: string) => void;
}) {
  const [mounted, setMounted] = React.useState(false);
  const [value, setValue] = React.useState(initialTitle);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => setMounted(true), []);

  React.useEffect(() => {
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onCancel]);

  if (!mounted) return null;

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== initialTitle;

  const submit = () => {
    if (!canSave || saving) return;
    onSubmit(trimmed);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={() => {
        if (!saving) onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="glass w-full max-w-sm rounded-2xl border border-white/10 bg-surface/95 p-5 shadow-cinematic"
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-violet-400/30 bg-violet-500/15 text-violet-300">
            <Pencil size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-white">Rename project</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-fog">
              Give this recording a new title.
            </p>
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={saving}
              maxLength={120}
              placeholder="Project title"
              className="mt-3 h-9 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-white placeholder:text-fog/70 outline-none transition-colors duration-150 focus:border-violet-400/40 disabled:opacity-60"
            />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-white/[0.07] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave || saving}
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/30 bg-violet-500/25 px-3 py-1.5 text-xs font-medium text-violet-50 transition-colors duration-150 hover:bg-violet-500/35 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Loader2 size={11} className="animate-spin" />}
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
