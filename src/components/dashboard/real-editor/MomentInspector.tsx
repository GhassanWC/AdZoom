"use client";

import * as React from "react";
import {
  Trash2,
  Sparkles,
  MousePointer2,
  Target,
  FastForward,
  Plus,
  Crosshair,
  X,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Brain,
  Crop,
  Zap,
  MoreHorizontal,
  Copy,
  Scissors,
  Captions as CaptionsIcon,
  Type as TypeIcon,
  Frame as FrameIcon,
  Megaphone,
  EyeOff,
  Shuffle,
  BadgeCheck,
} from "lucide-react";
import { useEditorReal } from "./context";
import { MenuPopover, useMenuPopover } from "./MenuPopover";
import { DirectionalPresetRow } from "./DirectionalPresetRow";
import { Slider } from "@/components/ui/Slider";
import { Toggle } from "@/components/ui/Toggle";
import { cn } from "@/lib/cn";
import { seedKeyframes, CAMERA_SPEED_DEFAULT } from "@/lib/timeline/camera";
import {
  cropBoxFor,
  outputDurationFor,
  DEFAULT_CROP,
  DEFAULT_CUT,
  DEFAULT_SPEED,
} from "@/lib/timeline/crop-speed";
import type {
  ClickHighlightSettings,
  CropAspect,
  CropPosition,
  CropSettings,
  DetectedMoment,
  EaseKind,
  EffectType,
  MomentKeyframe,
  MomentProvenance,
  SpeedAudioMode,
  SpeedSettings,
  CaptionPosition,
  OverlayTextPreset,
  HookTextPreset,
  HookPosition,
  TextOverlayPosition,
  OverlaySize,
  TextAlignment,
  TextBackgroundStyle,
  OverlayAnimation,
  CalloutStyle,
  BlurReasonType,
  TransitionStyle,
  SmartCropAspect,
  SmartCropFocus,
  BrandingPosition,
  BrandingPreset,
} from "@/lib/firebase/schema";
import {
  isMomentEnabled,
  isOverlayEffectType,
  DEFAULT_BLUR_STRENGTH,
} from "@/lib/firebase/schema";
import { isLayerVisible } from "@/lib/timeline/layers";
import { LANE_BY_ID, laneForEffectType } from "./timeline/laneModel";
import type { TextStyle } from "@/lib/firebase/schema";
import { TextStyleControls } from "./TextStyleControls";
import { resolveTextStyleValues } from "@/lib/render/text-style";
import type { TextStyleValues } from "@/lib/render/text-style";

/**
 * Moment inspector — premium creative-tool layout.
 *
 * Hierarchy (top to bottom):
 *   1. Compact header — small effect glyph, editable title, provenance dot,
 *      overflow menu. The modal owns the close button so it doesn't render
 *      twice. No subtitle, no badges, no auroras.
 *   2. Effect — segmented control + inline intensity slider. The two
 *      controls a user almost always wants to touch, in one tight block.
 *   3. Timing — single compact row of two inline-edited time chips and a
 *      duration readout. No card, no boxes, no "Seek" sub-button (clicking
 *      the chip seeks).
 *   4. Advanced — collapsed sections that are filtered by relevance to the
 *      selected effect, so a Zoom moment doesn't surface Cursor controls
 *      and a Speed-up moment doesn't surface Camera keyframes.
 *   5. AI reasoning — single collapsed section that absorbs the old
 *      "Source / confidence" block plus the AI's reason text. Most users
 *      don't want CV signal peaks while editing.
 *
 * What was removed: section icon-circle gutters, per-section card borders,
 * the "Inspector / MOTION" caption row, the redundant in-panel close button,
 * the bottom "Clear selection" footer, the gradient auroras, the always-
 * expanded Source confidence bar, and the always-expanded Cursor & focus
 * section. All editing capability remains — just less visible by default.
 */

const PROVENANCE_PRESENTATION: Record<
  MomentProvenance,
  { label: string; dot: string; chip: string; text: string }
> = {
  event: {
    label: "Real event",
    dot: "bg-emerald-400",
    chip: "bg-emerald-400/15 text-emerald-200",
    text: "Derived from a real interaction in your recording.",
  },
  cv: {
    label: "Motion",
    dot: "bg-sky-400",
    chip: "bg-sky-400/15 text-sky-200",
    text: "Inferred from on-device motion analysis.",
  },
  ai: {
    label: "AI",
    dot: "bg-violet-400",
    chip: "bg-violet-500/15 text-violet-200",
    text: "AI suggestion in a coverage gap.",
  },
  "ai-override": {
    label: "AI override",
    dot: "bg-fuchsia-400",
    chip: "bg-fuchsia-500/15 text-fuchsia-200",
    text: "AI overrode a low-confidence event candidate here.",
  },
  user: {
    label: "Yours",
    dot: "bg-amber-300",
    chip: "bg-cyan-400/15 text-cyan-200",
    text: "Created by you.",
  },
};

function provenanceOf(m: DetectedMoment): MomentProvenance {
  if (m.provenance) return m.provenance;
  if (m.source === "user") return "user";
  return "ai";
}

interface EffectSpec {
  id: EffectType;
  label: string;
  Icon: typeof Sparkles;
  /** Accent color used by the header glyph. */
  accent: string;
}

const EFFECTS: EffectSpec[] = [
  { id: "zoom", label: "Zoom", Icon: Zap, accent: "text-violet-300" },
  { id: "click-highlight", label: "Click", Icon: Target, accent: "text-fuchsia-300" },
  { id: "cursor-focus", label: "Focus", Icon: MousePointer2, accent: "text-indigo-300" },
  { id: "cut", label: "Cut", Icon: Scissors, accent: "text-rose-300" },
  { id: "crop", label: "Crop", Icon: Crop, accent: "text-teal-300" },
  { id: "speed-up", label: "Speed", Icon: FastForward, accent: "text-amber-300" },
  // Phase 3 — Core AI Edit Pack.
  { id: "captions", label: "Captions", Icon: CaptionsIcon, accent: "text-sky-300" },
  { id: "hook-text", label: "Hook", Icon: Sparkles, accent: "text-pink-300" },
  { id: "text-overlay", label: "Text", Icon: TypeIcon, accent: "text-blue-300" },
  { id: "smart-crop", label: "Smart Crop", Icon: FrameIcon, accent: "text-emerald-300" },
  { id: "callout", label: "Callout", Icon: Megaphone, accent: "text-orange-300" },
  { id: "blur-redaction", label: "Blur", Icon: EyeOff, accent: "text-slate-300" },
  { id: "transition", label: "Transition", Icon: Shuffle, accent: "text-purple-300" },
  { id: "branding-cta", label: "CTA", Icon: BadgeCheck, accent: "text-lime-300" },
];

const EFFECT_BY_ID: Record<EffectType, EffectSpec> = Object.fromEntries(
  EFFECTS.map((e) => [e.id, e])
) as Record<EffectType, EffectSpec>;

/** Switchable camera effects — the only ones offered in the compact tab row. */
const CAMERA_EFFECTS = EFFECTS.filter(
  (e) => e.id === "zoom" || e.id === "click-highlight" || e.id === "cursor-focus"
);

/** Full, readable header title per effect type (never truncated). */
const EFFECT_FULL_NAME: Record<EffectType, string> = {
  zoom: "Zoom",
  "click-highlight": "Click",
  "cursor-focus": "Focus",
  cut: "Cut",
  crop: "Crop / Reframe",
  "speed-up": "Speed",
  captions: "Captions",
  "hook-text": "Hook Text",
  "text-overlay": "Text Overlay",
  "smart-crop": "Smart Crop",
  callout: "Callout",
  "blur-redaction": "Blur / Redaction",
  transition: "Transition",
  "branding-cta": "Branding / CTA",
};

/**
 * Which advanced sections matter for which effects. Anything not listed is
 * hidden by default (still reachable via "Show all advanced" footer link
 * — see `AdvancedFooter`). Keeps the inspector calm for the common case:
 * Speed-up moments don't need Camera keyframes; Zoom moments don't need
 * cursor coordinates.
 */
const ADVANCED_RELEVANCE: Record<
  EffectType,
  { keyframes: boolean; cursor: boolean }
> = {
  zoom: { keyframes: true, cursor: false },
  "click-highlight": { keyframes: false, cursor: true },
  "cursor-focus": { keyframes: true, cursor: true },
  "speed-up": { keyframes: false, cursor: false },
  cut: { keyframes: false, cursor: false },
  crop: { keyframes: false, cursor: false },
  // Overlays with a spatial target expose the region editor (cursor:true).
  captions: { keyframes: false, cursor: false },
  "hook-text": { keyframes: false, cursor: false },
  "text-overlay": { keyframes: false, cursor: false },
  "smart-crop": { keyframes: false, cursor: true },
  callout: { keyframes: false, cursor: true },
  "blur-redaction": { keyframes: false, cursor: true },
  transition: { keyframes: false, cursor: false },
  "branding-cta": { keyframes: false, cursor: false },
};

/**
 * Previous/Next review navigation rendered in the header — supplied by the
 * moment editor dialog (which owns the review flow) so the inspector itself
 * stays a pure content component.
 */
export interface MomentReviewNav {
  /** 1-based "12 of 42" position, or null when the moment isn't in the list. */
  position: { index: number; total: number } | null;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

/**
 * What "off" actually means for this effect type. Worth spelling out: for an
 * overlay "hidden" is self-explanatory, but a disabled CUT keeps its range
 * (the footage comes back) and a disabled SPEED plays at 1× — saying only
 * "hidden" would leave the user guessing what happens to the time.
 */
function disabledHint(t: EffectType): string {
  switch (t) {
    case "cut":
      return "Off — its range is kept, nothing is removed. Still on the timeline.";
    case "speed-up":
      return "Off — this range plays at normal speed. Still on the timeline.";
    case "zoom":
    case "cursor-focus":
    case "crop":
      return "Off — the camera doesn't move here. Still on the timeline.";
    default:
      return "Hidden from preview & export — still on the timeline.";
  }
}

export function MomentInspector({ nav }: { nav?: MomentReviewNav } = {}) {
  const {
    project,
    selectedMomentId,
    activeMoment,
    updateMoment,
    deleteMoment,
    duplicateMoment,
    setMomentEnabled,
    layers,
    setLayerVisible,
    currentTime,
    duration,
    seek,
    interactions,
    interactionsLoading,
  } = useEditorReal();

  const moments = project.analysis?.detectedMoments ?? [];
  const sourceAspect =
    project.width && project.height ? project.width / project.height : 16 / 9;
  const sourceDuration = duration || project.duration || 0;
  const moment =
    moments.find((m) => m.id === selectedMomentId) || activeMoment || null;

  // Show all advanced sections — opt-in escape hatch so power users can
  // still reach Cursor controls on a Zoom moment without changing effect.
  const [showAllAdvanced, setShowAllAdvanced] = React.useState(false);

  if (!moment) {
    return <EmptyInspector hasMoments={moments.length > 0} status={project.status} />;
  }

  // This edit's LAYER (its timeline lane) — the second, coarser visibility gate.
  const layerDef = LANE_BY_ID[laneForEffectType(moment.effectType)];
  const layerVisible = isLayerVisible(layers, layerDef.id);
  const layerCount = moments.filter(
    (m) => laneForEffectType(m.effectType) === layerDef.id
  ).length;

  const effectSpec = EFFECT_BY_ID[moment.effectType];
  const relevance = ADVANCED_RELEVANCE[moment.effectType];
  const showKeyframes = showAllAdvanced || relevance.keyframes;
  const showCursor = showAllAdvanced || relevance.cursor;
  // Directional presets are only meaningful for effects whose framing the
  // user controls — Speed-up and Click highlights frame themselves (the
  // click coords) and don't need a manual camera nudge.
  const showCameraPresets =
    moment.effectType === "zoom" || moment.effectType === "cursor-focus";
  const isCrop = moment.effectType === "crop";
  const isSpeed = moment.effectType === "speed-up";
  const isCut = moment.effectType === "cut";
  const isOverlay = isOverlayEffectType(moment.effectType);
  // Crop frames a box; speed only retimes; cut removes a range; overlays have
  // their own controls — none use the zoom-intensity slider.
  const showIntensity = !isCrop && !isSpeed && !isCut && !isOverlay;
  const momentDuration = moment.endTime - moment.startTime;

  // Switching effect type seeds the matching settings so the new controls have
  // sensible defaults immediately (and the camera/timing behave at once).
  const onEffectChange = (effectType: EffectType) => {
    const patch: Partial<DetectedMoment> = { effectType };
    if (effectType === "crop" && !moment.crop) {
      patch.crop = { ...DEFAULT_CROP };
      patch.focusRegion = cropBoxFor(
        DEFAULT_CROP.aspectRatio,
        DEFAULT_CROP.position,
        DEFAULT_CROP.scale,
        sourceAspect
      );
      patch.targetRegionSource = "user";
    }
    if (effectType === "speed-up" && !moment.speed) patch.speed = { ...DEFAULT_SPEED };
    updateMoment(moment.id, patch);
  };

  return (
    // No own surface — the floating dialog provides the solid background,
    // border + shadow. Keeping this transparent avoids a translucent
    // card-on-panel "washed out" look.
    <div>
      {/* ── Compact header ─────────────────────────────────────────────── */}
      <Header
        moment={moment}
        effectSpec={effectSpec}
        nav={nav}
        onTitleChange={(label) => updateMoment(moment.id, { label })}
        onDuplicate={() => duplicateMoment(moment.id)}
        onDelete={() => deleteMoment(moment.id)}
      />

      {/* ── Body — two columns on desktop (effect controls | status/timing/AI),
             one column when narrow. ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-x-7 gap-y-4 px-4 pb-4 pt-3 sm:px-5 lg:grid-cols-[1.55fr_1fr]">
        {/* ══ LEFT — primary effect settings ══ */}
        <div className="min-w-0 space-y-4">
        {/* Effect type switcher — only for the camera effects (zoom/focus/
            click). Crop + Speed have their own tracks/tools, so the dialog
            shows their settings directly instead of a 5-tab row that overflows.
            The whole section only exists for camera effects — an empty section
            would add stray spacing for crop/speed/cut/overlay moments. */}
        {!isCrop && !isSpeed && !isCut && !isOverlay && (
          <section className="space-y-3">
            <SegmentedEffect value={moment.effectType} onChange={onEffectChange} />
            {showCameraPresets && (
              <DirectionalPresetRow
                moment={moment}
                interactions={interactions}
                interactionsLoading={interactionsLoading}
                onUpdate={(patch) => updateMoment(moment.id, patch)}
              />
            )}
            {showIntensity && (
              <Slider
                label={`${effectSpec.label} intensity`}
                value={Math.round((moment.intensity ?? 1) * 100)}
                min={20}
                max={150}
                onChange={(v) => updateMoment(moment.id, { intensity: v / 100 })}
              />
            )}
            {/* The settings that used to live in the global Effects panel — now
                per-edit, and only the ones this edit actually has. */}
            <EffectMotionControls
              moment={moment}
              onUpdate={(patch) => updateMoment(moment.id, patch)}
            />
          </section>
        )}

        {/* Crop / Reframe controls — only for crop moments. */}
        {isCrop && (
          <CropControls
            moment={moment}
            sourceAspect={sourceAspect}
            onUpdate={(patch) => updateMoment(moment.id, patch)}
          />
        )}

        {/* Speed controls — only for speed moments. */}
        {isSpeed && (
          <SpeedControls
            moment={moment}
            allMoments={moments}
            sourceDuration={sourceDuration}
            onUpdate={(patch) => updateMoment(moment.id, patch)}
          />
        )}

        {/* Cut controls — only for cut moments. */}
        {isCut && (
          <CutControls
            moment={moment}
            onUpdate={(patch) => updateMoment(moment.id, patch)}
          />
        )}

        {/* Phase-3 overlay controls — captions / hook / text / callout / blur /
            transition / branding / smart-crop. (Enabled toggles live in the
            right column with the rest of the status controls.) */}
        {isOverlay && (
          <OverlayControls
            moment={moment}
            onUpdate={(patch) => updateMoment(moment.id, patch)}
          />
        )}
        </div>

        {/* ══ RIGHT — status, timing, advanced, AI reasoning ══ */}
        <div className="min-w-0 space-y-4">

        {/* Non-destructive enable/disable — EVERY edit type, not just overlays.
            A hidden edit stays on the timeline and stays editable; it simply
            renders nothing. `setMomentEnabled` (not `updateMoment`) so the
            toggle is its own undo step and doesn't stamp the edit as user-tuned. */}
        <section className="space-y-3">
          <Toggle
            label="Enabled"
            description={
              moment.enabled === false
                ? disabledHint(moment.effectType)
                : "Shown in preview & export."
            }
            checked={moment.enabled !== false}
            onChange={(v) => void setMomentEnabled(moment.id, v)}
          />
          {/* This edit's LAYER — the same switch the timeline's Layers menu owns,
              surfaced here because "hide every caption" is a thought you have
              while looking at a caption. It hides the lane WITHOUT touching any
              edit in it (including the toggle above), so turning it back on
              restores them exactly. */}
          {layerCount > 1 && (
            <Toggle
              label={`${layerDef.label} layer (${layerCount})`}
              description={
                layerVisible
                  ? "Hide every edit in this lane at once — they stay on the timeline, unchanged."
                  : "The whole lane is hidden. Its edits are untouched — turn this on to bring them all back."
              }
              checked={layerVisible}
              onChange={(v) => void setLayerVisible(layerDef.id, v)}
            />
          )}
        </section>

        {/* Timing — single row, no boxes, click-to-seek chips. */}
        <TimingRow
          moment={moment}
          duration={momentDuration}
          onStartChange={(v) => updateMoment(moment.id, { startTime: Math.max(0, v) })}
          onEndChange={(v) =>
            updateMoment(moment.id, {
              endTime: Math.max(moment.startTime + 0.1, v),
            })
          }
          onSeek={seek}
        />

        {/* ── Advanced ───────────────────────────────────────────────────
            Soft separator instead of a hard divider. Sections are
            individually collapsible and only the ones relevant to the
            selected effect render by default. */}
        <div className="space-y-1 pt-1">
          {showKeyframes && (
            <CompactSection
              title="Camera keyframes"
              meta={
                (moment.keyframes?.length ?? 0) > 0
                  ? `${moment.keyframes!.length} keyframes`
                  : "Static focus"
              }
            >
              <KeyframeEditor
                moment={moment}
                currentTime={currentTime}
                onChange={(keyframes) => updateMoment(moment.id, { keyframes })}
                onSeek={seek}
              />
            </CompactSection>
          )}

          {showCursor && (
            <CompactSection title="Cursor & focus" meta="Where the camera looks">
              <FocusRegionEditor
                moment={moment}
                onChange={(fr) =>
                  // Numeric edits in the inspector are an explicit user
                  // choice — stamp the source so the balancer's refinement
                  // pass leaves this region alone on subsequent re-analyze.
                  updateMoment(moment.id, {
                    focusRegion: fr,
                    targetRegionSource: "user",
                  })
                }
              />
            </CompactSection>
          )}

          {/* Power-user escape hatch — show all advanced sections regardless
              of effect relevance. Tiny footer link, intentionally quiet. */}
          {!(showKeyframes && showCursor) && (
            <button
              type="button"
              onClick={() => setShowAllAdvanced((v) => !v)}
              className="block w-full pt-1.5 text-left text-[11px] text-fog/80 transition-colors duration-150 hover:text-white"
            >
              {showAllAdvanced ? "Hide" : "Show all advanced controls"}
            </button>
          )}
        </div>

        {/* AI reasoning — always visible for the review workflow, but ONLY for
            AI/CV/event-derived moments: user-created edits have no analysis
            reasoning, and the fallback confidence (0.5) would read as a
            fabricated "50/100" score. */}
        {provenanceOf(moment) !== "user" && (
          <section className="space-y-2 pt-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
              AI reasoning
            </h3>
            <AiReasoningSection moment={moment} />
          </section>
        )}
        </div>
      </div>
    </div>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────

function Header({
  moment,
  effectSpec,
  nav,
  onTitleChange,
  onDuplicate,
  onDelete,
}: {
  moment: DetectedMoment;
  effectSpec: EffectSpec;
  nav?: MomentReviewNav;
  onTitleChange: (s: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const prov = PROVENANCE_PRESENTATION[provenanceOf(moment)];
  return (
    // `pr-12` reserves space for the settings-dialog ✕ button (absolute,
    // top-right). Bottom border separates the header from the body now that
    // the dialog (not a glass card) owns the surface.
    <div className="flex items-center gap-2.5 border-b border-white/[0.06] py-3 pl-4 pr-12 sm:pl-5">
      <span
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.03] ring-1 ring-white/10",
          effectSpec.accent
        )}
        aria-label={`${effectSpec.label} moment`}
      >
        <effectSpec.Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        {/* Full effect-type title — short, always readable (no truncation). */}
        <div className="truncate font-display text-[15px] font-semibold leading-tight text-white">
          {EFFECT_FULL_NAME[moment.effectType]}
        </div>
        {/* Editable label as a quiet subtitle (rename without stealing the title). */}
        <input
          value={moment.label}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Add a label…"
          className="-mx-1 mt-0.5 block w-full truncate rounded px-1 py-0.5 text-[11.5px] leading-tight text-fog outline-none transition-colors duration-150 placeholder:text-fog/50 focus:bg-white/[0.05] focus:text-white"
        />
      </div>
      {/* Previous / Next edit review — walk every timeline edit without
          closing the dialog; content swaps in place. */}
      {nav && nav.position && (
        <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
          <button
            type="button"
            onClick={nav.onPrev}
            disabled={!nav.hasPrev}
            aria-label="Previous edit"
            title="Previous edit"
            className={HEADER_NAV_BTN}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="min-w-14 px-0.5 text-center font-mono text-[11px] tabular-nums text-fog">
            {nav.position.index} of {nav.position.total}
          </span>
          <button
            type="button"
            onClick={nav.onNext}
            disabled={!nav.hasNext}
            aria-label="Next edit"
            title="Next edit"
            className={HEADER_NAV_BTN}
          >
            <ChevronRight size={14} />
          </button>
        </span>
      )}
      <span
        title={prov.text}
        className="inline-flex shrink-0 items-center gap-1.5 text-[10.5px] text-fog"
      >
        <span className={cn("size-1.5 rounded-full", prov.dot)} />
        {prov.label}
      </span>
      <OverflowMenu onDuplicate={onDuplicate} onDelete={onDelete} />
    </div>
  );
}

const HEADER_NAV_BTN =
  "inline-flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-fog transition-colors duration-150 hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:pointer-events-none disabled:opacity-35";

function OverflowMenu({
  onDuplicate,
  onDelete,
}: {
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  // Portalled + fixed (MenuPopover), like every other menu in the editor: the
  // inspector floats inside an overflow-hidden shell, so an absolutely-placed
  // panel could be clipped by it near the bottom of the window.
  const menu = useMenuPopover();
  const { open, toggle, close } = menu;

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={toggle}
        aria-label="Moment actions"
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "inline-flex size-8 items-center justify-center rounded-lg text-fog transition-colors duration-150",
          open
            ? "bg-white/[0.06] text-white"
            : "hover:bg-white/[0.04] hover:text-white"
        )}
      >
        <MoreHorizontal size={14} />
      </button>
      <MenuPopover
        state={menu}
        align="right"
        width={176}
        className="p-1"
        ariaLabel="Moment actions"
      >
        <MenuItem
          onClick={() => {
            close();
            onDuplicate();
          }}
          Icon={Copy}
          label="Duplicate"
          hint="⌘D"
        />
        <MenuItem
          onClick={() => {
            close();
            onDelete();
          }}
          Icon={Trash2}
          label="Delete"
          hint="Del"
          tone="danger"
        />
      </MenuPopover>
    </>
  );
}

function MenuItem({
  Icon,
  label,
  hint,
  tone,
  onClick,
}: {
  Icon: typeof Sparkles;
  label: string;
  hint?: string;
  tone?: "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-white/85 transition-colors duration-150 hover:bg-white/[0.06] hover:text-white",
        tone === "danger" && "hover:bg-rose-500/10 hover:text-rose-200"
      )}
    >
      <Icon size={12} className="shrink-0 opacity-80" />
      <span className="flex-1">{label}</span>
      {hint && (
        <span className="font-mono text-[10px] text-fog/70">{hint}</span>
      )}
    </button>
  );
}

// ─── Segmented effect ────────────────────────────────────────────────────

function SegmentedEffect({
  value,
  onChange,
}: {
  value: EffectType;
  onChange: (e: EffectType) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Effect type"
      className="inline-flex w-full items-center rounded-lg border border-white/[0.08] bg-white/[0.02] p-1"
    >
      {CAMERA_EFFECTS.map((e) => {
        const active = value === e.id;
        return (
          <button
            key={e.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(e.id)}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150",
              active
                ? "bg-white/[0.06] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                : "text-fog hover:text-white"
            )}
          >
            <e.Icon size={12} className={cn(active && e.accent)} />
            <span>{e.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Timing ──────────────────────────────────────────────────────────────

/**
 * Compact timing row. Replaces the two boxed number inputs with a single
 * line: click-to-seek time chips with inline editing on focus, plus a
 * duration readout on the right. No headers, no "Seek" sub-buttons — the
 * chip is the seek affordance.
 */
function TimingRow({
  moment,
  duration,
  onStartChange,
  onEndChange,
  onSeek,
}: {
  moment: DetectedMoment;
  duration: number;
  onStartChange: (v: number) => void;
  onEndChange: (v: number) => void;
  onSeek: (t: number) => void;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-fog">
          Timing
        </span>
        <span className="font-mono text-[10.5px] tabular-nums text-fog">
          {duration.toFixed(1)}s
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[12.5px]">
        <TimeChip
          value={moment.startTime}
          onChange={onStartChange}
          onSeek={() => onSeek(moment.startTime)}
          label="Start"
        />
        <span className="text-fog/60">→</span>
        <TimeChip
          value={moment.endTime}
          onChange={onEndChange}
          onSeek={() => onSeek(moment.endTime)}
          label="End"
        />
      </div>
    </section>
  );
}

/**
 * Inline-edited time chip. Renders as a clickable mm:ss.t button by default
 * (clicking seeks to that time). Double-click promotes it to a focused
 * number input so the user can type a precise second value.
 */
function TimeChip({
  value,
  onChange,
  onSeek,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  onSeek: () => void;
  label: string;
}) {
  const [editing, setEditing] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        step={0.1}
        min={0}
        defaultValue={value.toFixed(2)}
        aria-label={`${label} (seconds)`}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v)) onChange(v);
            setEditing(false);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        className="h-7 w-20 rounded-md border border-violet-400/40 bg-white/[0.04] px-2 font-mono text-[12px] text-white outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={onSeek}
      onDoubleClick={() => setEditing(true)}
      title={`Click to seek · double-click to edit · ${label}`}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-transparent bg-white/[0.025] px-2 font-mono text-[12px] tabular-nums text-white/90 transition-colors duration-150 hover:border-white/15 hover:bg-white/[0.05]"
    >
      {fmt(value)}
    </button>
  );
}

// ─── AI reasoning (replaces old SourceSection block) ────────────────────

function AiReasoningSection({ moment }: { moment: DetectedMoment }) {
  const p = provenanceOf(moment);
  const pres = PROVENANCE_PRESENTATION[p];
  const conf = moment.confidenceScore ?? moment.attentionScore ?? 0.5;
  return (
    <div className="space-y-3">
      {/* Confidence bar — slim, no card border. */}
      <div>
        <div className="mb-1 flex items-center gap-2 text-[11px] text-fog">
          <Brain size={11} className="text-violet-300" />
          <span className="text-white/85">{pres.label}</span>
          <span className="ml-auto font-mono tabular-nums text-fog/85">
            {(conf * 100).toFixed(0)}/100
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.05]">
          <div
            className={cn("h-full rounded-full", pres.dot)}
            style={{ width: `${Math.round(conf * 100)}%` }}
          />
        </div>
      </div>

      {/* Why the AI picked this beat. */}
      {moment.reason && (
        <p className="text-[12.5px] leading-relaxed text-white/80">
          {moment.reason}
        </p>
      )}

      {/* Confidence reason / source / event count — tiny mono lines so they
          don't compete with the main reason text. */}
      {(moment.confidenceReason ||
        moment.confidenceSource ||
        (moment.eventIds && moment.eventIds.length > 0)) && (
        <div className="space-y-0.5 text-[11px] text-fog">
          {moment.confidenceReason && <p>{moment.confidenceReason}</p>}
          {moment.confidenceSource && (
            <p className="font-mono uppercase tracking-wider text-white/40">
              {moment.confidenceSource}
            </p>
          )}
          {moment.eventIds && moment.eventIds.length > 0 && (
            <p className="font-mono tabular-nums text-white/40">
              {moment.eventIds.length} event
              {moment.eventIds.length === 1 ? "" : "s"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────

// ─── Generic segmented control (crop/speed option rows) ───────────────────

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fog">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn(
          "flex w-full flex-wrap items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-1",
          disabled && "pointer-events-none opacity-45"
        )}
      >
        {options.map((o) => {
          const active = value === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(o.id)}
              className={cn(
                "inline-flex flex-1 items-center justify-center whitespace-nowrap rounded-md px-2 py-1.5 text-[11.5px] font-medium transition-colors duration-150",
                active
                  ? "bg-white/[0.07] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                  : "text-fog hover:text-white"
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function fmtClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

// ─── Crop / Reframe controls ───────────────────────────────────────────────

const CROP_ASPECTS: { id: CropAspect; label: string }[] = [
  { id: "original", label: "Original" },
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
  { id: "1:1", label: "1:1" },
  { id: "4:5", label: "4:5" },
  { id: "custom", label: "Custom" },
];
const CROP_POSITIONS: { id: CropPosition; label: string }[] = [
  { id: "center", label: "Center" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "top", label: "Top" },
  { id: "bottom", label: "Bottom" },
];
const CROP_EASINGS: { id: CropSettings["easing"]; label: string }[] = [
  { id: "instant", label: "Instant" },
  { id: "ease-in-out", label: "Smooth" },
  { id: "ease-in", label: "Ease in" },
  { id: "ease-out", label: "Ease out" },
];

// ─── Per-edit effect settings (was the global Effects panel) ────────────────

const CLICK_STYLES: ClickHighlightSettings["style"][] = ["ring", "pulse", "burst"];

/**
 * The motion + look settings for THIS edit.
 *
 * These used to be project-global sliders in an Effects panel, which meant
 * "make this one zoom snappier" was not a thing you could ask for — you could
 * only change every zoom in the video at once. They live on the selected edit
 * now, and each one is rendered ONLY for the effect type it actually applies to:
 *
 *   zoom / cursor-focus  → camera speed (the ramp in and out)
 *   click-highlight      → style, size, and whether this click shows at all
 *
 * The project's `effectsSettings` survive as the DEFAULTS these fall back to —
 * that's what a Look applies — so an edit the user hasn't touched still follows
 * the project's look, and one they have touched keeps its own.
 */
function EffectMotionControls({
  moment,
  onUpdate,
}: {
  moment: DetectedMoment;
  onUpdate: (patch: Partial<DetectedMoment>) => void;
}) {
  const { project } = useEditorReal();
  const effects = project.effectsSettings;

  if (moment.effectType === "zoom" || moment.effectType === "cursor-focus") {
    const speed = moment.cameraMotion?.speed ?? CAMERA_SPEED_DEFAULT;
    return (
      <div className="space-y-1.5">
        <Slider
          label="Camera speed"
          value={speed}
          min={0}
          max={100}
          onChange={(v) => onUpdate({ cameraMotion: { speed: v } })}
        />
        <p className="text-[11px] leading-relaxed text-fog/70">
          {speed >= 75
            ? "Snaps into frame — punchy, good for fast social cuts."
            : speed <= 25
              ? "Glides in slowly — cinematic, needs a longer edit to breathe."
              : "How quickly the camera moves into this edit and back out again."}
        </p>
      </div>
    );
  }

  if (moment.effectType === "click-highlight") {
    const style = moment.clickHighlight?.style ?? effects.clickHighlightStyle;
    const size = moment.clickHighlight?.size ?? effects.clickHighlightSize;
    // No show/hide toggle here: `enabled` is universal now, and the inspector's
    // own "Enabled" toggle (right column) owns it for every effect type.
    return (
      <div className="space-y-3">
        <div>
          <div className="mb-2 text-xs font-medium text-fog">Style</div>
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
            {CLICK_STYLES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onUpdate({ clickHighlight: { ...moment.clickHighlight, style: s } })}
                className={cn(
                  "rounded-md px-2 py-2 text-xs font-medium capitalize transition-colors duration-150",
                  style === s
                    ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/30"
                    : "text-fog hover:bg-white/[0.04] hover:text-white"
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <Slider
          label="Highlight size"
          value={size}
          min={0}
          max={100}
          onChange={(v) => onUpdate({ clickHighlight: { ...moment.clickHighlight, size: v } })}
        />
      </div>
    );
  }

  return null;
}

function CropControls({
  moment,
  sourceAspect,
  onUpdate,
}: {
  moment: DetectedMoment;
  sourceAspect: number;
  onUpdate: (patch: Partial<DetectedMoment>) => void;
}) {
  const crop = moment.crop ?? DEFAULT_CROP;
  // Apply a settings patch; when `recompute` and the box is preset-driven,
  // reshape `focusRegion` from the (aspect, position, scale).
  const apply = (patch: Partial<CropSettings>, recompute: boolean) => {
    const next = { ...crop, ...patch };
    const out: Partial<DetectedMoment> = { crop: next };
    if (recompute && next.position !== "custom" && next.aspectRatio !== "custom") {
      out.focusRegion = cropBoxFor(
        next.aspectRatio,
        next.position,
        next.scale,
        sourceAspect
      );
      out.targetRegionSource = "user";
    }
    onUpdate(out);
  };
  return (
    <section className="space-y-3 rounded-xl border border-teal-400/15 bg-teal-500/[0.04] p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-teal-200">
          Crop / Reframe
        </span>
        <button
          type="button"
          onClick={() => apply({ ...DEFAULT_CROP }, true)}
          className="text-[11px] font-medium text-fog transition-colors hover:text-white"
        >
          Reset crop
        </button>
      </div>
      <Segmented
        label="Aspect ratio"
        value={crop.aspectRatio}
        options={CROP_ASPECTS}
        onChange={(v) =>
          apply(
            {
              aspectRatio: v,
              ...(v !== "custom" && crop.position === "custom"
                ? { position: "center" as CropPosition }
                : {}),
            },
            true
          )
        }
      />
      <Slider
        label="Scale / zoom"
        value={Math.round((crop.scale ?? 1) * 100)}
        min={100}
        max={400}
        onChange={(v) => apply({ scale: v / 100 }, true)}
      />
      <Segmented
        label="Position"
        value={crop.position}
        options={CROP_POSITIONS}
        onChange={(v) => apply({ position: v }, true)}
      />
      <Segmented
        label="Easing"
        value={crop.easing}
        options={CROP_EASINGS}
        onChange={(v) => apply({ easing: v }, false)}
      />
      <div className="space-y-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fog">
          Crop box
        </span>
        <FocusRegionEditor
          moment={moment}
          onChange={(fr) =>
            onUpdate({
              focusRegion: fr,
              targetRegionSource: "user",
              crop: { ...crop, position: "custom" },
            })
          }
        />
      </div>
      <p className="text-[10.5px] leading-relaxed text-fog/70">
        Applied during preview &amp; export — your source video is never
        modified. AI crop/reframe suggestions coming soon.
      </p>
    </section>
  );
}

// ─── Speed controls ────────────────────────────────────────────────────────

const SPEED_MULTS = [1.25, 1.5, 2, 3, 4];
const SPEED_AUDIO: { id: SpeedAudioMode; label: string }[] = [
  { id: "mute", label: "Mute" },
  { id: "keep", label: "Keep" },
  { id: "pitch-correct", label: "Pitch fix" },
];

function SpeedControls({
  moment,
  allMoments,
  sourceDuration,
  onUpdate,
}: {
  moment: DetectedMoment;
  allMoments: DetectedMoment[];
  sourceDuration: number;
  onUpdate: (patch: Partial<DetectedMoment>) => void;
}) {
  const speed = moment.speed ?? DEFAULT_SPEED;
  const set = (patch: Partial<SpeedSettings>) =>
    onUpdate({ speed: { ...speed, ...patch } });
  const secDur = Math.max(0, moment.endTime - moment.startTime);
  const secOut = secDur / Math.max(1, speed.multiplier);
  const projOut = outputDurationFor(allMoments, sourceDuration);
  return (
    <section className="space-y-3 rounded-xl border border-amber-400/15 bg-amber-500/[0.04] p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-200">
          Speed
        </span>
        <button
          type="button"
          onClick={() => set({ ...DEFAULT_SPEED })}
          className="text-[11px] font-medium text-fog transition-colors hover:text-white"
        >
          Reset speed
        </button>
      </div>
      <div className="space-y-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fog">
          Speed multiplier
        </span>
        <div className="flex w-full items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-1">
          {SPEED_MULTS.map((mlt) => {
            const active = Math.abs(speed.multiplier - mlt) < 0.001;
            return (
              <button
                key={mlt}
                type="button"
                onClick={() => set({ multiplier: mlt })}
                className={cn(
                  "inline-flex flex-1 items-center justify-center rounded-md px-2 py-1.5 text-[11.5px] font-semibold tabular-nums transition-colors duration-150",
                  active
                    ? "bg-white/[0.07] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                    : "text-fog hover:text-white"
                )}
              >
                {mlt}×
              </button>
            );
          })}
        </div>
      </div>
      <Slider
        label="Custom multiplier"
        value={Math.round(speed.multiplier * 100)}
        min={110}
        max={800}
        onChange={(v) => set({ multiplier: Math.round(v) / 100 })}
      />
      <div className="space-y-1 rounded-lg bg-black/20 p-2.5">
        <div className="flex items-center justify-between text-[11.5px]">
          <span className="text-fog">This section</span>
          <span className="font-mono tabular-nums text-white">
            {secDur.toFixed(1)}s → {secOut.toFixed(1)}s
          </span>
        </div>
        <div className="flex items-center justify-between text-[11.5px]">
          <span className="text-fog">Project output</span>
          <span className="font-mono tabular-nums text-white">
            {fmtClock(projOut)}
          </span>
        </div>
      </div>
      <Segmented
        label="Audio handling"
        value={speed.audioMode}
        options={SPEED_AUDIO}
        onChange={(v) => set({ audioMode: v })}
      />
      <Segmented
        label="Transition"
        value={speed.transition}
        options={[
          { id: "cut", label: "Hard cut" },
          { id: "ramp", label: "Smooth ramp (soon)" },
        ]}
        onChange={(v) => set({ transition: v })}
        disabled
      />
      <p className="text-[10.5px] leading-relaxed text-fog/70">
        Speed changes preview playback and the exported video duration. AI
        speed suggestions coming soon.
      </p>
    </section>
  );
}

/**
 * Cut controls — a removed time range. The user can Restore (keep the range,
 * dim the cut) or re-apply it; adjust the range via the timeline drag handles;
 * Delete it from the overflow menu. NOTE: cuts are timeline-only suggestions in
 * this iteration — they don't yet shorten preview/export.
 */
function CutControls({
  moment,
  onUpdate,
}: {
  moment: DetectedMoment;
  onUpdate: (patch: Partial<DetectedMoment>) => void;
}) {
  // A cut has TWO independent off-switches and either one keeps the range: the
  // universal Enabled toggle (every edit type has it, right column) and this
  // panel's own Restore affordance. So this panel must report the EFFECTIVE
  // state — a hidden cut that still says "Removed / Cut active" would be lying
  // about what the export does.
  const active = moment.cut?.active !== false;
  const hidden = !isMomentEnabled(moment);
  const applied = active && !hidden;
  const removed = Math.max(0, moment.endTime - moment.startTime);
  return (
    <section className="space-y-3 rounded-xl border border-rose-400/15 bg-rose-500/[0.04] p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-rose-200">
          Cut
        </span>
        <span
          className={cn(
            "text-[11px] font-medium",
            applied ? "text-rose-200" : "text-fog"
          )}
        >
          {hidden ? "Hidden (kept)" : active ? "Removed" : "Restored (kept)"}
        </span>
      </div>
      <Toggle
        label="Cut active"
        description={
          hidden
            ? "This edit is hidden, so the range plays either way — switch Enabled back on to apply this."
            : active
              ? "Removed from preview + export — output is shorter."
              : "Restored — the range plays and exports normally."
        }
        checked={active}
        onChange={(v) => onUpdate({ cut: { active: v } })}
      />
      <div className="flex items-center justify-between rounded-lg bg-black/20 p-2.5 text-[11.5px]">
        <span className="text-fog">{applied ? "Removes" : "Would remove"}</span>
        <span className="font-mono tabular-nums text-white">
          {removed.toFixed(removed < 10 ? 1 : 0)}s
        </span>
      </div>
      <p className="text-[10.5px] leading-relaxed text-fog/70">
        {moment.reason || "Suggested cut."} Drag the handles to adjust the range,
        or delete it from the ⋯ menu above.
      </p>
    </section>
  );
}

// ─── Phase-3 overlay controls ──────────────────────────────────────────────

// Style presets, positions, sizes, alignment, and backgrounds for text edits
// are now handled by the shared <TextStyleControls>; only the type-specific,
// non-styling option arrays remain here (animation, callout shape, etc.).
const ANIM_OPTS: { id: OverlayAnimation; label: string }[] = [
  { id: "none", label: "None" },
  { id: "fade", label: "Fade" },
  { id: "pop", label: "Pop" },
  { id: "slide", label: "Slide" },
];
const CALLOUT_STYLE_OPTS: { id: CalloutStyle; label: string }[] = [
  { id: "box", label: "Box" },
  { id: "circle", label: "Circle" },
  { id: "arrow", label: "Arrow" },
  { id: "spotlight", label: "Spotlight" },
  { id: "underline", label: "Underline" },
];
const BLUR_REASON_OPTS: { id: BlurReasonType; label: string }[] = [
  { id: "sensitive_info", label: "Sensitive" },
  { id: "face", label: "Face" },
  { id: "manual", label: "Manual" },
  { id: "ai_detected", label: "AI" },
];
const TRANSITION_STYLE_OPTS: { id: TransitionStyle; label: string }[] = [
  { id: "fade", label: "Fade" },
  { id: "flash", label: "Flash" },
  { id: "smooth_cut", label: "Smooth" },
  { id: "zoom", label: "Zoom" },
  { id: "swipe", label: "Swipe" },
];
const SMARTCROP_ASPECT_OPTS: { id: SmartCropAspect; label: string }[] = [
  { id: "original", label: "Original" },
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
  { id: "1:1", label: "1:1" },
];
const SMARTCROP_FOCUS_OPTS: { id: SmartCropFocus; label: string }[] = [
  { id: "center", label: "Center" },
  { id: "face", label: "Face" },
  { id: "motion", label: "Motion" },
  { id: "screen_action", label: "Action" },
  { id: "manual", label: "Manual" },
];
const CTA_POS_OPTS: { id: BrandingPosition; label: string }[] = [
  { id: "bottom-right", label: "Right" },
  { id: "bottom-center", label: "Center" },
  { id: "bottom-left", label: "Left" },
];

function TextField({
  label,
  value,
  placeholder,
  multiline,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onChange: (v: string) => void;
}) {
  const cls =
    "w-full rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 py-1.5 text-[12.5px] text-white outline-none transition-colors placeholder:text-fog/50 focus:border-violet-400/50";
  return (
    <div className="space-y-1.5">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fog">{label}</span>
      {multiline ? (
        <textarea
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={cn(cls, "resize-none")}
        />
      ) : (
        <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={cls} />
      )}
    </div>
  );
}

const OVERLAY_ACCENT: Partial<Record<EffectType, string>> = {
  captions: "border-sky-400/15 bg-sky-500/[0.04] text-sky-200",
  "hook-text": "border-pink-400/15 bg-pink-500/[0.04] text-pink-200",
  "text-overlay": "border-blue-400/15 bg-blue-500/[0.04] text-blue-200",
  "smart-crop": "border-emerald-400/15 bg-emerald-500/[0.04] text-emerald-200",
  callout: "border-orange-400/15 bg-orange-500/[0.04] text-orange-200",
  "blur-redaction": "border-slate-400/15 bg-slate-500/[0.06] text-slate-200",
  transition: "border-purple-400/15 bg-purple-500/[0.04] text-purple-200",
  "branding-cta": "border-lime-400/15 bg-lime-500/[0.04] text-lime-200",
};

/**
 * Editing controls for every Phase-3 overlay effect. Each reads its optional
 * settings bag (with safe defaults) and patches it through `onUpdate`. Spatial
 * types (callout / blur / smart-crop) additionally use the shared
 * `FocusRegionEditor` (surfaced via ADVANCED_RELEVANCE.cursor).
 */
function OverlayControls({
  moment,
  onUpdate,
}: {
  moment: DetectedMoment;
  onUpdate: (patch: Partial<DetectedMoment>) => void;
}) {
  const accent = OVERLAY_ACCENT[moment.effectType] ?? "border-white/10 bg-white/[0.03] text-white";
  const shell = cn("space-y-3 rounded-xl border p-3", accent);
  const heading = (
    <span className="text-[11px] font-semibold uppercase tracking-[0.14em]">
      {EFFECT_FULL_NAME[moment.effectType]}
    </span>
  );

  // Shared text-styling wiring — used by every text-based overlay. The controls
  // read the fully-resolved values (defaults ← legacy preset ← textStyle) and
  // write PARTIAL patches so a moment stores only what the user changed.
  const styleValues = resolveTextStyleValues(moment);
  const onStyle = (patch: Partial<TextStyle>) =>
    onUpdate({ textStyle: { ...(moment.textStyle ?? {}), ...patch } });

  if (moment.effectType === "captions") {
    const c = moment.captions ?? { text: "", stylePreset: "clean" as OverlayTextPreset, position: "bottom" as CaptionPosition };
    const set = (patch: Partial<typeof c>) => onUpdate({ captions: { ...c, ...patch } });
    return (
      <section className={shell}>
        {heading}
        <TextField label="Caption text" value={c.text} multiline placeholder="Caption line…" onChange={(text) => set({ text })} />
        <TextStyleControls style={styleValues} onChange={onStyle} />
        <ApplyToAllCaptions style={styleValues} />
        {!(c.words && c.words.length) && (
          <p className="text-[10.5px] leading-relaxed text-fog/70">
            No transcript is available, so captions aren&apos;t auto-generated. Type a line here — it renders in the preview + export.
          </p>
        )}
      </section>
    );
  }

  if (moment.effectType === "hook-text") {
    const h = moment.hookText ?? { text: "", stylePreset: "bold" as HookTextPreset, position: "center" as HookPosition, animation: "pop" as OverlayAnimation };
    const set = (patch: Partial<typeof h>) => onUpdate({ hookText: { ...h, ...patch } });
    return (
      <section className={shell}>
        {heading}
        <TextField label="Hook text" value={h.text} placeholder="Watch this…" onChange={(text) => set({ text })} />
        <Segmented label="Animation" value={h.animation} options={ANIM_OPTS} onChange={(animation) => set({ animation })} />
        <TextStyleControls style={styleValues} onChange={onStyle} />
      </section>
    );
  }

  if (moment.effectType === "text-overlay") {
    const tOv = moment.textOverlay ?? {
      text: "",
      position: "bottom-center" as TextOverlayPosition,
      size: "medium" as OverlaySize,
      alignment: "center" as TextAlignment,
      backgroundStyle: "pill" as TextBackgroundStyle,
      animation: "fade" as OverlayAnimation,
    };
    const set = (patch: Partial<typeof tOv>) => onUpdate({ textOverlay: { ...tOv, ...patch } });
    return (
      <section className={shell}>
        {heading}
        <TextField label="Text" value={tOv.text} multiline placeholder="Overlay text…" onChange={(text) => set({ text })} />
        <Segmented label="Animation" value={tOv.animation} options={ANIM_OPTS} onChange={(animation) => set({ animation })} />
        <TextStyleControls style={styleValues} onChange={onStyle} />
      </section>
    );
  }

  if (moment.effectType === "callout") {
    const co = moment.callout ?? { text: "", style: "box" as CalloutStyle };
    const set = (patch: Partial<typeof co>) => onUpdate({ callout: { ...co, ...patch } });
    return (
      <section className={shell}>
        {heading}
        <TextField label="Label" value={co.text} placeholder="Click here" onChange={(text) => set({ text })} />
        <Segmented label="Style" value={co.style} options={CALLOUT_STYLE_OPTS} onChange={(style) => set({ style })} />
        <p className="text-[10.5px] leading-relaxed text-fog/70">Points at the region below — drag it to aim the callout.</p>
        {co.text.trim() !== "" && <TextStyleControls style={styleValues} onChange={onStyle} showPosition={false} />}
      </section>
    );
  }

  if (moment.effectType === "blur-redaction") {
    const b = moment.blurRedaction ?? { blurStrength: DEFAULT_BLUR_STRENGTH, reasonType: "manual" as BlurReasonType };
    const set = (patch: Partial<typeof b>) => onUpdate({ blurRedaction: { ...b, ...patch } });
    return (
      <section className={shell}>
        {heading}
        <Slider label="Strength" value={Math.round(b.blurStrength * 100)} min={20} max={100} onChange={(v) => set({ blurStrength: v / 100 })} />
        <Segmented label="Reason" value={b.reasonType} options={BLUR_REASON_OPTS} onChange={(reasonType) => set({ reasonType })} />
        <p className="text-[10.5px] leading-relaxed text-fog/70">Hides the region below in preview + export. Drag it to cover the sensitive area.</p>
      </section>
    );
  }

  if (moment.effectType === "transition") {
    const tr = moment.transition ?? { style: "fade" as TransitionStyle };
    const set = (patch: Partial<typeof tr>) => onUpdate({ transition: { ...tr, ...patch } });
    return (
      <section className={shell}>
        {heading}
        <Segmented label="Style" value={tr.style} options={TRANSITION_STYLE_OPTS} onChange={(style) => set({ style })} />
        <p className="text-[10.5px] leading-relaxed text-fog/70">A short punctuation dip over this range. Adjust its length in Timing below.</p>
      </section>
    );
  }

  if (moment.effectType === "branding-cta") {
    const cta = moment.brandingCta ?? { ctaText: "", position: "bottom-right" as BrandingPosition, stylePreset: "creator" as BrandingPreset };
    const set = (patch: Partial<typeof cta>) => onUpdate({ brandingCta: { ...cta, ...patch } });
    return (
      <section className={shell}>
        {heading}
        <TextField label="CTA text" value={cta.ctaText} placeholder="Follow for more" onChange={(ctaText) => set({ ctaText })} />
        <Segmented label="Position" value={cta.position === "custom" ? "bottom-right" : cta.position} options={CTA_POS_OPTS} onChange={(position) => set({ position })} />
        <TextStyleControls style={styleValues} onChange={onStyle} showPosition={false} />
      </section>
    );
  }

  if (moment.effectType === "smart-crop") {
    const sc = moment.smartCrop ?? { aspectRatio: "9:16" as SmartCropAspect, focusTarget: "center" as SmartCropFocus };
    const set = (patch: Partial<typeof sc>) => onUpdate({ smartCrop: { ...sc, ...patch } });
    return (
      <section className={shell}>
        {heading}
        <Segmented label="Aspect ratio" value={sc.aspectRatio} options={SMARTCROP_ASPECT_OPTS} onChange={(aspectRatio) => set({ aspectRatio })} />
        <Segmented label="Focus" value={sc.focusTarget} options={SMARTCROP_FOCUS_OPTS} onChange={(focusTarget) => set({ focusTarget })} />
        <p className="text-[10.5px] leading-relaxed text-fog/70">
          Output framing is applied via the Canvas tool (this records the recipe&apos;s choice). Open Canvas to fine-tune the reframe.
        </p>
      </section>
    );
  }

  return null;
}

/**
 * "Apply style to all captions" — pushes the selected caption's resolved style
 * onto every caption moment in one undoable step, so a user styles once and the
 * whole track matches. Shows a brief inline confirmation.
 */
function ApplyToAllCaptions({ style }: { style: TextStyleValues }) {
  const { applyTextStyleToType } = useEditorReal();
  const [applied, setApplied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await applyTextStyleToType("captions", style);
      setApplied(true);
      window.setTimeout(() => setApplied(false), 2200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className={cn(
        "inline-flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11.5px] font-medium transition-colors duration-150 disabled:opacity-50",
        applied
          ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-100"
          : "border-white/[0.1] bg-white/[0.02] text-fog hover:border-white/25 hover:text-white"
      )}
    >
      {applied ? (
        <>
          <BadgeCheck size={12} />
          Applied to all captions
        </>
      ) : busy ? (
        "Applying…"
      ) : (
        <>
          <CaptionsIcon size={12} />
          Apply this style to all captions
        </>
      )}
    </button>
  );
}

function EmptyInspector({
  hasMoments,
  status,
}: {
  hasMoments: boolean;
  status: string;
}) {
  return (
    <div className="glass overflow-hidden rounded-2xl p-6">
      <div className="inline-flex size-9 items-center justify-center rounded-lg bg-violet-500/12 text-violet-300 ring-1 ring-violet-400/20">
        <Crop size={16} />
      </div>
      <h3 className="mt-3 font-display text-[15px] font-semibold text-white">
        Inspector
      </h3>
      {hasMoments ? (
        <p className="mt-1 text-[12.5px] leading-relaxed text-fog">
          Select a timeline edit to adjust crop, speed, zoom, or focus.
        </p>
      ) : status !== "analyzed" && status !== "completed" ? (
        <p className="mt-1 text-[12.5px] leading-relaxed text-fog">
          Run <strong className="text-white">Analyze with AI</strong> to
          generate a first-draft edit.
        </p>
      ) : (
        <p className="mt-1 text-[12.5px] leading-relaxed text-fog">
          No moments yet — use the toolbar above to add one.
        </p>
      )}
    </div>
  );
}

// ─── Compact section ─────────────────────────────────────────────────────

/**
 * A flat, borderless disclosure row used for advanced sections. No icon
 * gutter, no nested card — just a small clickable line. When expanded the
 * content sits flush against the parent's padding rather than getting its
 * own box. This is the visual difference between "inspector" and
 * "settings dashboard."
 */
function CompactSection({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 rounded-md py-1.5 text-left transition-colors duration-150 hover:bg-white/[0.025]"
      >
        <ChevronDown
          size={12}
          className={cn(
            "shrink-0 text-fog transition-transform duration-200",
            !open && "-rotate-90"
          )}
        />
        <span className="text-[12px] font-medium text-white/90">{title}</span>
        {meta && (
          <span className="ml-auto inline-flex items-center gap-1.5 truncate text-[11px] text-fog">
            {meta}
          </span>
        )}
      </button>
      {open && <div className="mt-2 pb-2 pl-5">{children}</div>}
    </div>
  );
}

// ─── Keyframe editor ────────────────────────────────────────────────────

const EASES: EaseKind[] = ["linear", "ease-in", "ease-out", "ease-in-out"];

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function KeyframeEditor({
  moment,
  currentTime,
  onChange,
  onSeek,
}: {
  moment: DetectedMoment;
  currentTime: number;
  onChange: (keyframes: MomentKeyframe[] | undefined) => void;
  onSeek: (t: number) => void;
}) {
  const kfs = moment.keyframes ?? [];
  const dur = Math.max(0.1, moment.endTime - moment.startTime);
  const hasKfs = kfs.length > 0;

  const toLocal = (t: number) => clamp01((t - moment.startTime) / dur);
  const toAbs = (lt: number) => moment.startTime + lt * dur;

  const addAtPlayhead = () => {
    const lt = toLocal(currentTime);
    const cx = moment.focusRegion.x + moment.focusRegion.width / 2;
    const cy = moment.focusRegion.y + moment.focusRegion.height / 2;
    const scale = clamp01(
      moment.intensity ?? moment.recommendedIntensity ?? moment.attentionScore ?? 0.7
    );
    const next = [
      ...kfs.filter((k) => Math.abs(k.t - lt) > 0.02),
      {
        t: round3(lt),
        x: round3(cx),
        y: round3(cy),
        scale: round3(scale),
        ease: "ease-in-out" as EaseKind,
      },
    ].sort((a, b) => a.t - b.t);
    onChange(next);
  };

  const patchKf = (i: number, patch: Partial<MomentKeyframe>) => {
    const next = kfs
      .map((k, idx) => (idx === i ? { ...k, ...patch } : k))
      .sort((a, b) => a.t - b.t);
    onChange(next);
  };
  const removeKf = (i: number) => {
    const next = kfs.filter((_, idx) => idx !== i);
    onChange(next.length ? next : undefined);
  };

  if (!hasKfs) {
    return (
      <div className="space-y-2">
        <p className="text-[11.5px] leading-relaxed text-fog">
          Animate the camera across this moment.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onChange(seedKeyframes(moment))}
            className="rounded-md border border-violet-400/30 bg-violet-500/10 py-1.5 text-[11.5px] font-medium text-violet-100 transition-colors duration-150 hover:bg-violet-500/20"
          >
            Add punch-in
          </button>
          <button
            type="button"
            onClick={addAtPlayhead}
            className="rounded-md border border-white/10 bg-white/[0.02] py-1.5 text-[11.5px] font-medium text-fog transition-colors duration-150 hover:border-white/25 hover:text-white"
          >
            At playhead
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {kfs.map((k, i) => (
        <div
          key={i}
          className="flex items-center gap-2 rounded-md bg-white/[0.02] p-1.5"
        >
          <button
            type="button"
            onClick={() => onSeek(toAbs(k.t))}
            title="Jump to this keyframe"
            className="inline-flex shrink-0 items-center gap-1 rounded border border-white/10 bg-white/[0.03] px-1.5 py-1 font-mono text-[10px] text-fog transition-colors duration-150 hover:text-white"
          >
            <Crosshair size={10} />
            {Math.round(k.t * 100)}%
          </button>
          <input
            type="range"
            min={20}
            max={130}
            value={Math.round(k.scale * 100)}
            onChange={(e) => patchKf(i, { scale: Number(e.target.value) / 100 })}
            aria-label="Keyframe zoom"
            className="range-thumb h-1 flex-1"
            title={`Zoom ${Math.round(k.scale * 100)}%`}
          />
          <select
            value={k.ease ?? "ease-in-out"}
            onChange={(e) => patchKf(i, { ease: e.target.value as EaseKind })}
            aria-label="Keyframe easing"
            className="h-7 rounded border border-white/10 bg-white/[0.03] px-1 text-[10px] text-white outline-none focus:border-white/20"
          >
            {EASES.map((ez) => (
              <option key={ez} value={ez} className="bg-ink">
                {ez}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => removeKf(i)}
            aria-label="Remove keyframe"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-fog transition-colors duration-150 hover:bg-rose-500/10 hover:text-rose-300"
          >
            <X size={11} />
          </button>
        </div>
      ))}
      <div className="grid grid-cols-2 gap-2 pt-1">
        <button
          type="button"
          onClick={addAtPlayhead}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-violet-400/30 bg-violet-500/10 py-1.5 text-[11.5px] font-medium text-violet-100 transition-colors duration-150 hover:bg-violet-500/20"
        >
          <Plus size={11} />
          At playhead
        </button>
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="rounded-md border border-white/10 bg-white/[0.02] py-1.5 text-[11.5px] font-medium text-fog transition-colors duration-150 hover:border-rose-400/30 hover:text-rose-300"
        >
          Clear all
        </button>
      </div>
    </div>
  );
}

// ─── Focus region editor ────────────────────────────────────────────────

function FocusRegionEditor({
  moment,
  onChange,
}: {
  moment: DetectedMoment;
  onChange: (fr: DetectedMoment["focusRegion"]) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11.5px] leading-relaxed text-fog">
        Drag the violet box on the preview to retarget the camera. Fine-tune
        coordinates below if needed.
      </p>
      <div className="grid grid-cols-4 gap-1.5">
        {(["x", "y", "width", "height"] as const).map((k) => (
          <label key={k} className="block">
            <span className="text-[9.5px] font-medium uppercase tracking-[0.12em] text-fog">
              {k}
            </span>
            <input
              type="number"
              step={0.01}
              min={0}
              max={1}
              value={Number(moment.focusRegion[k].toFixed(2))}
              onChange={(e) =>
                onChange({
                  ...moment.focusRegion,
                  [k]: Math.max(0, Math.min(1, Number(e.target.value))),
                })
              }
              className="mt-1 h-7 w-full rounded-md border border-white/10 bg-white/[0.02] px-1.5 font-mono text-[11.5px] text-white outline-none focus:border-white/25"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  const tenths = Math.floor((s - Math.floor(s)) * 10);
  return tenths > 0
    ? `${m}:${String(r).padStart(2, "0")}.${tenths}`
    : `${m}:${String(r).padStart(2, "0")}`;
}
