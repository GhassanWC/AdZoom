"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Slider } from "@/components/ui/Slider";
import { Toggle } from "@/components/ui/Toggle";
import { ColorField } from "@/components/ui/ColorField";
import { useLiveValue } from "./useLiveValue";
import { COMMIT_PROFILES } from "./live-commit";
import { cn } from "@/lib/cn";
import { TEXT_STYLE_PRESETS } from "@/lib/render/text-style";
import type {
  TextStyle,
  TextStyleValues,
  TextStylePreset,
  TextFontFamily,
  TextBgMode,
  TextVPosition,
} from "@/lib/render/text-style";
import type { TextAlignment } from "@/lib/firebase/schema";

/**
 * TextStyleControls — the ONE reusable styling panel for every text-based edit
 * (captions, hook text, text overlays, callouts, branding CTAs, and future text
 * edits). It reads the fully-resolved `TextStyleValues` and emits PARTIAL
 * patches to merge into `moment.textStyle`, so a doc stores only what changed.
 *
 * Layout: the controls a user reaches for most (preset, family, size, weight,
 * colour, alignment, background) sit up top; everything else lives in a
 * collapsible "Advanced text styling" section to keep the dialog clean. Every
 * control is `w-full` / `min-w-0` so nothing overflows a narrow drawer.
 */
export function TextStyleControls({
  style,
  onChange,
  className,
  showPosition = true,
}: {
  style: TextStyleValues;
  onChange: (patch: Partial<TextStyle>) => void;
  className?: string;
  /** Hide the vertical position control (for edits whose placement is spatial,
   *  e.g. callouts anchored to a region or CTAs pinned to a corner). */
  showPosition?: boolean;
}) {
  return (
    <div className={cn("space-y-3", className)}>
      <PresetRow active={style.preset} onPick={(preset) => onChange({ ...TEXT_STYLE_PRESETS[preset], preset })} />

      <Seg<TextFontFamily>
        label="Font"
        value={style.fontFamily}
        options={FONT_OPTS}
        onChange={(fontFamily) => onChange({ fontFamily })}
      />

      <FontSizeControl scale={style.fontScale} onChange={(fontScale) => onChange({ fontScale })} />

      <Seg<number>
        label="Weight"
        value={weightBucket(style.fontWeight)}
        options={WEIGHT_OPTS}
        onChange={(fontWeight) => onChange({ fontWeight })}
      />

      <ColorField label="Text color" value={style.color} onChange={(color) => onChange({ color })} />

      <Seg<TextAlignment>
        label="Alignment"
        value={style.align}
        options={ALIGN_OPTS}
        onChange={(align) => onChange({ align })}
      />

      <Seg<TextBgMode>
        label="Background"
        value={style.background}
        options={BG_OPTS}
        onChange={(background) => onChange({ background })}
      />

      <Advanced title="Advanced text styling">
        {style.background !== "none" && (
          <>
            <ColorField
              label="Background color"
              value={style.backgroundColor}
              onChange={(backgroundColor) => onChange({ backgroundColor })}
            />
            <Slider
              label="Background opacity"
              value={pct(style.backgroundOpacity)}
              min={0}
              max={100}
              onChange={(v) => onChange({ backgroundOpacity: v / 100 })}
            />
            {(style.background === "box" || style.background === "solid") && (
              <Slider
                label="Corner radius"
                value={pct(style.borderRadius)}
                min={0}
                max={100}
                unit=""
                onChange={(v) => onChange({ borderRadius: v / 100 })}
              />
            )}
            <div className="grid grid-cols-2 gap-2">
              <Slider
                label="Padding X"
                value={pct(style.paddingX)}
                min={0}
                max={150}
                unit=""
                onChange={(v) => onChange({ paddingX: v / 100 })}
              />
              <Slider
                label="Padding Y"
                value={pct(style.paddingY)}
                min={0}
                max={100}
                unit=""
                onChange={(v) => onChange({ paddingY: v / 100 })}
              />
            </div>
          </>
        )}

        <Slider
          label="Text opacity"
          value={pct(style.textOpacity)}
          min={0}
          max={100}
          onChange={(v) => onChange({ textOpacity: v / 100 })}
        />

        <Toggle
          label="Uppercase"
          checked={style.uppercase}
          onChange={(uppercase) => onChange({ uppercase })}
        />

        <div className="grid grid-cols-2 gap-2">
          <Slider
            label="Letter spacing"
            value={Math.round(style.letterSpacing * 100)}
            min={-10}
            max={40}
            unit=""
            onChange={(v) => onChange({ letterSpacing: v / 100 })}
          />
          <Slider
            label="Line height"
            value={Math.round(style.lineHeight * 100)}
            min={80}
            max={250}
            unit=""
            onChange={(v) => onChange({ lineHeight: v / 100 })}
          />
        </div>

        {/* Outline / stroke */}
        <div className="space-y-2 rounded-lg border border-white/[0.06] p-2.5">
          <Slider
            label="Outline width"
            value={pct(style.strokeWidth)}
            min={0}
            max={25}
            unit=""
            onChange={(v) => onChange({ strokeWidth: v / 100 })}
          />
          {style.strokeWidth > 0 && (
            <ColorField
              label="Outline color"
              value={style.strokeColor}
              onChange={(strokeColor) => onChange({ strokeColor })}
            />
          )}
        </div>

        {/* Shadow */}
        <div className="space-y-2 rounded-lg border border-white/[0.06] p-2.5">
          <Toggle
            label="Text shadow"
            checked={style.shadow}
            onChange={(shadow) => onChange({ shadow })}
          />
          {style.shadow && (
            <>
              <ColorField
                label="Shadow color"
                value={style.shadowColor}
                onChange={(shadowColor) => onChange({ shadowColor })}
              />
              <div className="grid grid-cols-2 gap-2">
                <Slider
                  label="Blur"
                  value={pct(style.shadowBlur)}
                  min={0}
                  max={100}
                  unit=""
                  onChange={(v) => onChange({ shadowBlur: v / 100 })}
                />
                <Slider
                  label="Opacity"
                  value={pct(style.shadowOpacity)}
                  min={0}
                  max={100}
                  onChange={(v) => onChange({ shadowOpacity: v / 100 })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Slider
                  label="Offset X"
                  value={Math.round(style.shadowOffsetX * 100)}
                  min={-25}
                  max={25}
                  unit=""
                  onChange={(v) => onChange({ shadowOffsetX: v / 100 })}
                />
                <Slider
                  label="Offset Y"
                  value={Math.round(style.shadowOffsetY * 100)}
                  min={-25}
                  max={25}
                  unit=""
                  onChange={(v) => onChange({ shadowOffsetY: v / 100 })}
                />
              </div>
            </>
          )}
        </div>

        {/* Position */}
        {showPosition && (
          <>
            <Seg<TextVPosition>
              label="Position"
              value={style.position}
              options={POS_OPTS}
              onChange={(position) => onChange({ position })}
            />
            {style.position === "custom" && (
              <div className="grid grid-cols-2 gap-2">
                <Slider
                  label="X position"
                  value={pct(style.customX)}
                  min={0}
                  max={100}
                  onChange={(v) => onChange({ customX: v / 100 })}
                />
                <Slider
                  label="Y position"
                  value={pct(style.customY)}
                  min={0}
                  max={100}
                  onChange={(v) => onChange({ customY: v / 100 })}
                />
              </div>
            )}
          </>
        )}
      </Advanced>
    </div>
  );
}

// ── option tables ────────────────────────────────────────────────────────────

const FONT_OPTS: { id: TextFontFamily; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "sans", label: "Sans" },
  { id: "serif", label: "Serif" },
  { id: "mono", label: "Mono" },
];
const WEIGHT_OPTS: { id: number; label: string }[] = [
  { id: 400, label: "Regular" },
  { id: 500, label: "Medium" },
  { id: 600, label: "Semibold" },
  { id: 700, label: "Bold" },
];
const ALIGN_OPTS: { id: TextAlignment; label: string }[] = [
  { id: "left", label: "Left" },
  { id: "center", label: "Center" },
  { id: "right", label: "Right" },
];
const BG_OPTS: { id: TextBgMode; label: string }[] = [
  { id: "none", label: "None" },
  { id: "solid", label: "Solid" },
  { id: "box", label: "Box" },
  { id: "pill", label: "Pill" },
];
const POS_OPTS: { id: TextVPosition; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "center", label: "Center" },
  { id: "bottom", label: "Bottom" },
  { id: "custom", label: "Custom" },
];
const PRESET_OPTS: { id: TextStylePreset; label: string }[] = [
  { id: "clean", label: "Clean" },
  { id: "bold", label: "Bold" },
  { id: "minimal", label: "Minimal" },
  { id: "neon", label: "Neon" },
  { id: "shadow", label: "Shadow" },
];

// ── helpers ────────────────────────────────────────────────────────────────

/** 0..1 → integer percent for slider display. */
function pct(v: number): number {
  return Math.round(v * 100);
}

/** Snap an arbitrary weight (incl. legacy 800/900) to the nearest control bucket. */
function weightBucket(w: number): number {
  if (w >= 700) return 700;
  if (w >= 600) return 600;
  if (w >= 500) return 500;
  return 400;
}

// ── sub-components ───────────────────────────────────────────────────────────

function PresetRow({
  active,
  onPick,
}: {
  active: TextStylePreset | undefined;
  onPick: (p: TextStylePreset) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fog">Style preset</span>
      <div className="flex w-full flex-wrap gap-1.5">
        {PRESET_OPTS.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onPick(o.id)}
            aria-pressed={active === o.id}
            className={cn(
              "rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-150",
              active === o.id
                ? "border-violet-400/40 bg-violet-500/15 text-white"
                : "border-white/[0.1] bg-white/[0.02] text-fog hover:border-white/25 hover:text-white"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Font size — slider + synced numeric field, expressed as px at a 1080p
 *  reference (stored as a resolution-independent fraction of canvas height). */
function FontSizeControl({ scale, onChange }: { scale: number; onChange: (fontScale: number) => void }) {
  const REF = 1080;
  const MIN = 10;
  const MAX = 200;
  const px = Math.round(scale * REF);
  const set = (nextPx: number) => {
    const clamped = Math.max(MIN, Math.min(MAX, Math.round(nextPx)));
    onChange(clamped / REF);
  };
  // The numeric field is typed into, so it gets its own local draft — otherwise
  // each digit wrote the document and the clamp re-formatted the value out from
  // under the caret (typing "120" became "12" → clamped → fought back).
  const live = useLiveValue(px, set, COMMIT_PROFILES.text);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {/* The Slider already owns its own drag-local state. */}
          <Slider label="Font size" value={px} min={MIN} max={MAX} unit="px" onChange={set} />
        </div>
        <input
          type="number"
          aria-label="Font size (px)"
          value={live.value}
          min={MIN}
          max={MAX}
          onFocus={live.begin}
          onChange={(e) => live.set(Number(e.target.value))}
          onBlur={live.end}
          className="mt-4 h-8 w-16 shrink-0 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2 text-center font-mono text-[12px] text-white outline-none focus:border-violet-400/50"
        />
      </div>
    </div>
  );
}

function Seg<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fog">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex w-full flex-wrap items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-1"
      >
        {options.map((o) => {
          const activeOpt = value === o.id;
          return (
            <button
              key={String(o.id)}
              type="button"
              role="radio"
              aria-checked={activeOpt}
              onClick={() => onChange(o.id)}
              className={cn(
                "inline-flex flex-1 items-center justify-center whitespace-nowrap rounded-md px-2 py-1.5 text-[11.5px] font-medium transition-colors duration-150",
                activeOpt
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

function Advanced({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.01]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-white/[0.025]"
      >
        <ChevronDown
          size={13}
          className={cn("shrink-0 text-fog transition-transform duration-200", !open && "-rotate-90")}
        />
        <span className="text-[12px] font-medium text-white/90">{title}</span>
      </button>
      {open && <div className="space-y-3 px-2.5 pb-3 pt-1">{children}</div>}
    </div>
  );
}
