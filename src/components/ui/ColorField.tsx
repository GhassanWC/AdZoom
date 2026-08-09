"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import { useLiveValue } from "@/components/dashboard/real-editor/useLiveValue";
import { COMMIT_PROFILES } from "@/components/dashboard/real-editor/live-commit";

/** Normalize free text to a `#rrggbb` hex, or null if it isn't a valid colour. */
function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toLowerCase()}`;
  return null;
}

/**
 * Colour input: a native swatch (the OS colour picker) + an editable hex field,
 * kept in sync. Emits a normalized `#rrggbb` on every valid change. Matches the
 * editor's dark theme; the whole control is `w-full` so it never overflows a
 * narrow inspector/drawer.
 */
export function ColorField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  className?: string;
}) {
  // The SWATCH is a drag: the OS colour picker streams `change` events while the
  // user moves through the gradient, and persisting each one wrote the project
  // document dozens of times a second. The live value keeps the swatch and the
  // hex field in step with the pointer and persists on the drag cadence.
  const live = useLiveValue(
    normalizeHex(value) ?? "#000000",
    onChange,
    COMMIT_PROFILES.drag
  );
  const safe = live.value;
  // Separate draft for the TEXT field so a user can type freely (e.g. mid-edit
  // "#8b5") without it being normalized out from under them; commit on valid
  // input / blur.
  const [draft, setDraft] = React.useState(safe);
  const [seenSafe, setSeenSafe] = React.useState(safe);
  if (seenSafe !== safe) {
    setSeenSafe(safe);
    setDraft(safe);
  }

  const commit = (raw: string) => {
    const hex = normalizeHex(raw);
    if (hex) live.set(hex);
    else setDraft(safe); // revert invalid text
  };

  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fog">{label}</span>
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2 py-1.5">
        <span className="relative inline-flex size-6 shrink-0 overflow-hidden rounded-md ring-1 ring-white/15">
          <span aria-hidden className="absolute inset-0" style={{ backgroundColor: safe }} />
          <input
            type="color"
            aria-label={`${label} colour picker`}
            value={safe}
            onChange={(e) => live.set(e.target.value.toLowerCase())}
            onPointerDown={live.begin}
            onPointerUp={live.end}
            onPointerCancel={live.end}
            onBlur={live.end}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </span>
        <input
          type="text"
          inputMode="text"
          spellCheck={false}
          aria-label={`${label} hex`}
          value={draft}
          onFocus={live.begin}
          onChange={(e) => {
            setDraft(e.target.value);
            const hex = normalizeHex(e.target.value);
            if (hex) live.set(hex);
          }}
          onBlur={(e) => {
            commit(e.target.value);
            live.end();
          }}
          className="w-full min-w-0 bg-transparent font-mono text-[12.5px] uppercase tracking-wide text-white outline-none placeholder:text-fog/50"
          placeholder="#ffffff"
        />
      </div>
    </div>
  );
}
