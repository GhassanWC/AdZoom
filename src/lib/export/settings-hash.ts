import "server-only";
import { createHash } from "node:crypto";

/**
 * Deterministic dedup key for an export. Two export requests with the SAME
 * inputs (project, source object, format/resolution/fps, canvas, vignette, and
 * the effects/timeline content) produce the SAME hash — so the create path can
 * recognise a repeated click as a duplicate of an already-active job rather than
 * spawning a second one. Any real change (different settings, an edited
 * timeline) changes the hash, which correctly allows a fresh export.
 *
 * The hash folds in the FULL effects + moments + sourceCrop, so it doubles as
 * the "effects timeline revision" — no separate version counter is needed.
 */
export interface SettingsHashInput {
  projectId: string;
  /** Source video object path in Storage (the authoritative source identity). */
  sourceObjectPath: string;
  format: string;
  resolution: string;
  fps: number;
  /** Output canvas (aspect/fit) — undefined ⇒ "source · full frame". */
  effects: unknown;
  /** Detected moments = the editable timeline; its content IS the revision. */
  moments: unknown;
  /** Global source-frame crop, if any. */
  sourceCrop?: unknown;
}

/** Stable JSON: object keys sorted recursively so equal data → equal string. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** 16-hex-char SHA-1 digest of the canonical settings — short but collision-safe
 *  enough for per-user dedup. */
export function computeSettingsHash(input: SettingsHashInput): string {
  const canonical = stableStringify({
    projectId: input.projectId,
    sourceObjectPath: input.sourceObjectPath,
    format: input.format,
    resolution: input.resolution,
    fps: input.fps,
    effects: input.effects ?? null,
    moments: input.moments ?? [],
    sourceCrop: input.sourceCrop ?? null,
  });
  return createHash("sha1").update(canonical).digest("hex").slice(0, 16);
}
