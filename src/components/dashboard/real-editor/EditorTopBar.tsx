"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Menu,
  Pencil,
  Undo2,
  Redo2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { updateProject } from "@/lib/firebase/projects";
import { useToast } from "@/components/ui/Toast";
import { Logo } from "@/components/landing/Logo";
import { Button } from "@/components/ui/Button";
import { useEditorReal } from "./context";

/**
 * Compact editor-specific top bar for the fullscreen editing workspace —
 * replaces the dashboard Topbar (search / record / notifications stay out of
 * the editor; they're reachable through the nav drawer). Left: menu + logo +
 * back + editable title + status. Right: undo/redo + the single primary
 * Export action.
 */
export function EditorTopBar({
  onOpenNav,
  onExport,
}: {
  onOpenNav: () => void;
  onExport: () => void;
}) {
  const { project, uid, undo, redo, canUndo, canRedo } = useEditorReal();
  const hasAnalysis = (project.analysis?.detectedMoments?.length ?? 0) > 0;

  return (
    // Sticky: the page scrolls vertically (natural-height timeline below),
    // but the editor header must stay visible while editing. z-[60] sits
    // above every in-page layer (player controls z-50, pill toolbars z-50)
    // and below the overlay drawers/dialogs (z-118+).
    <header className="sticky top-0 z-[60] flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-surface/80 px-3 backdrop-blur-xl sm:gap-3 sm:px-4">
      {/* Menu — opens the Framevo navigation drawer over the editor. */}
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open Framevo navigation"
        title="Menu"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-fog transition-colors duration-150 hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
      >
        <Menu size={16} />
      </button>

      <Link href="/" aria-label="Framevo home" className="hidden shrink-0 sm:block">
        <Logo />
      </Link>

      <Link
        href="/dashboard/projects"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-fog transition-colors duration-200 hover:bg-white/[0.03] hover:text-white"
      >
        <ArrowLeft size={13} />
        <span className="hidden md:inline">Projects</span>
      </Link>

      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <EditableProjectTitle uid={uid} projectId={project.id} title={project.title} />
        <StatusBadge status={headerStatus(project, hasAnalysis)} />
      </div>

      {/* Undo / redo — the same session history the timeline shortcuts drive. */}
      <div className="hidden shrink-0 items-center gap-1 sm:flex">
        <TopBarIconButton
          label="Undo"
          hint="⌘Z"
          disabled={!canUndo}
          onClick={() => void undo()}
        >
          <Undo2 size={15} />
        </TopBarIconButton>
        <TopBarIconButton
          label="Redo"
          hint="⌘⇧Z"
          disabled={!canRedo}
          onClick={() => void redo()}
        >
          <Redo2 size={15} />
        </TopBarIconButton>
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

function TopBarIconButton({
  label,
  hint,
  disabled,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={hint ? `${label} (${hint})` : label}
      className="inline-flex size-9 items-center justify-center rounded-lg text-fog transition-colors duration-150 hover:bg-white/[0.04] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
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
 * heading, so renaming happens in place. Enter / blur commits via
 * `updateProject`; Escape reverts. The realtime `subscribeProject` listener
 * pushes the saved title back down as `project.title`.
 */
export function EditableProjectTitle({
  uid,
  projectId,
  title,
}: {
  uid: string;
  projectId: string;
  title: string;
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
      await updateProject(uid, projectId, { title: trimmed });
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
  }, [value, title, uid, projectId, toast]);

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
