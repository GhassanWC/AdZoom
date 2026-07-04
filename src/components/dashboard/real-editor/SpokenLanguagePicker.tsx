"use client";

import * as React from "react";
import { Check, ChevronDown, Languages, Search, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  TRANSCRIPT_LANGUAGES,
  transcriptLanguageLabel,
  type TranscriptLanguageMode,
} from "@/lib/transcript/language";

/**
 * Searchable "Spoken language" selector for the Analyze dialog + the "Wrong
 * language?" flow. "Auto Detect" is the default; picking a language switches the
 * run to `selected` mode (its BCP-47 is sent to ASR verbatim, never overridden by
 * the server env). Transcription stays in the spoken language — never translated.
 */
export function SpokenLanguagePicker({
  mode,
  code,
  onChange,
  disabled,
}: {
  mode: TranscriptLanguageMode;
  code?: string | null;
  onChange: (mode: TranscriptLanguageMode, code?: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const ref = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    // Focus the search box when the menu opens.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      clearTimeout(t);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? TRANSCRIPT_LANGUAGES.filter(
        (l) => l.label.toLowerCase().includes(q) || l.code.toLowerCase().includes(q)
      )
    : TRANSCRIPT_LANGUAGES;

  const current =
    mode === "selected" && code ? transcriptLanguageLabel(code) ?? code : "Auto Detect";

  const pick = (m: TranscriptLanguageMode, c?: string) => {
    onChange(m, c);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-left text-[13px] transition-colors duration-150 hover:border-white/15",
          disabled && "pointer-events-none opacity-60"
        )}
      >
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-white/[0.05] text-fog">
          {mode === "auto" ? <Sparkles size={13} className="text-violet-300" /> : <Languages size={13} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-white/90">{current}</span>
        {mode === "selected" && code && (
          <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-fog">
            {code}
          </span>
        )}
        <ChevronDown size={14} className="shrink-0 text-fog" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 overflow-hidden rounded-xl border border-white/10 bg-ink/95 shadow-cinematic backdrop-blur-xl">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
            <Search size={13} className="shrink-0 text-fog" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search language…"
              className="w-full bg-transparent text-[13px] text-white outline-none placeholder:text-fog/60"
            />
          </div>
          <div role="listbox" className="max-h-64 overflow-y-auto p-1">
            {/* Auto Detect always first, unfiltered by search text. */}
            {(!q || "auto detect".includes(q)) && (
              <LangRow
                label="Auto Detect"
                hint="Detect from a small candidate list"
                Icon={Sparkles}
                selected={mode === "auto"}
                onClick={() => pick("auto")}
              />
            )}
            {filtered.map((l) => (
              <LangRow
                key={l.code}
                label={l.label}
                hint={l.code}
                rtl={l.rtl}
                selected={mode === "selected" && code?.toLowerCase() === l.code.toLowerCase()}
                onClick={() => pick("selected", l.code)}
              />
            ))}
            {filtered.length === 0 && (!q || !"auto detect".includes(q)) && (
              <div className="px-3 py-4 text-center text-[12px] text-fog">No languages match “{query}”.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LangRow({
  label,
  hint,
  Icon,
  rtl,
  selected,
  onClick,
}: {
  label: string;
  hint: string;
  Icon?: typeof Sparkles;
  rtl?: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors duration-150",
        selected ? "bg-violet-500/15 text-white" : "text-fog hover:bg-white/[0.05] hover:text-white"
      )}
    >
      {Icon ? <Icon size={12} className="shrink-0 text-violet-300" /> : <span className="w-3 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {rtl && (
        <span className="shrink-0 rounded bg-white/[0.06] px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-fog/80">
          RTL
        </span>
      )}
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-fog/60">{hint}</span>
      {selected && <Check size={13} className="shrink-0 text-violet-300" />}
    </button>
  );
}
