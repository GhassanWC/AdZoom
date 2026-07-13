"use client";

import * as React from "react";
import {
  Scissors,
  Loader2,
  RefreshCw,
  Play,
  Upload,
  Sparkles,
  Clock,
  Check,
  Pencil,
  Trash2,
  GitMerge,
  Download,
  AlertTriangle,
  Crop as CropIcon,
  Type as TypeIcon,
} from "lucide-react";
import { useEditorReal } from "./context";
import { CLIP_TYPE_META } from "@/lib/clips/clip-generator";
import { CLIP_STATUS_LABEL } from "@/lib/clips/clip-export-status";
import {
  clipsButtonDisabled,
  clipsButtonLabel,
  clipsNeedsRegenerateConfirm,
  clipsShowEmptyState,
  clipsShowRetry,
  clipsSignalNote,
  clipsStatus,
  clipsUnrenderableNote,
  type ClipsPanelInput,
} from "./clips-panel-state";
import type { GeneratedClip, ClipType, ClipExportStatus } from "@/lib/firebase/schema";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

const ACCENT_CLASSES: Record<string, string> = {
  violet: "border-violet-400/30 bg-violet-500/12 text-violet-100",
  sky: "border-sky-400/30 bg-sky-500/12 text-sky-100",
  amber: "border-amber-400/30 bg-amber-500/12 text-amber-100",
  rose: "border-rose-400/30 bg-rose-500/12 text-rose-100",
  emerald: "border-emerald-400/30 bg-emerald-500/12 text-emerald-100",
  cyan: "border-cyan-400/30 bg-cyan-500/12 text-cyan-100",
  orange: "border-orange-400/30 bg-orange-500/12 text-orange-100",
  teal: "border-teal-400/30 bg-teal-500/12 text-teal-100",
  lime: "border-lime-400/30 bg-lime-500/12 text-lime-100",
  pink: "border-pink-400/30 bg-pink-500/12 text-pink-100",
};

const STATUS_CLASSES: Record<ClipExportStatus, string> = {
  idle: "border-white/10 bg-white/[0.03] text-fog",
  queued: "border-violet-400/30 bg-violet-500/12 text-violet-100",
  rendering: "border-violet-400/30 bg-violet-500/12 text-violet-100",
  completed: "border-emerald-400/30 bg-emerald-500/12 text-emerald-100",
  failed: "border-rose-400/30 bg-rose-500/12 text-rose-100",
};

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** "bold_social" → "Bold social" — the suggested edit style, human-readable. */
function styleLabel(s: string): string {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Docked "Clips" panel — the AI-suggested short clips cut from this source.
 * Each is a lightweight [start,end] window over the original (no media
 * duplicated) that carries its OWN smart edits: hook text, caption style,
 * aspect, emphasis zoom, CTA. Opening one previews those edits; exporting one
 * renders them. The main timeline is never touched unless the user explicitly
 * runs "Apply edits to timeline".
 */
export function ClipsPanel() {
  const {
    project,
    clips,
    clipsStoredCount,
    clipsDropped,
    clipsGenerating,
    clipsLastRun,
    generateClips,
    regenerateClip,
    renameClip,
    deleteClip,
    openClip,
    requestClipExport,
    applyClipToTimeline,
    setActiveTool,
    openExportModal,
    focusedClipId,
  } = useEditorReal();
  const confirm = useConfirm();
  const toast = useToast();

  const analysisComplete = project.analysis?.status === "complete";
  const hasClips = clips.length > 0;

  // ONE source of truth: `clips` is the rendered list, and every number the
  // panel says is derived from it.
  const panel: ClipsPanelInput = {
    running: clipsGenerating,
    clipCount: clips.length,
    storedCount: clipsStoredCount,
    lastRun: clipsLastRun,
    analysisComplete,
  };
  const status = clipsStatus(panel);
  const showEmpty = clipsShowEmptyState(panel);
  const unrenderableNote = clipsUnrenderableNote(
    panel,
    clipsDropped.map((d) => d.reason)
  );
  const signalNote = clipsSignalNote({
    analysisComplete,
    transcriptAvailable: (project.analysis?.transcript?.segments?.length ?? 0) > 0,
    clipCount: clips.length,
  });

  // Saved vs rendered, every time the list changes — the tripwire for a "the
  // count says 3 but I see 0" report.
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    console.debug("[clips] render", {
      savedCount: clipsStoredCount,
      renderedCount: clips.length,
      filteredOutCount: clipsDropped.length,
      filterReasons: clipsDropped.map((d) => `${d.id}: ${d.reason}`),
      lastRunStatus: clipsLastRun?.status ?? null,
      lastRunCount: clipsLastRun?.count ?? null,
    });
  }, [clipsStoredCount, clips.length, clipsDropped, clipsLastRun]);

  // Convenience only — clips appear on their own the first time analysis lands.
  // The button below is the REAL path: generation is never hidden behind this.
  const autoTriedRef = React.useRef(false);
  React.useEffect(() => {
    if (autoTriedRef.current) return;
    if (analysisComplete && !hasClips && !clipsGenerating) {
      autoTriedRef.current = true;
      void generateClips({ mode: "generate", trigger: "auto" });
    }
  }, [analysisComplete, hasClips, clipsGenerating, generateClips]);

  /** The one primary action: generate, or regenerate over an existing set. */
  const onGenerate = async () => {
    const regenerating = clipsNeedsRegenerateConfirm(panel);
    if (regenerating) {
      const ok = await confirm({
        title: "Regenerate all clips?",
        message:
          "The current suggestions are replaced with a fresh set from the latest analysis. Clips you already exported keep their download when a new clip covers the same moment.",
        confirmLabel: "Regenerate clips",
      });
      if (!ok) return;
    }

    const res = await generateClips({
      mode: regenerating ? "regenerate" : "generate",
      trigger: "user",
    });

    if (res.status === "generated") {
      toast.success(
        "Clips",
        res.fallbackUsed
          ? res.message
          : `Generated ${res.count} smart clip${res.count === 1 ? "" : "s"}`
      );
    } else if (res.status === "failed") {
      toast.error("Clips", "Clip generation failed. Try again.");
    } else if (res.status === "empty") {
      toast.error("Clips", res.message);
    }
  };

  const onApplyToTimeline = async (clip: GeneratedClip) => {
    const ok = await confirm({
      title: "Apply this clip's edits to the full timeline?",
      message:
        "The clip's hook text, caption style, emphasis zoom and framing will be added to your MAIN timeline as real, undoable edits. The clip itself stays available. You can undo this.",
      confirmLabel: "Apply to timeline",
    });
    if (!ok) return;
    try {
      await applyClipToTimeline(clip);
      toast.success("Clips", "Clip edits applied to the full timeline.");
    } catch (err) {
      toast.error("Clips", err instanceof Error ? err.message : "Could not apply the edits.");
    }
  };

  const onDelete = async (clip: GeneratedClip) => {
    const ok = await confirm({
      title: "Delete this clip?",
      message: "The suggestion is removed. Your video and timeline are untouched.",
      confirmLabel: "Delete clip",
      tone: "danger",
    });
    if (!ok) return;
    await deleteClip(clip.id);
  };

  const label = clipsButtonLabel(panel);
  const disabled = clipsButtonDisabled(panel);
  const showRetry = clipsShowRetry(panel);

  return (
    <div className="flex h-full flex-col">
      {/* Status + the one primary action — always visible, never auto-run-only. */}
      <div className="shrink-0 space-y-2.5 border-b border-white/[0.06] px-4 py-3">
        <p
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-[11.5px] leading-relaxed",
            status.tone === "success" && "text-emerald-200/90",
            status.tone === "error" && "text-rose-200/90",
            status.tone === "info" && "text-fog"
          )}
          aria-live="polite"
        >
          {clipsGenerating && <Loader2 size={12} className="shrink-0 animate-spin" />}
          {status.tone === "error" && !clipsGenerating && (
            <AlertTriangle size={12} className="shrink-0" />
          )}
          {status.text}
        </p>

        <Button
          variant="primary"
          size="sm"
          className="w-full justify-center"
          onClick={() => void onGenerate()}
          disabled={disabled}
          leftIcon={
            clipsGenerating ? (
              <Loader2 size={13} className="animate-spin" />
            ) : showRetry ? (
              <RefreshCw size={13} />
            ) : hasClips ? (
              <RefreshCw size={13} />
            ) : (
              <Sparkles size={13} />
            )
          }
        >
          {label}
        </Button>

        {/* The raw failure, for when "it failed" isn't enough to act on. */}
        {showRetry && clipsLastRun?.error && (
          <p className="text-[11px] leading-relaxed text-fog">{clipsLastRun.error}</p>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {/* Analysis is the one hard prerequisite — say so instead of spinning. */}
        {!analysisComplete && !clipsGenerating && (
          <EmptyNote
            Icon={Sparkles}
            title="Analyze video first"
            body="Run the AI analysis (top of the tool rail) and Framevo will cut short clips from the strongest moments."
          />
        )}

        {clipsGenerating && !hasClips && (
          <div className="flex items-center gap-2 text-[12px] text-fog">
            <Loader2 size={14} className="animate-spin" /> Finding the best moments…
          </div>
        )}

        {/*
          The empty state fires ONLY when nothing is rendered AND nothing is
          saved (clipsShowEmptyState). Clips that are saved but unrenderable get
          the note below instead — a "no clips" message must never appear above a
          header that says clips exist.
        */}
        {analysisComplete && showEmpty && clipsLastRun && (
          <EmptyNote
            Icon={clipsLastRun.status === "failed" ? AlertTriangle : Scissors}
            title={
              clipsLastRun.status === "failed" ? "Clip generation failed" : "No clips generated"
            }
            body={
              clipsLastRun.status === "failed"
                ? "Something went wrong while generating. Nothing was changed — try again."
                : clipsLastRun.message
            }
          />
        )}

        {/* Nothing is ever filtered out of the panel without saying so. */}
        {unrenderableNote && (
          <p className="rounded-lg border border-rose-400/25 bg-rose-500/[0.08] px-3 py-2 text-[11px] leading-relaxed text-rose-200/90">
            {unrenderableNote}
          </p>
        )}

        {signalNote && (
          <p className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[11px] leading-relaxed text-fog">
            {signalNote}
          </p>
        )}

        {clips.map((clip, i) => (
          <ClipCard
            key={clip.id}
            clip={clip}
            index={i}
            focused={focusedClipId === clip.id}
            busy={clipsGenerating}
            onOpen={() => {
              openClip(clip.id);
              setActiveTool(null); // reveal the timeline + focused preview
            }}
            onExport={() => requestClipExport(clip)}
            onApply={() => void onApplyToTimeline(clip)}
            onRename={(title) => void renameClip(clip.id, title)}
            onDelete={() => void onDelete(clip)}
            onRegenerate={() => void regenerateClip(clip.id)}
          />
        ))}
      </div>

      <div className="shrink-0 border-t border-white/[0.06] p-3">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-center"
          onClick={openExportModal}
          leftIcon={<Upload size={13} />}
        >
          Export full edited video
        </Button>
      </div>
    </div>
  );
}

function ClipCard({
  clip,
  index,
  focused,
  busy,
  onOpen,
  onExport,
  onApply,
  onRename,
  onDelete,
  onRegenerate,
}: {
  clip: GeneratedClip;
  /** Position in the list — drives the entrance stagger. */
  index: number;
  focused: boolean;
  busy: boolean;
  onOpen: () => void;
  onExport: () => void;
  onApply: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onRegenerate: () => void;
}) {
  // Belt and braces: `clips` is normalized upstream (clip-render.ts), but the
  // card must never be the thing that takes the panel down — an unknown clipType
  // used to index to `undefined` here and throw on `meta.accent`, which the user
  // sees as "my clips disappeared".
  const meta = CLIP_TYPE_META[clip.clipType as ClipType] ?? CLIP_TYPE_META.best_hook;
  const accent = ACCENT_CLASSES[meta.accent] ?? ACCENT_CLASSES.violet;
  const scorePct = Math.round((Number.isFinite(clip.score) ? clip.score : 0) * 100);
  const ops = clip.editOperations ?? [];
  const exporting = clip.exportStatus === "queued" || clip.exportStatus === "rendering";

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(clip.title);
  React.useEffect(() => setDraft(clip.title), [clip.title]);

  const commitRename = () => {
    setEditing(false);
    const clean = draft.trim();
    if (clean && clean !== clip.title) onRename(clean);
    else setDraft(clip.title);
  };

  return (
    <div
      // Cards cascade in after a generation run — the one moment in the editor
      // that genuinely warrants a flourish, because the user just asked for
      // something and these ARE the answer. Stagger is capped at 5 slots (200ms
      // total) so a long list never feels like it's queueing up.
      style={{ "--fv-stagger": `${Math.min(index, 5) * 40}ms` } as React.CSSProperties}
      className={cn(
        "fv-card-in fv-lift rounded-xl border bg-white/[0.02] p-3",
        "transition-[border-color,box-shadow,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
        "hover:border-white/20 hover:shadow-[0_8px_24px_-16px_rgba(0,0,0,0.9)]",
        focused ? "border-violet-400/50 ring-1 ring-violet-400/30" : "border-white/[0.08]"
      )}
    >
      {/* Type + export status + score */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]",
            accent
          )}
        >
          {meta.label}
        </span>
        {clip.fallback && (
          <span
            title="No strong standalone moment scored here — this window was filled in from attention / edit density."
            className="inline-flex items-center gap-1 rounded-md border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-fog"
          >
            Fallback
          </span>
        )}
        {/* Export status crossfades between idle → queued → rendering → done, so
            the badge reads as one thing changing rather than five different
            badges being swapped in and out under the user. */}
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
            "transition-[background-color,border-color,color] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
            STATUS_CLASSES[clip.exportStatus]
          )}
          title={clip.exportError ?? undefined}
        >
          {exporting && <Loader2 size={9} className="animate-spin" />}
          {clip.exportStatus === "completed" && <Check size={9} />}
          {clip.exportStatus === "failed" && <AlertTriangle size={9} />}
          {CLIP_STATUS_LABEL[clip.exportStatus]}
        </span>
        <span
          className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] tabular-nums text-fog"
          title={`Framevo score: ${scorePct} / 100`}
        >
          <ScoreMeter value={clip.score} />
          {scorePct}
        </span>
      </div>

      {/* Title (inline-editable) */}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setDraft(clip.title);
              setEditing(false);
            }
          }}
          aria-label="Clip title"
          className="w-full rounded-lg border border-violet-400/40 bg-ink/60 px-2 py-1 text-[12.5px] font-semibold text-white outline-none"
        />
      ) : (
        <h4 className="text-[12.5px] font-semibold leading-snug text-white">{clip.title}</h4>
      )}

      {/* Duration + range */}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10.5px] tabular-nums text-fog">
        <span className="inline-flex items-center gap-1">
          <Clock size={11} className="shrink-0" />
          {fmt(clip.duration)}
        </span>
        <span className="text-fog/50">·</span>
        <span>
          {fmt(clip.startTime)}–{fmt(clip.endTime)}
        </span>
      </div>

      {/* Suggested edit style — what the clip will actually render with. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Chip Icon={CropIcon} label={clip.suggestedAspectRatio} title="Suggested aspect ratio" />
        <Chip
          Icon={TypeIcon}
          label={styleLabel(clip.suggestedCaptionStyle)}
          title="Suggested caption style"
        />
        {ops.some((o) => o.type === "zoom") && (
          <Chip Icon={Sparkles} label="Zoom" title="Adds an emphasis zoom" />
        )}
      </div>

      {/* Reason */}
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-fog">{clip.reason}</p>
      {clip.exportStatus === "failed" && clip.exportError && (
        <p className="mt-1 text-[11px] leading-relaxed text-rose-200/90">{clip.exportError}</p>
      )}

      {/* Primary actions */}
      <div className="mt-2.5 flex items-center gap-2">
        <Button
          variant="glass"
          size="sm"
          className="flex-1 justify-center"
          onClick={onOpen}
          leftIcon={<Play size={13} className="fill-current" />}
        >
          Open
        </Button>
        {clip.exportStatus === "completed" && clip.exportUrl ? (
          <Button
            variant="primary"
            size="sm"
            className="flex-1 justify-center"
            onClick={() => window.open(clip.exportUrl, "_blank", "noreferrer")}
            leftIcon={<Download size={13} />}
          >
            Download
          </Button>
        ) : (
          // Deliberately NOT disabled while "exporting": a persisted status can
          // go stale (dialog closed mid-render), and the export dialog is the
          // authority — it blocks a genuine in-flight render with a clear
          // message, and lets a stale one through.
          <Button
            variant="primary"
            size="sm"
            className="flex-1 justify-center"
            onClick={onExport}
            leftIcon={
              exporting ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />
            }
          >
            {exporting ? "Exporting…" : "Export clip"}
          </Button>
        )}
      </div>

      {/* Secondary actions */}
      <div className="mt-1.5 flex items-center gap-1">
        <IconAction
          Icon={GitMerge}
          label="Apply edits to full timeline"
          onClick={onApply}
        />
        <IconAction Icon={Pencil} label="Rename" onClick={() => setEditing(true)} />
        <IconAction
          Icon={RefreshCw}
          label="Regenerate this clip"
          onClick={onRegenerate}
          disabled={busy}
        />
        <IconAction Icon={Trash2} label="Delete" onClick={onDelete} danger />
        {clip.exportStatus === "completed" && clip.exportUrl && (
          <IconAction Icon={Upload} label="Re-export" onClick={onExport} />
        )}
      </div>
    </div>
  );
}

function Chip({
  Icon,
  label,
  title,
}: {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  title: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-medium text-fog"
    >
      <Icon size={10} className="shrink-0" />
      {label}
    </span>
  );
}

function IconAction({
  Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "fv-press-sm inline-flex size-7 items-center justify-center rounded-lg text-fog transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-white/[0.06] hover:text-white disabled:pointer-events-none disabled:opacity-35",
        danger && "hover:bg-rose-500/10 hover:text-rose-200"
      )}
    >
      <Icon size={13} />
    </button>
  );
}

function ScoreMeter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const tone = pct >= 66 ? "bg-emerald-400" : pct >= 40 ? "bg-amber-300" : "bg-fog/50";
  return (
    <span className="inline-block h-1 w-8 overflow-hidden rounded-full bg-white/10" aria-hidden>
      <span className={cn("block h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
    </span>
  );
}

function EmptyNote({
  Icon,
  title,
  body,
}: {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-center">
      <span className="mx-auto mb-2 inline-flex size-9 items-center justify-center rounded-lg bg-violet-500/12 text-violet-200 ring-1 ring-violet-400/25">
        <Icon size={16} />
      </span>
      <h4 className="text-[12.5px] font-semibold text-white">{title}</h4>
      <p className="mx-auto mt-1 max-w-[40ch] text-[11.5px] leading-relaxed text-fog">{body}</p>
    </div>
  );
}
