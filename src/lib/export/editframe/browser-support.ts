"use client";

/**
 * CHEAP, synchronous browser gate for the Editframe beta button's enabled state.
 *
 * Deliberately imports NO mediabunny — safe to pull into the export panel's
 * bundle without dragging the encoder in. The deep async check (codec/source
 * decodability) lives in `capabilities.ts` and runs lazily on click.
 *
 * The Editframe engine needs WebCodecs `VideoEncoder`/`AudioEncoder`/
 * `VideoDecoder`, which today means a Chromium browser (Chrome or Edge).
 */
export interface EditframeBrowserSupport {
  ok: boolean;
  reason?: string;
}

export function browserSupportsEditframe(): EditframeBrowserSupport {
  if (typeof window === "undefined") {
    return { ok: false, reason: "Export runs in the browser." };
  }
  const g = globalThis as Record<string, unknown>;
  const hasWebCodecs =
    typeof g.VideoEncoder !== "undefined" &&
    typeof g.AudioEncoder !== "undefined" &&
    typeof g.VideoDecoder !== "undefined";
  if (!hasWebCodecs) {
    return {
      ok: false,
      reason: "Fast in-browser export needs Chrome or Edge.",
    };
  }
  return { ok: true };
}
