"use client";

import * as React from "react";
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Undo2,
  Redo2,
  BarChart2,
  Plus,
  Scissors,
  Copy,
  SquareSplitHorizontal as SplitIcon,
  Trash2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Zap,
  MousePointer2,
  Target,
  FastForward,
  Type,
  Sparkles,
  Megaphone,
  Eye,
  EyeOff,
  BadgeCheck,
  Captions,
  Shuffle,
  Film,
  Layers,
  PanelTop,
  PanelBottom,
  SquareSplitVertical,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { EffectType, TimelineLayerId } from "@/lib/firebase/schema";
import { useEditorReal } from "./context";
import { useRenderCount } from "@/lib/perf/render-probe";
import { useMomentReview } from "./useMomentReview";
import { MenuPopover, useMenuPopover } from "./MenuPopover";
import { PlaybackTransport, PlaybackVolumeFullscreen } from "./PlaybackControls";
import { MODE_FRACTION, modeForSplitFraction, type WorkspaceMode } from "./workspace-split";

/** Aggregated single-signal health used by the dot. */
export type TimelineHealth = "balanced" | "clustered" | "quiet" | "empty";

/**
 * ONE maximally-compact bar (48px) above the timeline lanes. Every secondary
 * concern lives behind a dropdown so the bar reads as three groups, not a wall
 * of buttons — a three-column grid keeps the Play button perfectly centered no
 * matter how much content sits on either side.
 *
 *   Left:   title · health · Add (primary, stays visible) · Edit ▾ (Split/
 *           Duplicate/Delete) · Layers ▾ (one show/hide per lane) · [undo|redo]
 *   Center: PlaybackTransport (jump/back5/Play/forward5/time) — shared with
 *           the fullscreen overlay pill, one playback implementation.
 *   Right:  View ▾ (workspace mode/Scenes/Insights) · volume · fullscreen ·
 *           ⋯ overflow (zoom, fit, edit review-nav, shortcuts)
 *
 * ── What keeps ten controls legible ──────────────────────────────────────────
 * Three rules, and breaking any one of them is what made this bar feel messy:
 *
 *   1. SHAPE ENCODES SYSTEM. Bar chrome is a 32px rounded-lg control
 *      (BAR_CONTROL); playback is a 36px ROUND button with a 40px Play. You can
 *      tell what a control belongs to before reading its icon — which matters
 *      most for undo/redo, whose arrows sit inches from the seek arrows.
 *   2. SPACING ENCODES GROUPING. gap-1 within a group, gap-2 between groups.
 *   3. ONE LOUD THING PER SIDE. Add is violet on the left, Play is violet in
 *      the centre. A warning (hidden layers) is amber in TEXT only — it must
 *      never outrank the primary action it sits beside.
 *
 * Status is not chrome: the health badge is a bare dot + label, because
 * anything wearing a button's shape in this bar should do something when
 * pressed.
 *
 * The optional scene/chapter strip itself renders as a sibling BELOW this bar
 * (in RealTimeline) only while `scenesOpen` — the View menu just owns the toggle.
 */
export function EditorUnifiedControlBar({
  health,
  zoom,
  minZoom,
  maxZoom,
  onZoomIn,
  onZoomOut,
  onFit,
  insightsOpen,
  onToggleInsights,
  hasScenes,
  layerRows,
  onToggleLayer,
  onShowAllLayers,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  hasSelection,
  onAdd,
  onDuplicate,
  canSplit,
  onSplit,
  onDelete,
}: {
  health: TimelineHealth;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  insightsOpen: boolean;
  onToggleInsights: () => void;
  hasScenes: boolean;
  /** One row per lane on the timeline — the Layers menu's whole content. */
  layerRows: LayerRow[];
  onToggleLayer: (id: TimelineLayerId, visible: boolean) => void;
  onShowAllLayers: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  hasSelection: boolean;
  onAdd: (effectType: EffectType) => void;
  onDuplicate: () => void;
  /** The playhead is inside the selected edit and both halves would be usable. */
  canSplit: boolean;
  onSplit: () => void;
  onDelete: () => void;
}) {
  useRenderCount("control-bar");
  const { splitFraction, setSplitFraction, scenesOpen, toggleScenes } = useEditorReal();
  // Edit-review navigation (prev / count / next) — lives in the overflow menu
  // now; still timeline navigation, not an editor tool.
  const review = useMomentReview();
  const activeMode = modeForSplitFraction(splitFraction);

  return (
    <div
      // Hold region: pressing any control here must NOT dismiss the floating
      // moment inspector.
      data-editor-dialog-hold
      className="grid h-12 w-full shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5 border-b border-white/[0.06] bg-surface px-2.5 sm:px-3"
    >
      {/* ── Left — identity + Add + Edit ─────────────────────────────────── */}
      {/* No overflow-x-auto here: `overflow-x: auto` with no explicit overflow-y
          makes browsers force overflow-y to `auto` too, which would clip the
          absolutely-positioned dropdown panels (Add/Edit) below this row. Now
          that almost everything lives behind dropdowns, wrapping risk is low
          enough that plain `flex` (nowrap) + hidden labels at narrow widths is
          sufficient. */}
      {/* Spacing carries the grouping: gap-2 BETWEEN groups, gap-1 within one.
          The bar used to run one flat gap-1.5 through every control, which is
          what made ten buttons read as a single undifferentiated row. */}
      <div className="flex min-w-0 items-center gap-2 pr-1">
        <div className="flex shrink-0 items-center gap-2">
          <h3 className="hidden font-display text-[13px] font-semibold tracking-tight text-white sm:inline">
            Timeline
          </h3>
          <HealthDot health={health} />
        </div>

        <Divider />

        <div className="flex shrink-0 items-center gap-1">
          <AddMenu onAdd={onAdd} />
          <EditMenu
            hasSelection={hasSelection}
            onDuplicate={onDuplicate}
            canSplit={canSplit}
            onSplit={onSplit}
            onDelete={onDelete}
          />
          <LayersMenu
            rows={layerRows}
            onToggle={onToggleLayer}
            onShowAll={onShowAllLayers}
          />
        </div>

        {/* Undo / redo — the same session history the keyboard shortcuts drive.
            Bordered as a PAIR on purpose: these two circular arrows sit directly
            beside the transport's seek arrows (⏮ ↺5 ▶ ↻5), and unbordered they
            blended into them — four near-identical glyphs from two unrelated
            systems, with the disabled pair reading as broken chrome rather than
            as history that has nothing to undo yet. The enclosure ends the tool
            group cleanly and gives the transport its own air. */}
        <div className="flex h-8 shrink-0 items-center overflow-hidden rounded-lg border border-white/10 bg-white/[0.025]">
          <HistoryBtn Icon={Undo2} label="Undo" shortcut="⌘Z" disabled={!canUndo} onClick={onUndo} />
          <span aria-hidden className="h-4 w-px shrink-0 bg-white/[0.08]" />
          <HistoryBtn Icon={Redo2} label="Redo" shortcut="⌘⇧Z" disabled={!canRedo} onClick={onRedo} />
        </div>
      </div>

      {/* ── Center — the transport group stays dead-centered ────────────── */}
      <div className="flex items-center justify-center gap-1 justify-self-center sm:gap-1.5">
        <PlaybackTransport />
      </div>

      {/* ── Right — View ▾ · volume/fullscreen · ⋯ overflow ──────────────── */}
      {/* Same reasoning as the left group: no overflow-x-auto, so the
          View/Overflow dropdown panels never get vertically clipped. */}
      <div className="flex min-w-0 items-center justify-end gap-2 pl-1">
        <ViewMenu
          activeMode={activeMode}
          setSplitFraction={setSplitFraction}
          hasScenes={hasScenes}
          scenesOpen={scenesOpen}
          toggleScenes={toggleScenes}
          insightsOpen={insightsOpen}
          onToggleInsights={onToggleInsights}
        />

        <div className="flex shrink-0 items-center gap-0.5">
          <PlaybackVolumeFullscreen />
        </div>

        <OverflowMenu
          zoom={zoom}
          minZoom={minZoom}
          maxZoom={maxZoom}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
          onFit={onFit}
          review={review}
        />
      </div>
    </div>
  );
}

// ── Shared dropdown primitives ────────────────────────────────────────────
//
// Every menu in this bar opens through MenuPopover: the bar sits at the top of
// the timeline pane, and the whole editor shell is overflow-hidden, so an
// absolutely-positioned panel gets CLIPPED by the pane — its lower options
// unreachable on short windows. MenuPopover portals the panel to <body>, flips
// it above the button when it doesn't fit below, and scrolls it internally.
// Panel widths are px numbers because the placement math needs them.

/** Menu widths (px) — were `w-52` / `w-56` / `w-64`. */
const MENU_W_SM = 208;
const MENU_W_MD = 224;
const MENU_W_LG = 256;

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-fog/70">
      {children}
    </div>
  );
}

function MenuDivider() {
  return <div role="separator" className="my-1 border-t border-white/[0.07]" />;
}

function MenuItem({
  Icon,
  label,
  shortcut,
  tip,
  active,
  disabled,
  danger,
  onClick,
}: {
  Icon?: LucideIcon;
  label: string;
  shortcut?: string;
  tip?: string;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={tip}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors duration-150",
        disabled
          ? "cursor-not-allowed text-fog/40"
          : cn(
              "text-white/90 hover:bg-white/[0.06]",
              danger && "hover:bg-rose-500/10 hover:text-rose-200"
            )
      )}
    >
      {Icon && (
        <Icon
          size={14}
          className={cn("shrink-0", active ? "text-violet-300" : disabled ? "text-fog/40" : "text-fog")}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check size={13} className="shrink-0 text-violet-300" />}
      {shortcut && !active && (
        <span className="shrink-0 font-mono text-[10.5px] text-fog/60">{shortcut}</span>
      )}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="hidden h-5 w-px shrink-0 bg-white/[0.08] sm:block" />;
}

/**
 * The one height every piece of bar chrome uses (32px in a 48px bar).
 *
 * The bar previously mixed h-9 menu triggers, size-9 history buttons and a
 * pill-shaped status badge with the transport's size-9 round buttons and its
 * size-10 Play — five treatments in one row. Chrome is now uniformly h-8 and
 * the TRANSPORT keeps its larger round shape, so the primary control reads as
 * the biggest thing in the bar instead of competing with the tools around it.
 */
const BAR_CONTROL =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[11.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60";

/** Neutral (secondary) bar control — Edit, Layers, View. */
const BAR_CONTROL_NEUTRAL = cn(
  BAR_CONTROL,
  "border-white/10 bg-white/[0.025] text-white/85 hover:border-white/25 hover:bg-white/[0.06] hover:text-white"
);

// ── Layers dropdown — one show/hide switch per timeline lane ───────────────

/** One row of the Layers menu: a lane, its edit count, and its on/off state. */
export interface LayerRow {
  id: TimelineLayerId;
  label: string;
  count: number;
  visible: boolean;
  Icon: LucideIcon;
}

/**
 * ONE switch per layer (Zooms & focus, Cuts, Speed, Captions, Callouts,
 * Transitions, …). Turning one off hides every edit in that lane from preview
 * and export without touching the edits themselves.
 *
 * It lives in a menu rather than in a column beside the lanes because the
 * timeline has no gutter — that column was deliberately deleted, and a row of
 * eyes down the left would reinstate it. The trade is discoverability, which the
 * trigger buys back: it wears the hidden-layer count, so a hidden layer is
 * visible from the bar without opening anything (and the lanes themselves grey
 * out, so the timeline never silently lies about what will render).
 *
 * The menu does NOT close on toggle — hiding three layers to audition a cut is
 * one task, not three trips through a dropdown.
 */
function LayersMenu({
  rows,
  onToggle,
  onShowAll,
}: {
  rows: LayerRow[];
  onToggle: (id: TimelineLayerId, visible: boolean) => void;
  onShowAll: () => void;
}) {
  const menu = useMenuPopover();
  const { open, toggle } = menu;
  const hiddenCount = rows.filter((r) => !r.visible).length;

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Layers"
        title={
          hiddenCount > 0
            ? `Layers — ${hiddenCount} hidden and not rendering`
            : "Layers — show or hide a whole lane"
        }
        // A hidden layer still warrants amber (those edits won't render), but
        // the old filled amber chip out-shouted the violet Add button beside
        // it — the loudest thing in the bar was a passive warning, not the
        // primary action. Amber now lives in the text and border only.
        className={cn(
          BAR_CONTROL,
          hiddenCount > 0
            ? "border-amber-300/35 bg-transparent text-amber-100/90 hover:border-amber-300/60 hover:bg-amber-400/[0.06]"
            : "border-white/10 bg-white/[0.025] text-white/85 hover:border-white/25 hover:bg-white/[0.06] hover:text-white"
        )}
      >
        <Layers size={13} className="shrink-0" />
        <span className="hidden sm:inline">Layers</span>
        {hiddenCount > 0 && (
          <span className="text-[10.5px] font-semibold tabular-nums text-amber-200/90">
            {hiddenCount} off
          </span>
        )}
        <ChevronDown size={11} className="shrink-0 opacity-70" />
      </button>
      <MenuPopover state={menu} width={MENU_W_LG} ariaLabel="Layers">
        <MenuLabel>Show / hide layers</MenuLabel>
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={r.visible}
            onClick={() => onToggle(r.id, !r.visible)}
            title={
              r.visible
                ? `Hide ${r.label} — its ${r.count} edit${r.count === 1 ? "" : "s"} stay on the timeline`
                : `Show ${r.label} again`
            }
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium text-white/90 transition-colors duration-150 hover:bg-white/[0.06]"
          >
            <r.Icon
              size={14}
              className={cn("shrink-0", r.visible ? "text-fog" : "text-fog/40")}
            />
            <span className={cn("min-w-0 flex-1 truncate", !r.visible && "text-fog/50")}>
              {r.label}
            </span>
            <span
              className={cn(
                "shrink-0 font-mono text-[10.5px] tabular-nums",
                r.visible ? "text-fog/60" : "text-fog/35"
              )}
            >
              {r.count}
            </span>
            {r.visible ? (
              <Eye size={13} className="shrink-0 text-violet-300" />
            ) : (
              <EyeOff size={13} className="shrink-0 text-amber-300" />
            )}
          </button>
        ))}
        {hiddenCount > 0 && (
          <>
            <MenuDivider />
            <MenuItem
              Icon={Eye}
              label={`Show all layers (${hiddenCount} hidden)`}
              onClick={onShowAll}
            />
          </>
        )}
      </MenuPopover>
    </>
  );
}

/**
 * Icon-only undo/redo button — one half of the bordered history pair that ends
 * the left group. No radius/border of its own: the enclosure owns both.
 */
function HistoryBtn({
  Icon,
  label,
  shortcut,
  disabled,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  shortcut: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={`${label} (${shortcut})`}
      className="inline-flex size-8 shrink-0 items-center justify-center text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-400/60 disabled:pointer-events-none disabled:opacity-30"
    >
      <Icon size={14} />
    </button>
  );
}

// ── Edit dropdown — Split / Duplicate / Delete ─────────────────────────────

function EditMenu({
  hasSelection,
  onDuplicate,
  canSplit,
  onSplit,
  onDelete,
}: {
  hasSelection: boolean;
  onDuplicate: () => void;
  /** The playhead is inside the selected edit and both halves would be usable. */
  canSplit: boolean;
  onSplit: () => void;
  onDelete: () => void;
}) {
  const menu = useMenuPopover();
  const { open, toggle, close } = menu;

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Edit actions"
        title="Edit — split, duplicate, delete"
        className={BAR_CONTROL_NEUTRAL}
      >
        <Scissors size={13} className="shrink-0" />
        <span className="hidden sm:inline">Edit</span>
        <ChevronDown size={11} className="shrink-0 opacity-70" />
      </button>
      <MenuPopover state={menu} width={MENU_W_SM} ariaLabel="Edit actions">
          <MenuItem
            Icon={SplitIcon}
            label="Split"
            shortcut="S"
            tip={
              !hasSelection
                ? "Select an edit to split"
                : canSplit
                  ? "Split the selected edit at the playhead"
                  : "Move the playhead inside the edit to split it"
            }
            disabled={!hasSelection || !canSplit}
            onClick={() => {
              onSplit();
              close();
            }}
          />
          <MenuItem
            Icon={Copy}
            label="Duplicate"
            shortcut="⌘D"
            disabled={!hasSelection}
            onClick={() => {
              onDuplicate();
              close();
            }}
          />
          <MenuItem
            Icon={Trash2}
            label="Delete"
            shortcut="Del"
            disabled={!hasSelection}
            danger
            onClick={() => {
              onDelete();
              close();
            }}
          />
      </MenuPopover>
    </>
  );
}

// ── View dropdown — workspace mode / Scenes / Insights ─────────────────────

const MODE_META: { mode: WorkspaceMode; label: string; short: string; Icon: LucideIcon }[] = [
  { mode: "preview", label: "Preview mode", short: "Preview", Icon: PanelTop },
  { mode: "balanced", label: "Balanced mode", short: "Balanced", Icon: SquareSplitVertical },
  { mode: "timeline", label: "Timeline mode", short: "Timeline", Icon: PanelBottom },
];

function ViewMenu({
  activeMode,
  setSplitFraction,
  hasScenes,
  scenesOpen,
  toggleScenes,
  insightsOpen,
  onToggleInsights,
}: {
  activeMode: WorkspaceMode | null;
  setSplitFraction: (f: number) => void;
  hasScenes: boolean;
  scenesOpen: boolean;
  toggleScenes: () => void;
  insightsOpen: boolean;
  onToggleInsights: () => void;
}) {
  const menu = useMenuPopover();
  const { open, toggle, close } = menu;
  const current = MODE_META.find((m) => m.mode === activeMode);

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="View options"
        // The trigger says "View", NOT the active mode's name. It used to wear
        // the mode ("Balanced"), which collided word-for-word with the timeline
        // HEALTH badge on the other side of the same bar — two unrelated
        // meanings, one word, 1500px apart. The layout is self-evident on
        // screen (you can see which pane is larger) and the active mode is
        // check-marked inside the menu, so the label was carrying a duplicate
        // rather than information. The tooltip still names it.
        title={`View — ${current ? `${current.short} layout` : "workspace layout"}, scenes, insights`}
        className={BAR_CONTROL_NEUTRAL}
      >
        <SquareSplitVertical size={13} className="shrink-0" />
        <span className="hidden md:inline">View</span>
        <ChevronDown size={11} className="shrink-0 opacity-70" />
      </button>
      <MenuPopover state={menu} align="right" width={MENU_W_MD} ariaLabel="View options">
          <MenuLabel>Workspace layout</MenuLabel>
          {MODE_META.map(({ mode, label, Icon }) => (
            <MenuItem
              key={mode}
              Icon={Icon}
              label={label}
              active={activeMode === mode}
              onClick={() => {
                setSplitFraction(MODE_FRACTION[mode]);
                close();
              }}
            />
          ))}
          <MenuDivider />
          {hasScenes && (
            <MenuItem
              Icon={Film}
              label={scenesOpen ? "Hide scenes" : "Show scenes"}
              active={scenesOpen}
              onClick={() => {
                toggleScenes();
                close();
              }}
            />
          )}
          <MenuItem
            Icon={BarChart2}
            label={insightsOpen ? "Close Insights" : "Open Insights"}
            active={insightsOpen}
            onClick={() => {
              onToggleInsights();
              close();
            }}
          />
      </MenuPopover>
    </>
  );
}

// ── Overflow (⋯) — zoom, fit, edit review-nav, shortcuts ───────────────────

const TIPS: ReadonlyArray<readonly [string, string]> = [
  ["Drag a clip", "to move it"],
  ["Drag the edges", "to retime"],
  ["Click the lane", "to seek"],
  ["Shift / ⌘ + click", "to multi-select"],
  ["Space", "play / pause"],
  ["Del / Backspace", "remove selection"],
  ["⌘D", "duplicate"],
  ["H", "hide / show selection"],
  ["⌘Z / ⌘⇧Z", "undo / redo"],
  ["Esc", "clear multi-select"],
];

function OverflowMenu({
  zoom,
  minZoom,
  maxZoom,
  onZoomIn,
  onZoomOut,
  onFit,
  review,
}: {
  zoom: number;
  minZoom: number;
  maxZoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  review: ReturnType<typeof useMomentReview>;
}) {
  const menu = useMenuPopover();
  const { open, toggle, close } = menu;

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="More timeline options"
        title="More options — zoom, fit, edit navigation, shortcuts"
        // Chrome size (32px square), not transport size — this is a timeline
        // menu that happens to sit next to the playback icons, and matching
        // their round 36px would file it under playback.
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
      >
        <MoreHorizontal size={16} />
      </button>
      <MenuPopover state={menu} align="right" width={MENU_W_LG} ariaLabel="More timeline options">
          <MenuLabel>Timeline zoom</MenuLabel>
          <div className="flex items-center gap-1 px-1 pb-1.5">
            <IconBtn Icon={ZoomOut} label="Zoom out" tip="Zoom timeline out" onClick={onZoomOut} disabled={zoom <= minZoom} bare />
            <span className="flex-1 text-center font-mono text-[11px] tabular-nums text-fog">{zoom.toFixed(1)}×</span>
            <IconBtn Icon={ZoomIn} label="Zoom in" tip="Zoom timeline in" onClick={onZoomIn} disabled={zoom >= maxZoom} bare />
          </div>
          <MenuItem Icon={Maximize2} label="Fit timeline to screen" tip="Resets zoom to 100%" onClick={() => { onFit(); close(); }} />

          {review.total > 0 && (
            <>
              <MenuDivider />
              <MenuLabel>Navigate edits</MenuLabel>
              <div className="flex items-center gap-1 px-1 pb-1.5">
                <IconBtn Icon={ChevronLeft} label="Previous edit" tip="Previous edit" onClick={review.goPrev} disabled={!review.hasPrev} bare />
                <span className="flex-1 text-center font-mono text-[11px] tabular-nums text-fog">
                  {review.position ? `${review.position.index} of ${review.position.total}` : `${review.total} edits`}
                </span>
                <IconBtn Icon={ChevronRight} label="Next edit" tip="Next edit" onClick={review.goNext} disabled={!review.hasNext} bare />
              </div>
            </>
          )}

          <MenuDivider />
          <MenuLabel>Shortcuts</MenuLabel>
          <ul className="space-y-1 px-2.5 pb-1.5 pt-0.5 text-[11.5px]">
            {TIPS.map(([action, hint]) => (
              <li key={action} className="flex items-baseline justify-between gap-3">
                <span className="text-white/80">{action}</span>
                <span className="text-fog">{hint}</span>
              </li>
            ))}
          </ul>
      </MenuPopover>
    </>
  );
}

// ── Small shared primitives ────────────────────────────────────────────────

interface IconBtnProps {
  Icon: LucideIcon;
  label: string;
  tip: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Bare = no border/background chrome (used inside grouped pills). */
  bare?: boolean;
}

function IconBtn({ Icon, label, tip, onClick, disabled, danger, bare }: IconBtnProps) {
  if (bare) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        title={tip}
        className="inline-flex size-7 items-center justify-center rounded-md text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white disabled:pointer-events-none disabled:opacity-30"
      >
        <Icon size={13} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={tip}
      className={cn(
        "group inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.025] px-2 text-[11.5px] font-medium text-white/85 transition-all duration-150",
        "hover:border-white/25 hover:bg-white/[0.06] hover:text-white",
        danger && "hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-200",
        disabled &&
          "cursor-not-allowed opacity-35 hover:border-white/10 hover:bg-white/[0.025] hover:text-white/85"
      )}
    >
      <Icon size={13} className="shrink-0" />
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

type AddEffectSpec = { id: EffectType; label: string; Icon: LucideIcon; hint: string; group: "edit" | "overlay" };
const ADD_EFFECTS: AddEffectSpec[] = [
  { id: "zoom", label: "Zoom", Icon: Zap, hint: "Cinematic zoom into a region", group: "edit" },
  { id: "cursor-focus", label: "Focus", Icon: MousePointer2, hint: "Soft focus / cursor follow", group: "edit" },
  { id: "click-highlight", label: "Click", Icon: Target, hint: "Click highlight", group: "edit" },
  { id: "cut", label: "Cut", Icon: Scissors, hint: "Mark a dead section to remove", group: "edit" },
  { id: "speed-up", label: "Speed", Icon: FastForward, hint: "Speed up a slow stretch", group: "edit" },
  { id: "text-overlay", label: "Text overlay", Icon: Type, hint: "Positioned text label", group: "overlay" },
  { id: "hook-text", label: "Hook text", Icon: Sparkles, hint: "Big attention line", group: "overlay" },
  { id: "captions", label: "Caption", Icon: Captions, hint: "A subtitle line you type", group: "overlay" },
  { id: "callout", label: "Callout", Icon: Megaphone, hint: "Point at part of the frame", group: "overlay" },
  { id: "blur-redaction", label: "Blur", Icon: EyeOff, hint: "Hide a sensitive region", group: "overlay" },
  { id: "branding-cta", label: "CTA", Icon: BadgeCheck, hint: "End-card call to action", group: "overlay" },
  { id: "transition", label: "Transition", Icon: Shuffle, hint: "Quick fade between scenes", group: "overlay" },
  // NB: smart-crop is applied via the Canvas tool (output framing), not a
  // playhead moment, so it's intentionally not offered here.
];

function AddMenu({ onAdd }: { onAdd: (e: EffectType) => void }) {
  const menu = useMenuPopover();
  const { open, toggle, close } = menu;

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Insert a new edit at the playhead"
        // The one primary control in the left group — it keeps the violet fill
        // and a heavier weight so it stays the obvious first action.
        className={cn(
          BAR_CONTROL,
          "border-violet-400/40 bg-violet-500/15 px-2.5 font-semibold text-violet-50 hover:border-violet-400/60 hover:bg-violet-500/25"
        )}
      >
        <Plus size={13} />
        <span className="hidden sm:inline">Add</span>
        <ChevronDown size={11} className="opacity-70" />
      </button>
      {/* The tallest menu in the bar — 12 items. It's the one that made the bug
          obvious, and the one that most needs to scroll rather than be cut. */}
      <MenuPopover state={menu} width={MENU_W_SM} className="p-1" ariaLabel="Add an edit">
        {ADD_EFFECTS.map(({ id, label, Icon, hint, group }, i) => (
          <React.Fragment key={id}>
            {group === "overlay" && ADD_EFFECTS[i - 1]?.group === "edit" && (
              <div className="mx-2 my-1 border-t border-white/[0.07] pt-1 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-fog/70">
                Overlays
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                onAdd(id);
                close();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-white/[0.06]"
            >
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.05] text-violet-200 ring-1 ring-white/10">
                <Icon size={13} />
              </span>
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-white">{label}</span>
                <span className="block truncate text-[10.5px] text-fog">{hint}</span>
              </span>
            </button>
          </React.Fragment>
        ))}
      </MenuPopover>
    </>
  );
}

const HEALTH_PRESENTATION: Record<TimelineHealth, { dot: string; label: string; tooltip: string }> = {
  balanced: {
    dot: "bg-emerald-400",
    label: "Balanced",
    tooltip: "Moments are well distributed and the density looks healthy. Open Insights for the full breakdown.",
  },
  clustered: {
    dot: "bg-amber-300",
    label: "Clustered",
    tooltip: "Several moments are bunched together. Open Insights to see distribution.",
  },
  quiet: {
    dot: "bg-amber-300",
    label: "Quiet sections",
    tooltip: "Parts of the video have no detected activity. Open Insights to find them.",
  },
  empty: {
    dot: "bg-white/30",
    label: "No moments",
    tooltip: "No moments on the timeline yet.",
  },
};

/**
 * Timeline health — a READ-ONLY status line, deliberately not a pill.
 *
 * It used to wear a bordered, filled, fully-rounded badge, which is exactly the
 * chrome every clickable control in this bar wears: it read as a button that
 * did nothing when pressed. A coloured dot plus a quiet label says "status"
 * without borrowing a control's shape. The colour is never the only signal —
 * the word beside it carries the same meaning for anyone who can't use it.
 */
function HealthDot({ health }: { health: TimelineHealth }) {
  const cfg = HEALTH_PRESENTATION[health];
  return (
    <span
      title={cfg.tooltip}
      className="hidden items-center gap-1.5 text-[11.5px] font-medium text-fog md:inline-flex"
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", cfg.dot)} />
      <span>{cfg.label}</span>
    </span>
  );
}
