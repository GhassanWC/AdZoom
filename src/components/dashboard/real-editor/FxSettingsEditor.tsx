"use client";

/**
 * Hand-editing for one effect instance — the same settings the chat revises
 * ("make the sparks fade faster", "make this one blue") and the renderer
 * reads. Changes apply to THIS use only; the library version it came from is
 * shown, never modified from here.
 */

import * as React from "react";
import { Library } from "lucide-react";
import { ColorField } from "@/components/ui/ColorField";
import type { FxSettings } from "@/lib/firebase/schema";
import { resolveParams } from "@/lib/effects/program";

export function FxSettingsEditor({ fx, onChange }: { fx: FxSettings; onChange: (next: FxSettings) => void }) {
  const values = resolveParams(fx.program, fx.params);
  const set = (id: string, v: number | string) => onChange({ ...fx, params: { ...fx.params, [id]: v } });
  return (
    <div className="space-y-3" data-testid="fx-settings" data-effect-id={fx.ref.effectId} data-effect-version={fx.ref.version}>
      <div className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11.5px] text-fog">
        <Library size={13} className="shrink-0 text-amber-300" />
        <span className="min-w-0 truncate">
          <span className="font-semibold text-white">{fx.ref.name}</span> · v{fx.ref.version} from your effects library
        </span>
      </div>
      {fx.program.params.length === 0 && <p className="text-[11.5px] text-fog">This effect has no adjustable settings.</p>}
      {fx.program.params.map((p) =>
        p.type === "color" ? (
          <ColorField key={p.id} label={p.label || p.id} value={String(values[p.id])} onChange={(hex) => set(p.id, hex)} />
        ) : (
          <label key={p.id} className="block" data-param-id={p.id}>
            <span className="flex items-center justify-between text-[11px] text-fog">
              <span>{p.label || p.id}</span>
              <span className="tabular-nums text-white/80">{Number(values[p.id]).toFixed(2)}</span>
            </span>
            <input
              type="range"
              className="mt-1 w-full accent-amber-300"
              min={p.min ?? 0}
              max={p.max ?? Math.max(1, Number(p.default) * 3)}
              step={((p.max ?? Math.max(1, Number(p.default) * 3)) - (p.min ?? 0)) / 200 || 0.01}
              value={Number(values[p.id])}
              onChange={(e) => set(p.id, Number(e.target.value))}
            />
          </label>
        )
      )}
    </div>
  );
}
