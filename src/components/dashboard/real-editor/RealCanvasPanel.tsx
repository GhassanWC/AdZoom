"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Slider } from "@/components/ui/Slider";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useEditorReal } from "./context";
import {
  resolveOutputCanvas,
  resolveCanvasDims,
} from "@/lib/timeline/canvas-layout";
import type {
  AspectRatioId,
  BackgroundMode,
  FitMode,
  OutputCanvas,
} from "@/lib/firebase/schema";

const ASPECTS: { id: AspectRatioId; label: string; hint: string }[] = [
  { id: "16:9", label: "16:9", hint: "YouTube" },
  { id: "9:16", label: "9:16", hint: "TikTok · Reels" },
  { id: "1:1", label: "1:1", hint: "Square" },
  { id: "4:5", label: "4:5", hint: "Portrait" },
  { id: "custom", label: "Custom", hint: "Your size" },
];

const FITS: { id: FitMode; label: string; desc: string }[] = [
  { id: "fit", label: "Fit", desc: "Whole video, padded" },
  { id: "fill", label: "Fill", desc: "Fill frame, crop edges" },
  { id: "smart-fit", label: "Smart Fit", desc: "Auto-keep the action" },
  { id: "manual", label: "Manual", desc: "Drag + zoom yourself" },
];

const BACKGROUNDS: { id: BackgroundMode; label: string }[] = [
  { id: "blur", label: "Blur" },
  { id: "solid", label: "Solid" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

/** Vertical-ish formats default to Smart Fit (best for 16:9 → 9:16). */
function defaultFitFor(aspect: AspectRatioId): FitMode {
  return aspect === "9:16" || aspect === "4:5" ? "smart-fit" : "fill";
}

/**
 * Canvas Fit / Resize controls — the body of `CanvasModal`. Edits the global
 * `effectsSettings.outputCanvas`; the preview + export read the same field, so
 * what you set here is exactly what exports.
 */
export function RealCanvasPanel() {
  const { project, updateEffects, clearOutputCanvas } = useEditorReal();

  const srcW = project.width && project.width > 0 ? project.width : 1920;
  const srcH = project.height && project.height > 0 ? project.height : 1080;

  // The live canvas (or null = "Source / full frame").
  const current = resolveOutputCanvas(project.effectsSettings);
  const isSource = !current;

  const canonicalDims = React.useCallback(
    (id: AspectRatioId): { width: number; height: number } => {
      if (id === "custom") {
        return { width: current?.width ?? srcW, height: current?.height ?? srcH };
      }
      const { canvasW, canvasH } = resolveCanvasDims(srcW, srcH, id, "1080p");
      return { width: canvasW, height: canvasH };
    },
    [current?.width, current?.height, srcW, srcH]
  );

  // Write the full object (no partial-merge hazard); drop backgroundColor
  // unless solid so Firestore never sees an irrelevant value.
  const writeOc = React.useCallback(
    (next: OutputCanvas) => {
      const clean: OutputCanvas = { ...next };
      if (clean.backgroundMode !== "solid") delete clean.backgroundColor;
      updateEffects("outputCanvas", clean);
    },
    [updateEffects]
  );

  const pickAspect = (id: AspectRatioId) => {
    const dims = canonicalDims(id);
    if (current) {
      writeOc({ ...current, aspectRatio: id, ...dims });
    } else {
      writeOc({
        aspectRatio: id,
        ...dims,
        fitMode: defaultFitFor(id),
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        backgroundMode: "blur",
      });
    }
  };

  const pickFit = (id: FitMode) => {
    if (!current) return;
    writeOc({ ...current, fitMode: id });
  };

  const pickBackground = (id: BackgroundMode) => {
    if (!current) return;
    writeOc({
      ...current,
      backgroundMode: id,
      ...(id === "solid"
        ? { backgroundColor: current.backgroundColor ?? "#000000" }
        : {}),
    });
  };

  const fit = current?.fitMode ?? "fill";
  // Background only matters when empty space can appear (Fit / Manual). Fill
  // covers; Smart-Fit handles its own blur fallback automatically.
  const bgEnabled = !!current && (fit === "fit" || fit === "manual");
  const outDims = current
    ? canonicalDims(current.aspectRatio === "custom" ? "custom" : current.aspectRatio)
    : { width: srcW, height: srcH };

  return (
    <div className="space-y-7 px-6 py-6">
      {/* Aspect ratio */}
      <Section title="Aspect ratio">
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          <Card
            active={isSource}
            onClick={() => clearOutputCanvas()}
            label="Source"
            hint="Full frame"
          />
          {ASPECTS.map((a) => (
            <Card
              key={a.id}
              active={!isSource && current?.aspectRatio === a.id}
              onClick={() => pickAspect(a.id)}
              label={a.label}
              hint={a.hint}
            />
          ))}
        </div>

        {current?.aspectRatio === "custom" && (
          <div className="mt-2 flex items-center gap-2">
            <DimInput
              label="W"
              value={current.width}
              onCommit={(v) => writeOc({ ...current, width: v })}
            />
            <span className="text-fog">×</span>
            <DimInput
              label="H"
              value={current.height}
              onCommit={(v) => writeOc({ ...current, height: v })}
            />
            <span className="ml-1 text-[11px] text-fog/70">px (long edge capped)</span>
          </div>
        )}
      </Section>

      {/* Fit mode + background only apply once a format is chosen. */}
      {!isSource && current && (
        <>
          <Section title="Fit">
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {FITS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => pickFit(f.id)}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-xl border p-3 text-center transition-colors duration-150",
                    current.fitMode === f.id
                      ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
                      : "border-white/10 bg-white/[0.02] text-fog hover:border-white/20 hover:text-white"
                  )}
                >
                  <FitDiagram mode={f.id} active={current.fitMode === f.id} />
                  <span className="text-[12px] font-medium">{f.label}</span>
                  <span className="text-[10px] leading-tight opacity-70">{f.desc}</span>
                </button>
              ))}
            </div>
          </Section>

          <Section title="Background">
            <div
              className={cn(
                "grid grid-cols-4 gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1",
                !bgEnabled && "opacity-50"
              )}
            >
              {BACKGROUNDS.map((b) => (
                <button
                  key={b.id}
                  disabled={!bgEnabled}
                  onClick={() => pickBackground(b.id)}
                  className={cn(
                    "rounded-md px-2 py-2 text-xs font-medium transition-colors duration-150 disabled:cursor-not-allowed",
                    current.backgroundMode === b.id
                      ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/30"
                      : "text-fog hover:bg-white/[0.04] hover:text-white"
                  )}
                >
                  {b.label}
                </button>
              ))}
            </div>
            {bgEnabled && current.backgroundMode === "solid" && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Background color"
                  value={current.backgroundColor ?? "#000000"}
                  onChange={(e) =>
                    writeOc({
                      ...current,
                      backgroundMode: "solid",
                      backgroundColor: e.target.value,
                    })
                  }
                  className="h-8 w-12 cursor-pointer rounded-md border border-white/10 bg-transparent"
                />
                <span className="font-mono text-[11px] text-fog">
                  {(current.backgroundColor ?? "#000000").toUpperCase()}
                </span>
              </div>
            )}
            {!bgEnabled && (
              <p className="mt-2 text-[10.5px] leading-relaxed text-fog/80">
                No empty space to fill in this mode — the video covers the whole frame.
              </p>
            )}
          </Section>

          {current.fitMode === "manual" && (
            <Section title="Position & zoom">
              <Slider
                label="Zoom"
                value={Math.round((current.scale || 1) * 100)}
                min={25}
                max={400}
                step={5}
                format={(v) => `${(v / 100).toFixed(2)}×`}
                onChange={(v) => writeOc({ ...current, scale: v / 100 })}
              />
              <div className="flex items-center justify-between">
                <p className="text-[11px] leading-relaxed text-fog">
                  Drag the video in the preview to reposition it.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<RotateCcw size={13} />}
                  onClick={() =>
                    writeOc({ ...current, scale: 1, offsetX: 0, offsetY: 0 })
                  }
                >
                  Reset
                </Button>
              </div>
            </Section>
          )}
        </>
      )}

      {/* Honest summary line. */}
      <p className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-[11.5px] leading-relaxed text-fog">
        {summaryLine(isSource, current, srcW, srcH, outDims)}
      </p>
    </div>
  );
}

function summaryLine(
  isSource: boolean,
  oc: OutputCanvas | null,
  srcW: number,
  srcH: number,
  outDims: { width: number; height: number }
): string {
  if (isSource || !oc) {
    return "Source — keeps your full recording frame. Nothing is cropped or padded.";
  }
  const srcLabel = `${Math.round((srcW / srcH) * 100) / 100 >= 1 ? "landscape" : "portrait"}`;
  const out = `${oc.aspectRatio} (${outDims.width}×${outDims.height})`;
  switch (oc.fitMode) {
    case "fit":
      return `${srcLabel} → ${out} · Fit — the whole video, padded with a ${oc.backgroundMode} background.`;
    case "fill":
      return `${srcLabel} → ${out} · Fill — fills the frame; edges that don't fit are cropped.`;
    case "smart-fit":
      return `${srcLabel} → ${out} · Smart Fit — keeps the important content in frame; falls back to a blurred fill if unsure.`;
    case "manual":
      return `${srcLabel} → ${out} · Manual — drag + zoom the video yourself over a ${oc.backgroundMode} background.`;
  }
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
        {title}
      </div>
      {children}
    </div>
  );
}

function Card({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-0.5 rounded-xl border px-2 py-3 text-center transition-colors duration-150",
        active
          ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
          : "border-white/10 bg-white/[0.02] text-fog hover:border-white/20 hover:text-white"
      )}
    >
      <span className="text-[12.5px] font-semibold">{label}</span>
      <span className="text-[9.5px] leading-tight opacity-70">{hint}</span>
    </button>
  );
}

function DimInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= 64 && n <= 8192) onCommit(n);
    else setDraft(String(value));
  };
  return (
    <label className="inline-flex items-center gap-1.5">
      <span className="text-[11px] text-fog">{label}</span>
      <input
        type="number"
        value={draft}
        min={64}
        max={8192}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="h-8 w-20 rounded-md border border-white/10 bg-white/[0.03] px-2 text-sm text-white outline-none focus:border-violet-400/40"
      />
    </label>
  );
}

/** Tiny illustrative diagram for each fit mode: outer frame + inner video. */
function FitDiagram({ mode, active }: { mode: FitMode; active: boolean }) {
  const stroke = active ? "rgb(196 181 253)" : "rgba(255,255,255,0.4)";
  const fill = active ? "rgba(167,139,250,0.35)" : "rgba(255,255,255,0.14)";
  // Frame is a portrait 9:16-ish box (the common target); the inner rect shows
  // how a landscape source sits inside it per mode.
  return (
    <svg width="34" height="26" viewBox="0 0 34 26" aria-hidden>
      <rect x="11" y="1" width="12" height="24" rx="1.5" fill="none" stroke={stroke} strokeWidth="1" />
      {mode === "fit" && (
        <rect x="11" y="9" width="12" height="8" fill={fill} />
      )}
      {(mode === "fill" || mode === "smart-fit") && (
        <rect x="5" y="1" width="24" height="24" fill={fill} clipPath="inset(0 round 1)" opacity={0.6} />
      )}
      {mode === "fill" && (
        <rect x="11" y="1" width="12" height="24" fill={fill} />
      )}
      {mode === "smart-fit" && (
        <>
          <rect x="11" y="1" width="12" height="24" fill={fill} />
          <path d="M9 13 L6 13 M25 13 L28 13" stroke={stroke} strokeWidth="1" />
        </>
      )}
      {mode === "manual" && (
        <>
          <rect x="9" y="8" width="16" height="10" fill={fill} />
          <circle cx="17" cy="13" r="1.6" fill={stroke} />
        </>
      )}
    </svg>
  );
}
