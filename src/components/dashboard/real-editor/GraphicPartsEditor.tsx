"use client";

/**
 * Hand-editing for a composed graphic's parts — the same data the chat edits
 * ("remove the line but keep the title") and the renderer draws. One row per
 * part: text / colour / position / delay, and delete. Kept deliberately
 * direct: a designer tweaks a value and sees it in the preview immediately.
 */

import * as React from "react";
import { Trash2, Type, Minus, Square } from "lucide-react";
import { ColorField } from "@/components/ui/ColorField";
import type { GraphicPart, GraphicSettings } from "@/lib/firebase/schema";

const FIELD =
  "h-8 w-full rounded-lg border border-white/10 bg-white/[0.03] px-2 text-[12px] text-white focus:border-violet-400/50 focus:outline-none focus:ring-2 focus:ring-violet-400/30";

export function GraphicPartsEditor({
  graphic,
  onChange,
}: {
  graphic: GraphicSettings;
  onChange: (next: GraphicSettings) => void;
}) {
  const parts = graphic.parts ?? [];
  const update = (id: string, patch: Partial<GraphicPart>) =>
    onChange({ parts: parts.map((p) => (p.id === id ? ({ ...p, ...patch } as GraphicPart) : p)) });
  const remove = (id: string) => onChange({ parts: parts.filter((p) => p.id !== id) });

  if (parts.length === 0) {
    return <p className="text-[11.5px] text-fog">This graphic has no parts left. Ask Framevo for a new label, or delete the edit.</p>;
  }

  return (
    <div className="space-y-2" data-testid="graphic-parts">
      {[...parts]
        .sort((a, b) => (b.z ?? 0) - (a.z ?? 0))
        .map((p) => (
          <div key={p.id} className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2" data-part-id={p.id} data-part-kind={p.kind}>
            <div className="flex items-center gap-2">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-white/[0.05] text-amber-200 ring-1 ring-white/10">
                {p.kind === "text" ? <Type size={12} /> : p.kind === "line" ? <Minus size={12} /> : <Square size={12} />}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-white">
                {p.kind === "text" ? p.text || "Text" : p.kind === "line" ? "Line" : "Shape"}
              </span>
              <button
                type="button"
                onClick={() => remove(p.id)}
                aria-label={`Remove ${p.kind}`}
                className="inline-flex size-6 items-center justify-center rounded-md text-fog transition-colors hover:bg-rose-500/15 hover:text-rose-300"
              >
                <Trash2 size={12} />
              </button>
            </div>

            {p.kind === "text" && (
              <label className="mt-2 block">
                <span className="sr-only">Text</span>
                <input className={FIELD} value={p.text} onChange={(e) => update(p.id, { text: e.target.value })} />
              </label>
            )}

            <div className="mt-2 grid grid-cols-2 gap-2">
              {p.kind === "text" ? (
                <ColorField label="Colour" value={p.style?.color ?? "#ffffff"} onChange={(hex) => update(p.id, { style: { ...(p.style ?? {}), color: hex } })} />
              ) : (
                <ColorField label="Colour" value={p.color} onChange={(hex) => update(p.id, { color: hex } as Partial<GraphicPart>)} />
              )}
              <Num label="Delay (s)" value={p.delay ?? 0} step={0.05} min={0} max={10} onChange={(delay) => update(p.id, { delay })} />
              <Num label="X" value={p.x} step={0.01} min={0} max={1} onChange={(x) => update(p.id, p.kind === "line" ? { x, x2: p.x2 + (x - p.x) } : { x })} />
              <Num label="Y" value={p.y} step={0.01} min={0} max={1} onChange={(y) => update(p.id, p.kind === "line" ? { y, y2: p.y2 + (y - p.y) } : { y })} />
              {p.kind === "text" && (
                <Num label="Size" value={p.style?.fontScale ?? 0.05} step={0.002} min={0.015} max={0.2} onChange={(fontScale) => update(p.id, { style: { ...(p.style ?? {}), fontScale } })} />
              )}
            </div>
          </div>
        ))}
    </div>
  );
}

function Num({ label, value, onChange, step, min, max }: { label: string; value: number; onChange: (v: number) => void; step: number; min: number; max: number }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-fog">{label}</span>
      <input
        type="number"
        className={FIELD}
        value={Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
      />
    </label>
  );
}
