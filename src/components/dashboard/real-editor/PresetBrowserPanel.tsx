"use client";

import * as React from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock,
  LayoutTemplate,
  Loader2,
  Plus,
  Search,
  Star,
  Wand2,
  X as XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { useEditorReal } from "./context";
import { useClockRef, useClockSelector } from "./playback-clock";
import { LooksGallery } from "./LooksGallery";
import { PresetPreview } from "./PresetPreview";
import { applyPreset } from "@/lib/presets/apply";
import { PRESET_IDS, getPreset, searchPresets } from "@/lib/presets/registry";
import {
  MAX_RECENT_PRESETS,
  PRESET_CATEGORIES,
  PRESET_CATEGORY_LABEL,
  type FramevoPreset,
  type PresetCategory,
} from "@/lib/presets/types";
import { useWorkspaceSettings } from "@/lib/firebase/workspace-settings";

/**
 * The preset browser — Framevo's shipped library of captions, titles, hooks,
 * CTAs, callouts, transitions, intros, outros and text animations.
 *
 * EVERY preset shown comes from the registry, and applying one goes through
 * `applyPreset`, which compiles it into an ORDINARY `DetectedMoment` on the
 * ordinary timeline. So a preset the user adds here is movable, resizable,
 * restylable, undoable and exportable like anything they made by hand — this
 * panel is a browser, not a second edit system.
 *
 * Favourites and recents live in workspace settings, not on the project: they
 * follow the person, not one video.
 */

/**
 * The pseudo-categories, plus "all", that sit alongside the real ones.
 *
 * "looks" is one of them: the whole-recording presets used to be their own rail
 * button and their own panel, which split "one click and the video changes" into
 * two places the user had to know apart. They're a category here now — see
 * {@link LooksGallery} for why they still can't be a plain grid row (they retune
 * the project instead of adding a timeline edit).
 */
type Tab = "all" | "looks" | "favourites" | "recent" | PresetCategory;

const TAB_LABEL: Record<Tab, string> = {
  all: "All",
  looks: "Looks",
  favourites: "Favourites",
  recent: "Recent",
  ...PRESET_CATEGORY_LABEL,
};

const TABS: Tab[] = ["all", "looks", "favourites", "recent", ...PRESET_CATEGORIES];

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Trailing-zero-free seconds: 2.5 → "2.5s", 3.0 → "3s". */
function secs(v: number): string {
  return `${Number(v.toFixed(1))}s`;
}

export function PresetBrowserPanel() {
  const {
    project,
    duration,
    addMoment,
    newMomentId,
    setSelectedMomentId,
    openInspector,
  } = useEditorReal();
  // Applying a preset needs the time at the moment of the CLICK, so it reads the
  // ref — subscribing would re-render this whole 39-card grid on every tick.
  const clockRef = useClockRef();
  const { settings, loading: settingsLoading, save } = useWorkspaceSettings();
  const toast = useToast();

  const [query, setQuery] = React.useState("");
  const [tab, setTab] = React.useState<Tab>("all");
  const [applyingId, setApplyingId] = React.useState<string | null>(null);

  const favouriteIds = settings.presetLibrary.favouriteIds;
  const recentIds = settings.presetLibrary.recentIds;

  /**
   * The output canvas is what decides which aspect adaptation gets baked in, so
   * it must be the SAME canvas the exporter will use: the configured output
   * canvas when there is one, the source's own dimensions otherwise.
   */
  const { canvasWidth, canvasHeight } = React.useMemo(() => {
    const oc = project.effectsSettings?.outputCanvas;
    const w = oc?.width || project.width || 1920;
    const h = oc?.height || project.height || 1080;
    return { canvasWidth: w, canvasHeight: h };
  }, [project.effectsSettings?.outputCanvas, project.width, project.height]);

  const results = React.useMemo<FramevoPreset[]>(() => {
    // Looks aren't library presets — they're rendered by their own gallery, and
    // this list stays empty for them rather than pretending to search them.
    if (tab === "looks") return [];
    if (tab === "favourites" || tab === "recent") {
      const ids = tab === "favourites" ? favouriteIds : recentIds;
      // No query → keep the LIST's own order (recents are most-recent-first, and
      // re-sorting them by relevance would destroy the only thing they mean).
      const inOrder = ids
        .map((id) => getPreset(id))
        .filter((p): p is FramevoPreset => !!p);
      if (!query.trim()) return inOrder;
      const allowed = new Set(inOrder.map((p) => p.id));
      return searchPresets(query).filter((p) => allowed.has(p.id));
    }
    return searchPresets(query, tab === "all" ? undefined : { category: tab });
  }, [tab, query, favouriteIds, recentIds]);

  const favouriteSet = React.useMemo(() => new Set(favouriteIds), [favouriteIds]);

  /** Persist the library state. One write — both lists, always together. */
  const persist = React.useCallback(
    async (next: { favouriteIds: string[]; recentIds: string[] }) => {
      await save({ presetLibrary: next });
    },
    [save]
  );

  const toggleFavourite = React.useCallback(
    async (preset: FramevoPreset) => {
      const on = favouriteSet.has(preset.id);
      const nextFavourites = on
        ? favouriteIds.filter((id) => id !== preset.id)
        : [preset.id, ...favouriteIds];
      try {
        await persist({ favouriteIds: nextFavourites, recentIds });
      } catch (err) {
        toast.error(
          "Presets",
          err instanceof Error ? err.message : "Couldn't save your favourites."
        );
      }
    },
    [favouriteIds, favouriteSet, persist, recentIds, toast]
  );

  const apply = React.useCallback(
    async (preset: FramevoPreset) => {
      if (applyingId) return;
      setApplyingId(preset.id);
      try {
        // The ONE bridge from the library to the timeline. Never hand-build a
        // moment here: the aspect adaptation, safe-area clamp, provenance and
        // per-type settings bag all live in `applyPreset`.
        const moment = applyPreset({
          preset,
          startTime: clockRef.current,
          duration,
          canvasWidth,
          canvasHeight,
          id: newMomentId(),
        });

        if (!moment) {
          toast.error(
            "Presets",
            "There isn't room for this preset at the playhead — move it earlier and try again."
          );
          return;
        }

        await addMoment(moment);
        setSelectedMomentId(moment.id);
        openInspector();

        // Recents are a convenience, not the edit — a failed settings write must
        // never look like a failed apply.
        if (!settingsLoading) {
          const nextRecents = [
            preset.id,
            ...recentIds.filter((id) => id !== preset.id),
          ].slice(0, MAX_RECENT_PRESETS);
          try {
            await persist({ favouriteIds, recentIds: nextRecents });
          } catch {
            /* the edit landed; a stale "Recent" list is not worth a toast */
          }
        }
      } catch (err) {
        toast.error(
          "Presets",
          err instanceof Error ? err.message : "Couldn't add that preset."
        );
      } finally {
        setApplyingId(null);
      }
    },
    [
      addMoment,
      applyingId,
      canvasHeight,
      canvasWidth,
      clockRef,
      duration,
      favouriteIds,
      newMomentId,
      openInspector,
      persist,
      recentIds,
      setSelectedMomentId,
      settingsLoading,
      toast,
    ]
  );

  // The mm:ss label changes once a second, so selecting the FORMATTED string
  // makes this panel re-render at 1Hz while playing instead of on every tick.
  const playheadLabel = useClockSelector((t) => fmt(t));

  return (
    <div className="flex h-full flex-col">
      {/* ── Search + filters — sticky, because the grid is long ───────────── */}
      <div className="sticky top-0 z-10 shrink-0 space-y-2.5 border-b border-white/[0.06] bg-surface/95 px-4 py-3 backdrop-blur-xl">
        <div className="relative">
          <Search
            size={14}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fog"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            type="search"
            placeholder="Search presets — bold, typewriter, glitch, lower third…"
            aria-label="Search presets"
            className="h-9 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] pl-9 pr-9 text-[12.5px] text-white outline-none transition-colors duration-150 placeholder:text-fog/60 focus:border-violet-400/50 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              title="Clear search"
              className="fv-press-sm absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white"
            >
              <XIcon size={13} />
            </button>
          )}
        </div>

        <TabScroller activeTab={tab}>
          {TABS.map((t) => {
            const count =
              t === "favourites"
                ? favouriteIds.length
                : t === "recent"
                  ? recentIds.length
                  : undefined;
            return (
              <button
                key={t}
                type="button"
                data-tab={t}
                onClick={() => setTab(t)}
                aria-pressed={tab === t}
                className={cn(
                  "fv-press-sm inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[11.5px] font-medium",
                  "transition-[background-color,border-color,color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
                  tab === t
                    ? "border-violet-400/40 bg-violet-500/15 text-violet-100"
                    : "border-white/[0.08] bg-white/[0.03] text-fog hover:border-white/20 hover:text-white"
                )}
              >
                {t === "looks" && <Wand2 size={11} className="shrink-0" />}
                {t === "favourites" && <Star size={11} className="shrink-0" />}
                {t === "recent" && <Clock size={11} className="shrink-0" />}
                {TAB_LABEL[t]}
                {count !== undefined && count > 0 && (
                  <span className="font-mono text-[10px] tabular-nums opacity-70">{count}</span>
                )}
              </button>
            );
          })}
        </TabScroller>

        {/* Where the edit will land. The single most useful thing to know before
            clicking, and the thing a preset browser usually leaves you to guess.
            A Look lands nowhere — it retunes the project — so it says so instead
            of quoting a playhead time that means nothing to it. */}
        {tab === "looks" ? (
          <p className="text-[11px] leading-relaxed text-fog">
            Applies to the whole recording — the timeline is left alone.
          </p>
        ) : (
          <p className="flex items-center justify-between gap-2 text-[11px] leading-relaxed text-fog">
            <span>
              Adds at the playhead —{" "}
              <span className="font-mono tabular-nums text-white/90">{playheadLabel}</span>
            </span>
            <span className="font-mono tabular-nums text-fog/70">
              {results.length}/{PRESET_IDS.length}
            </span>
          </p>
        )}
      </div>

      {/* ── The grid ──────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "looks" ? (
          <LooksGallery query={query} />
        ) : results.length === 0 ? (
          <EmptyState tab={tab} query={query} onClear={() => setQuery("")} />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
            {results.map((preset, i) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                index={i}
                favourite={favouriteSet.has(preset.id)}
                favouriteBusy={settingsLoading}
                applying={applyingId === preset.id}
                disabled={applyingId !== null && applyingId !== preset.id}
                playheadLabel={playheadLabel}
                onApply={() => void apply(preset)}
                onToggleFavourite={() => void toggleFavourite(preset)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════

/** How far one arrow press travels. About two chips — enough to feel like progress. */
const TAB_SCROLL_STEP = 160;

/**
 * The category row — horizontally scrollable, and actually operable with a mouse.
 *
 * It was already `overflow-x-auto`, but with the scrollbar hidden (the row is
 * 12 chips wide and a permanent scrollbar under them looks like a bug). That is
 * fine on a trackpad and a dead end with a wheel mouse: the last categories
 * (Intros, Outros, Text animations) simply could not be reached. Hiding the
 * scrollbar removed the affordance AND the mechanism.
 *
 * So the mechanisms come back, without the scrollbar:
 *   - the WHEEL scrolls it sideways (a vertical wheel over this row means
 *     "move along the row" — there is nothing to scroll vertically here);
 *   - ARROW BUTTONS appear at whichever edge has more content, and only then;
 *   - a fade at each live edge says "there's more this way" — the affordance the
 *     hidden scrollbar used to be;
 *   - selecting a tab (or tabbing to one) scrolls it into view, so the active
 *     chip is never parked off-screen.
 *
 * Drag-to-scroll is deliberately absent: the children are buttons, and a drag
 * that starts on a button either eats the click or fires it — both are worse
 * than the three mechanisms above.
 */
function TabScroller({
  activeTab,
  children,
}: {
  activeTab: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });

  const measure = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 1px of slack: sub-pixel widths make an exactly-scrolled-to-end row report
    // a fractional remainder forever, which would leave the arrow stuck on.
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right }
    );
  }, []);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();

    // The panel is resizable by the drag handle on its left edge, so "does this
    // row overflow?" changes without any scroll ever happening.
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    // Not passive: turning a vertical wheel into horizontal scroll requires
    // preventing the default, and React's onWheel is passive by default.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [measure]);

  // Keep the selected chip visible — including when the selection changes from
  // somewhere else, and on first open with a tab that's off to the right.
  React.useEffect(() => {
    const el = ref.current;
    const chip = el?.querySelector<HTMLElement>(`[data-tab="${activeTab}"]`);
    chip?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab]);

  const nudge = (dir: -1 | 1) =>
    ref.current?.scrollBy({ left: dir * TAB_SCROLL_STEP, behavior: "smooth" });

  return (
    <div className="relative -mx-1">
      <div
        ref={ref}
        role="group"
        aria-label="Filter presets by category"
        onScroll={measure}
        className={cn(
          "flex gap-1 overflow-x-auto overflow-y-hidden scroll-smooth px-1 pb-0.5",
          // The scrollbar stays hidden — the fades and arrows are the affordance.
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        )}
      >
        {children}
      </div>

      {/* Edge fades — pointer-events-none so they never eat a click on a chip. */}
      {edges.left && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-surface to-transparent"
        />
      )}
      {edges.right && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-surface to-transparent"
        />
      )}

      {edges.left && <TabArrow dir={-1} onClick={() => nudge(-1)} />}
      {edges.right && <TabArrow dir={1} onClick={() => nudge(1)} />}
    </div>
  );
}

function TabArrow({ dir, onClick }: { dir: -1 | 1; onClick: () => void }) {
  const back = dir === -1;
  return (
    <button
      type="button"
      onClick={onClick}
      // Not reachable by keyboard on purpose: Tab already walks the chips and
      // scrolls each into view, so these would be two dead stops in the order.
      tabIndex={-1}
      aria-hidden
      title={back ? "Scroll categories left" : "Scroll categories right"}
      className={cn(
        "fv-press-sm absolute top-1/2 z-10 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md",
        "border border-white/10 bg-ink/90 text-fog shadow-[0_2px_10px_-4px_rgba(0,0,0,0.8)] backdrop-blur-md",
        "transition-colors duration-150 hover:border-white/25 hover:text-white",
        back ? "left-0" : "right-0"
      )}
    >
      {back ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
    </button>
  );
}

function PresetCard({
  preset,
  index,
  favourite,
  favouriteBusy,
  applying,
  disabled,
  playheadLabel,
  onApply,
  onToggleFavourite,
}: {
  preset: FramevoPreset;
  /** Position in the grid — drives the entrance stagger. */
  index: number;
  favourite: boolean;
  favouriteBusy: boolean;
  applying: boolean;
  disabled: boolean;
  playheadLabel: string;
  onApply: () => void;
  onToggleFavourite: () => void;
}) {
  // Hover/focus is what un-freezes the preview. Kept local so pointing at one
  // card never re-renders the other thirty-seven.
  const [active, setActive] = React.useState(false);

  return (
    <div
      className="group relative"
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => setActive(false)}
      style={{ "--fv-stagger": `${Math.min(index, 7) * 30}ms` } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={onApply}
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
        disabled={disabled || applying}
        title={`Add "${preset.name}" at ${playheadLabel}`}
        aria-label={`Add ${preset.name} preset at ${playheadLabel}. ${preset.description}`}
        className={cn(
          "fv-card-in fv-lift block w-full rounded-xl border border-white/[0.08] bg-white/[0.02] p-2 text-left",
          "transition-[border-color,box-shadow,transform,opacity] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
          "hover:border-white/20 hover:shadow-[0_8px_24px_-16px_rgba(0,0,0,0.9)]",
          "focus-visible:outline-none focus-visible:border-violet-400/50 focus-visible:ring-2 focus-visible:ring-violet-400/50",
          "disabled:pointer-events-none disabled:opacity-45"
        )}
      >
        <PresetPreview preset={preset} active={active} />

        <div className="px-0.5 pb-0.5 pt-2">
          <div className="flex items-center gap-1.5">
            <h4 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-white">
              {preset.name}
            </h4>
            <span className="shrink-0 rounded-md border border-violet-400/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium capitalize text-violet-100">
              {preset.tone}
            </span>
          </div>

          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-fog">
            {preset.description}
          </p>

          <div className="mt-1.5 flex items-center gap-1">
            <Chip>{PRESET_CATEGORY_LABEL[preset.category]}</Chip>
            <Chip>{secs(preset.defaultDurationSeconds)}</Chip>
            {/* The action, revealed on approach — the card IS the button, so this
                is a hint, not a second control. */}
            <span
              className={cn(
                "ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-violet-100",
                "bg-violet-500/15 opacity-0 transition-opacity duration-150",
                "group-hover:opacity-100 group-focus-within:opacity-100"
              )}
            >
              {applying ? (
                <Loader2 size={10} className="animate-spin" />
              ) : (
                <Plus size={10} />
              )}
              {applying ? "Adding" : "Add"}
            </span>
          </div>
        </div>
      </button>

      {/* Sibling, not a child: a button inside a button is invalid HTML and the
          star would be unreachable by keyboard. */}
      <button
        type="button"
        onClick={onToggleFavourite}
        disabled={favouriteBusy}
        aria-pressed={favourite}
        aria-label={
          favourite ? `Remove ${preset.name} from favourites` : `Add ${preset.name} to favourites`
        }
        title={favourite ? "Remove from favourites" : "Add to favourites"}
        className={cn(
          "fv-press-sm absolute right-3.5 top-3.5 z-10 inline-flex size-7 items-center justify-center rounded-lg",
          "border backdrop-blur-md transition-[background-color,border-color,color,opacity,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60",
          "disabled:pointer-events-none disabled:opacity-40",
          favourite
            ? "border-amber-300/40 bg-amber-400/15 text-amber-200"
            : "border-white/10 bg-black/40 text-white/70 opacity-0 hover:border-white/25 hover:text-white group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        )}
      >
        <Star size={13} className={favourite ? "fill-current" : undefined} />
      </button>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-medium text-fog">
      {children}
    </span>
  );
}

/** Every empty list says WHY it's empty and what to do about it. */
function EmptyState({
  tab,
  query,
  onClear,
}: {
  tab: Tab;
  query: string;
  onClear: () => void;
}) {
  const searching = query.trim().length > 0;

  const { Icon, title, body } = searching
    ? {
        Icon: AlertTriangle,
        title: "No presets match that",
        body: `Nothing in the library matches “${query.trim()}”. Try a look (“bold”, “minimal”), a motion (“glitch”, “typewriter”) or a category (“hooks”, “transitions”).`,
      }
    : tab === "favourites"
      ? {
          Icon: Star,
          title: "No favourites yet",
          body: "Star a preset and it lands here — your favourites follow you across every project, not just this one.",
        }
      : tab === "recent"
        ? {
            Icon: Clock,
            title: "Nothing applied yet",
            body: "The presets you use show up here, most recent first, so the look you keep reaching for is always one click away.",
          }
        : {
            Icon: LayoutTemplate,
            title: "Nothing in this category",
            body: "Try another category, or search the whole library.",
          };

  return (
    <div className="mx-auto max-w-[46ch] rounded-xl border border-white/[0.08] bg-white/[0.02] p-5 text-center">
      <span className="mx-auto mb-2.5 inline-flex size-9 items-center justify-center rounded-lg bg-violet-500/12 text-violet-200 ring-1 ring-violet-400/25">
        <Icon size={16} />
      </span>
      <h4 className="text-[13px] font-semibold text-white">{title}</h4>
      <p className="mx-auto mt-1.5 text-[11.5px] leading-relaxed text-fog">{body}</p>
      {searching && (
        <Button variant="ghost" size="sm" className="mt-3" onClick={onClear}>
          Clear search
        </Button>
      )}
    </div>
  );
}
