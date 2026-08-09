"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Menu, Pencil, Upload } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { isCloudOnlyVideo, serverTimestamp, usePlatform, type DocPatch } from "@/lib/platform";
import { useToast } from "@/components/ui/Toast";
import { Logo } from "@/components/landing/Logo";
import { Button } from "@/components/ui/Button";
import { CloudTransferControl } from "@/components/dashboard/CloudTransferControl";
import { SyncStatusBadge } from "@/components/dashboard/SyncStatusBadge";
import { useProjectSyncStatus, useSync } from "@/components/desktop/SyncProvider";
import { useNavShell } from "@/components/dashboard/nav-shell";
import { useEditorReal } from "./context";

/**
 * Compact editor-specific top bar for the fullscreen editing workspace —
 * replaces the dashboard Topbar (search / record / notifications stay out of
 * the editor). Left: back + editable title + status. Right: the single primary
 * Export action. Undo/redo live in the timeline control bar, next to the edits
 * they affect.
 *
 * Framevo's navigation is the shell's fixed rail immediately to the left of
 * this bar, so the logo and the menu button here are the BELOW-`lg` fallback
 * only — that is the one width at which the rail collapses into a drawer.
 */
export function EditorTopBar({
  onExport,
  onReviewConflict,
}: {
  onExport: () => void;
  /** Open the conflict resolution sheet. Absent on shells without sync. */
  onReviewConflict?: (projectId: string) => void;
}) {
  const { project, writeProject } = useEditorReal();
  const platform = usePlatform();
  const toast = useToast();
  const sync = useSync();
  const syncStatus = useProjectSyncStatus(project.id);
  const navShell = useNavShell();
  const hasAnalysis = (project.analysis?.detectedMoments?.length ?? 0) > 0;

  return (
    // Sticky: the page scrolls vertically (natural-height timeline below),
    // but the editor header must stay visible while editing. z-[60] sits
    // above every in-page layer (player controls z-50, pill toolbars z-50)
    // and below the overlay drawers/dialogs (z-118+).
    <header className="sticky top-0 z-[60] flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-surface/80 px-3 backdrop-blur-xl sm:gap-3 sm:px-4">
      {/* Menu + logo — hidden from `lg` up, where the shell's rail is showing
          both a couple of pixels to the left. Rendered only when a shell is
          actually around us: a menu button that opens nothing is worse than no
          menu button. */}
      {navShell && (
        <>
          <button
            type="button"
            onClick={navShell.openNav}
            aria-label="Open Framevo navigation"
            title="Menu"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-fog transition-colors duration-150 hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 lg:hidden"
          >
            <Menu size={16} />
          </button>

          <Link
            href={navShell.homeHref}
            aria-label="Framevo home"
            className="hidden shrink-0 sm:block lg:hidden"
          >
            <Logo />
          </Link>
        </>
      )}

      {/* The website routes to /dashboard/projects; the desktop shell switches
          screens through the URL hash. The platform owns that difference. */}
      <Link
        href={platform.libraryHref}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-fog transition-colors duration-200 hover:bg-white/[0.03] hover:text-white"
      >
        <ArrowLeft size={13} />
        <span className="hidden md:inline">Projects</span>
      </Link>

      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <EditableProjectTitle title={project.title} writeProject={writeProject} />
        <StatusBadge status={headerStatus(project, hasAnalysis)} />
        {/* Sync sits NEXT TO the analysis status, not merged into it: one is
            about what the AI did to this video, the other about where the file
            lives. Collapsing them would make "Exported" and "Sync failed"
            compete for the same slot. Hidden while up to date — a permanent
            green tick teaches people to stop reading it. */}
        <SyncStatusBadge
          status={syncStatus}
          hideWhenSynced
          onRetry={(id: string) => void sync.retry(id)}
          onReview={onReviewConflict}
        />
        {/* And the OTHER half of "where does this live": the recording itself.
            The badge above is about the timeline, which syncs unasked; this is
            about gigabytes, which move only when the user says so. */}
        {/* Shown at EVERY width. It was hidden below `lg`, which took the only
            way to bring a cloud project's video onto this computer off the
            screen exactly when the window was small — and a narrow window is
            not a reason to make a feature unreachable. `shrink-0` keeps it
            whole; the title beside it truncates instead. Its compact labels
            ("Download", "Save to cloud") are short enough to sit in an h-14
            bar without crowding. */}
        <CloudTransferControl
          projectId={project.id}
          cloudOnly={isCloudOnlyVideo(project)}
          className="shrink-0"
          onNotice={(message) => toast.info(message)}
        />
      </div>

      <Button
        onClick={onExport}
        variant="primary"
        size="sm"
        leftIcon={<Upload size={14} />}
        className="shrink-0"
      >
        Export
      </Button>
    </header>
  );
}

/* ── Status pill ──────────────────────────────────────────────────────────── */

type HeaderStatus = {
  label: string;
  dotClass: string;
  textClass: string;
  /** Animate the dot while work is in flight. */
  pulse?: boolean;
};

export function headerStatus(p: ProjectDoc, hasAnalysis: boolean): HeaderStatus {
  switch (p.status) {
    case "analyzing":
      return { label: "Analyzing", dotClass: "bg-amber-400", textClass: "text-amber-200/90", pulse: true };
    case "uploading":
      return { label: "Uploading", dotClass: "bg-sky-400", textClass: "text-sky-200/90", pulse: true };
    case "failed":
      return { label: "Needs attention", dotClass: "bg-rose-400", textClass: "text-rose-200/90" };
    case "exported":
      return { label: "Exported", dotClass: "bg-emerald-400", textClass: "text-emerald-200/90" };
    default:
      return hasAnalysis
        ? { label: "Draft", dotClass: "bg-violet-400", textClass: "text-violet-200/90" }
        : { label: "New", dotClass: "bg-white/40", textClass: "text-fog" };
  }
}

export function StatusBadge({ status }: { status: HeaderStatus }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.02] px-2 py-0.5 text-[11px] font-medium">
      <span className="relative flex size-1.5">
        {status.pulse && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
              status.dotClass
            )}
          />
        )}
        <span className={cn("relative inline-flex size-1.5 rounded-full", status.dotClass)} />
      </span>
      <span className={status.textClass}>{status.label}</span>
    </span>
  );
}

/* ── Inline-editable project title ────────────────────────────────────────── */

/**
 * Inline-editable project title. Renders as a heading-styled button; clicking
 * it (or its pencil affordance) swaps in an input that visually matches the
 * heading, so renaming happens in place. Enter / blur commits through the
 * editor's platform writer (Firestore on the web, the local library on the
 * desktop); Escape reverts. The realtime document subscription pushes the saved
 * title back down as `project.title`.
 */
export function EditableProjectTitle({
  title,
  writeProject,
}: {
  title: string;
  /** Backend-agnostic writer from the editor context (cloud or local). */
  writeProject: (patch: DocPatch) => Promise<void>;
}) {
  const toast = useToast();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(title);
  const [saving, setSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Keep the field in sync when the title changes elsewhere (other tab,
  // realtime update) and we're not mid-edit.
  React.useEffect(() => {
    if (!editing) setValue(title);
  }, [title, editing]);

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = React.useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === title) {
      setValue(title);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await writeProject({ title: trimmed, updatedAt: serverTimestamp() });
      setEditing(false);
    } catch (err) {
      toast.error(
        "Couldn't rename project",
        err instanceof Error ? err.message : undefined
      );
      setValue(title);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [value, title, writeProject, toast]);

  // Compact type scale — this now lives in the h-14 editor top bar.
  const titleType =
    "font-display text-[15px] font-semibold leading-tight tracking-tight text-white";

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        disabled={saving}
        maxLength={120}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setValue(title);
            setEditing(false);
          }
        }}
        aria-label="Project title"
        className={cn(
          titleType,
          "-mx-2 w-full max-w-sm rounded-lg border border-violet-400/40 bg-white/[0.03] px-2 py-1 outline-none transition-colors duration-150 focus:border-violet-400/70 disabled:opacity-60"
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Rename project"
      className="group/title -mx-2 inline-flex min-w-0 max-w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors duration-150 hover:bg-white/[0.03] focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-400/40"
    >
      <span className={cn(titleType, "truncate")}>{title}</span>
      <Pencil
        size={12}
        className="shrink-0 text-fog opacity-0 transition-opacity duration-150 group-hover/title:opacity-100"
      />
    </button>
  );
}
