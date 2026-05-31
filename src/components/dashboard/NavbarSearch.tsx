"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Folder,
  Wand2,
  Download as DownloadIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeProjects } from "@/lib/firebase/projects";
import { subscribeCustomPresets } from "@/lib/firebase/custom-presets";
import { subscribeExports } from "@/lib/firebase/exports";
import { BUILTIN_PRESETS } from "@/lib/presets";
import {
  runGlobalSearch,
  groupResults,
  type SearchResult,
  type SearchResultKind,
} from "@/lib/search/global-search";
import type {
  ProjectDoc,
  Preset,
  ExportDoc,
} from "@/lib/firebase/schema";
import { useHotkey } from "@/lib/useHotkey";

/**
 * Live navbar search. Subscribes to the user's projects, custom
 * presets, and exports (plus the static built-in presets array),
 * runs the pure `runGlobalSearch` matcher on every keystroke, and
 * presents grouped results in a dropdown.
 *
 * Behaviour:
 *   - ⌘K / Ctrl+K (anywhere on the page) → focus the input + open it.
 *   - Empty query + focused → empty-hint state ("Type to search…")
 *     so the dropdown doesn't shout when nothing's been typed.
 *   - Arrow up/down navigates focus.
 *   - Enter on the input opens the top result; Enter on a focused row
 *     opens that row.
 *   - Esc clears focus + closes.
 *   - Click outside closes.
 *
 * The dropdown pattern (useRef + mousedown listener) is the same one
 * the existing Account Menu in Topbar uses — kept consistent so the
 * surface feels familiar.
 */
export function NavbarSearch() {
  const { user } = useAuth();
  const router = useRouter();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [focusIndex, setFocusIndex] = React.useState(0);

  // ── Live sources ────────────────────────────────────────────────────
  const [projects, setProjects] = React.useState<ProjectDoc[]>([]);
  const [customPresets, setCustomPresets] = React.useState<Preset[]>([]);
  const [exportsList, setExportsList] = React.useState<ExportDoc[]>([]);

  React.useEffect(() => {
    if (!user) return;
    const unsub = subscribeProjects(user.uid, setProjects);
    return () => unsub();
  }, [user]);

  React.useEffect(() => {
    if (!user) return;
    const unsub = subscribeCustomPresets(user.uid, setCustomPresets);
    return () => unsub();
  }, [user]);

  React.useEffect(() => {
    if (!user) return;
    const unsub = subscribeExports(user.uid, setExportsList);
    return () => unsub();
  }, [user]);

  // ── Search ──────────────────────────────────────────────────────────
  const results = React.useMemo(() => {
    return runGlobalSearch(query, {
      projects,
      builtinPresets: BUILTIN_PRESETS,
      customPresets,
      exports: exportsList,
    });
  }, [query, projects, customPresets, exportsList]);

  const groups = React.useMemo(() => groupResults(results), [results]);
  const hasQuery = query.trim().length > 0;

  // Reset focus when the result set changes.
  React.useEffect(() => {
    setFocusIndex(0);
  }, [results.length, query]);

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current || containerRef.current.contains(e.target as Node))
        return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // ⌘K / Ctrl+K — focus + open from anywhere.
  useHotkey(
    { key: "k", meta: true, ctrl: true },
    () => {
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    },
    { allowInInput: true }
  );

  const openResult = React.useCallback(
    (r: SearchResult | undefined) => {
      if (!r) return;
      setOpen(false);
      setQuery("");
      router.push(r.href);
    },
    [router]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setFocusIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      openResult(results[focusIndex] ?? results[0]);
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div ref={containerRef} className="relative max-w-md flex-1">
      <Search
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fog"
      />
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="Search projects, presets, exports…"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="Search"
        aria-expanded={open}
        className="h-9 w-full rounded-lg border border-white/10 bg-white/[0.02] pl-9 pr-16 text-sm text-white placeholder:text-fog/70 outline-none transition-colors duration-200 focus:border-white/20 focus:bg-white/[0.04]"
      />
      <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-fog sm:inline-flex">
        ⌘K
      </kbd>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-11 z-40 max-h-[60vh] overflow-y-auto rounded-xl border border-white/10 bg-surface/95 shadow-cinematic backdrop-blur-xl"
        >
          {!hasQuery ? (
            <div className="px-4 py-6 text-center text-[12px] text-fog">
              Type to search projects, presets, and exports.
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-fog">
              No results found.
            </div>
          ) : (
            groups.map((group, gIdx) => (
              <SearchGroup
                key={group.kind}
                kind={group.kind}
                rows={group.rows}
                allResults={results}
                focusIndex={focusIndex}
                onSelect={openResult}
                onHover={(idx) => setFocusIndex(idx)}
                showDivider={gIdx > 0}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SearchGroup({
  kind,
  rows,
  allResults,
  focusIndex,
  onSelect,
  onHover,
  showDivider,
}: {
  kind: SearchResultKind;
  rows: SearchResult[];
  allResults: SearchResult[];
  focusIndex: number;
  onSelect: (r: SearchResult) => void;
  onHover: (flatIdx: number) => void;
  showDivider: boolean;
}) {
  return (
    <div className={cn(showDivider && "border-t border-white/[0.06]")}>
      <div className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
        {KIND_LABEL[kind]}
      </div>
      <ul>
        {rows.map((r) => {
          const flatIdx = allResults.indexOf(r);
          const focused = flatIdx === focusIndex;
          return (
            <li key={`${r.kind}:${r.id}`}>
              <button
                type="button"
                onMouseEnter={() => onHover(flatIdx)}
                onClick={() => onSelect(r)}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors duration-100",
                  focused
                    ? "bg-white/[0.06] text-white"
                    : "text-white/85 hover:bg-white/[0.04] hover:text-white"
                )}
              >
                <KindIcon kind={r.kind} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.title}</span>
                  {r.subtitle && (
                    <span className="block truncate text-[11px] text-fog">
                      {r.subtitle}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function KindIcon({ kind }: { kind: SearchResultKind }) {
  const common = "shrink-0 text-violet-300";
  if (kind === "project") return <Folder size={13} className={common} />;
  if (kind === "preset") return <Wand2 size={13} className={common} />;
  return <DownloadIcon size={13} className={common} />;
}

const KIND_LABEL: Record<SearchResultKind, string> = {
  project: "Projects",
  preset: "Presets",
  export: "Exports",
};
