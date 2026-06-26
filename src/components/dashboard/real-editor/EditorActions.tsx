"use client";

import * as React from "react";
import {
  Sparkles,
  RefreshCcw,
  Loader2,
  Crop,
  Frame,
  SlidersHorizontal,
  Download,
  Wrench,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";

/**
 * Editor header actions — the single primary CTA (Export) plus a grouped,
 * visually-secondary toolbar of project tools (Analyze / Crop / Canvas /
 * Effects). The tools share one calm bordered group so they read as "a
 * toolbar", never as buttons competing with Export.
 *
 * Responsive: the tools render inline (icon + label on xl, icon-only on
 * md–xl) on `md+`; below `md` they collapse into a single "Tools" dropdown so
 * the header never wraps into a wall of buttons. Export stays visible at every
 * width.
 */
export interface EditorActionsProps {
  hasAnalysis: boolean;
  isAnalyzingNow: boolean;
  canAnalyze: boolean;
  analyzeTitle?: string;
  cropEditing: boolean;
  onAnalyze: () => void;
  onToggleCrop: () => void;
  onCanvas: () => void;
  onEffects: () => void;
  onExport: () => void;
}

interface ToolDef {
  id: string;
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  /** Render the icon spinning (in-flight). */
  busy?: boolean;
  /** Persistent "on" state (e.g. crop editing active). */
  active?: boolean;
  /** Subtle violet emphasis — used for Analyze before a first draft exists. */
  emphasize?: boolean;
  title?: string;
}

export function EditorActions({
  hasAnalysis,
  isAnalyzingNow,
  canAnalyze,
  analyzeTitle,
  cropEditing,
  onAnalyze,
  onToggleCrop,
  onCanvas,
  onEffects,
  onExport,
}: EditorActionsProps) {
  const tools: ToolDef[] = [
    {
      id: "analyze",
      label: hasAnalysis ? "Re-analyze" : "Analyze",
      Icon: hasAnalysis ? RefreshCcw : Sparkles,
      onClick: onAnalyze,
      disabled: hasAnalysis ? isAnalyzingNow : !canAnalyze,
      busy: isAnalyzingNow,
      emphasize: !hasAnalysis,
      title: analyzeTitle,
    },
    {
      id: "crop",
      label: cropEditing ? "Done cropping" : "Crop frame",
      Icon: Crop,
      onClick: onToggleCrop,
      active: cropEditing,
      title: "Crop the source frame (applies to the whole video)",
    },
    { id: "canvas", label: "Canvas", Icon: Frame, onClick: onCanvas },
    { id: "effects", label: "Effects", Icon: SlidersHorizontal, onClick: onEffects },
  ];

  return (
    <div className="flex items-center gap-2">
      {/* Inline tool group — md and up. */}
      <div className="hidden items-center gap-1 rounded-xl border border-white/10 bg-white/[0.02] p-1 md:flex">
        {tools.map((t) => (
          <ToolButton key={t.id} {...t} />
        ))}
      </div>

      {/* Collapsed tools menu — below md. */}
      <div className="md:hidden">
        <ToolsMenu tools={tools} />
      </div>

      {/* The single primary CTA. */}
      <Button
        onClick={onExport}
        variant="primary"
        size="sm"
        leftIcon={<Download size={14} />}
      >
        Export
      </Button>
    </div>
  );
}

function ToolButton({ label, Icon, onClick, disabled, busy, active, emphasize, title }: ToolDef) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "group inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[12.5px] font-medium transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "border-violet-400/45 bg-violet-500/15 text-violet-100"
          : emphasize
            ? "border-violet-400/30 bg-violet-500/[0.08] text-violet-100 hover:bg-violet-500/15"
            : "border-transparent text-white/85 hover:border-white/15 hover:bg-white/[0.06] hover:text-white"
      )}
    >
      {busy ? (
        <Loader2 size={14} className="shrink-0 animate-spin" />
      ) : (
        <Icon size={14} className="shrink-0" />
      )}
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

function ToolsMenu({ tools }: { tools: ToolDef[] }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  // Treated as a simple disclosure of plain buttons (not a full menu widget):
  // close on outside-click and on Escape (refocusing the trigger), which is the
  // keyboard contract a disclosure owes without signing up for roving focus.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] px-3 text-[13px] font-medium text-white/90 transition-colors duration-150 hover:border-white/20 hover:bg-white/[0.04]"
      >
        <Wrench size={14} />
        Tools
        <ChevronDown size={13} className={cn("opacity-70 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-56 overflow-hidden rounded-xl border border-white/10 bg-ink/95 p-1 shadow-cinematic backdrop-blur-xl">
          {tools.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={t.disabled}
              title={t.title ?? t.label}
              aria-pressed={t.active}
              onClick={() => {
                t.onClick();
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors duration-150",
                "disabled:cursor-not-allowed disabled:opacity-40",
                t.active
                  ? "bg-violet-500/15 text-violet-100"
                  : "text-white/90 hover:bg-white/[0.06]"
              )}
            >
              <span
                className={cn(
                  "inline-flex size-7 shrink-0 items-center justify-center rounded-md ring-1",
                  t.active || t.emphasize
                    ? "bg-violet-500/15 text-violet-200 ring-violet-400/20"
                    : "bg-white/[0.06] text-white/80 ring-white/10"
                )}
              >
                {t.busy ? <Loader2 size={14} className="animate-spin" /> : <t.Icon size={14} />}
              </span>
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
