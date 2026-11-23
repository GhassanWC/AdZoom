/**
 * The user's effect library — every effect Framevo's AI created (or the user
 * saved) that passed validation, with its versions.
 *
 * Stored at `users/{uid}/effects/{effectId}`, one document per effect. Pure
 * here (the assistant route does the I/O):
 *
 *   created   — the AI authored a new program (version 1)
 *   adapted   — an existing effect's program changed → a NEW version of it
 *   saved     — "save this look as Matchday Gold": a named variation whose
 *               parameter defaults are the instance's current settings
 *
 * A timeline instance references an exact `effectId@version` AND embeds that
 * version's program, so the preview, every exporter and a reopened project
 * render the same thing even if the library later gains versions.
 *
 * Idempotency: ids and version numbers are derived from the request id, so a
 * retried request rewrites the same entry/version instead of adding a second.
 */

import type { EffectProgram, FxParamValues } from "./program";

export interface EffectVersion {
  version: number;
  program: EffectProgram;
  /** What changed ("sparks fade faster", "saved from Gold Ripple v1"). */
  note: string;
  createdAt: number;
  /** The request that produced this version — a retry reuses it. */
  requestId: string;
  /** data:image/svg+xml strip from the validator's test render. */
  preview: string | null;
}

export interface EffectLibraryEntry {
  id: string;
  name: string;
  description: string;
  origin: "created" | "saved";
  basedOn?: { effectId: string; version: number; name: string };
  latestVersion: number;
  versions: EffectVersion[];
  createdAt: number;
  updatedAt: number;
}

/** What a model sees when it lists the library (no code, no preview bytes). */
export interface EffectSummary {
  id: string;
  name: string;
  description: string;
  latestVersion: number;
  origin: EffectLibraryEntry["origin"];
  basedOn?: EffectLibraryEntry["basedOn"];
  inputs: string[];
  params: { id: string; label: string; type: string; default: number | string; min?: number; max?: number }[];
}

export const MAX_VERSIONS = 20;

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Deterministic: the same request creating its n-th effect always gets the same id. */
export function effectIdFor(requestId: string, salt: string): string {
  return `fx_${hash(`${requestId}::${salt}`)}${hash(salt).slice(0, 3)}`;
}

export function summarize(e: EffectLibraryEntry): EffectSummary {
  const latest = e.versions.find((v) => v.version === e.latestVersion) ?? e.versions[e.versions.length - 1];
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    latestVersion: e.latestVersion,
    origin: e.origin,
    ...(e.basedOn ? { basedOn: e.basedOn } : {}),
    inputs: latest?.program.inputs ?? [],
    params: (latest?.program.params ?? []).map((p) => ({ id: p.id, label: p.label, type: p.type, default: p.default, ...(p.min != null ? { min: p.min } : {}), ...(p.max != null ? { max: p.max } : {}) })),
  };
}

export function versionOf(e: EffectLibraryEntry, version?: number): EffectVersion | null {
  if (version != null) return e.versions.find((v) => v.version === version) ?? null;
  return e.versions.find((v) => v.version === e.latestVersion) ?? e.versions[e.versions.length - 1] ?? null;
}

export function findEffect(entries: readonly EffectLibraryEntry[], ref: string): EffectLibraryEntry | null {
  const r = ref.trim().toLowerCase();
  if (!r) return null;
  return (
    entries.find((e) => e.id.toLowerCase() === r) ??
    entries.find((e) => e.name.toLowerCase() === r) ??
    entries.find((e) => e.name.toLowerCase().includes(r) || r.includes(e.name.toLowerCase())) ??
    null
  );
}

export function newEntry(args: {
  id: string;
  name: string;
  description: string;
  program: EffectProgram;
  requestId: string;
  preview: string | null;
  origin: EffectLibraryEntry["origin"];
  basedOn?: EffectLibraryEntry["basedOn"];
  note: string;
  now: number;
}): EffectLibraryEntry {
  return {
    id: args.id,
    name: args.name.trim().slice(0, 60) || "Untitled effect",
    description: args.description.trim().slice(0, 400),
    origin: args.origin,
    ...(args.basedOn ? { basedOn: args.basedOn } : {}),
    latestVersion: 1,
    versions: [{ version: 1, program: args.program, note: args.note, createdAt: args.now, requestId: args.requestId, preview: args.preview }],
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/**
 * Add a version (an adaptation). A retry of the same request REPLACES the
 * version it made last time instead of appending another.
 */
export function addVersion(
  e: EffectLibraryEntry,
  v: { program: EffectProgram; note: string; requestId: string; preview: string | null; now: number }
): { entry: EffectLibraryEntry; version: number } {
  const same = e.versions.find((x) => x.requestId === v.requestId && x.version > 1);
  const version = same ? same.version : e.latestVersion + 1;
  const next: EffectVersion = { version, program: v.program, note: v.note.slice(0, 200), createdAt: v.now, requestId: v.requestId, preview: v.preview };
  const versions = [...e.versions.filter((x) => x.version !== version), next].sort((a, b) => a.version - b.version).slice(-MAX_VERSIONS);
  return { entry: { ...e, versions, latestVersion: Math.max(e.latestVersion, version), updatedAt: v.now }, version };
}

/** A program whose parameter defaults are this instance's current values. */
export function bakeDefaults(program: EffectProgram, values: FxParamValues): EffectProgram {
  return {
    ...program,
    params: program.params.map((p) => (values[p.id] !== undefined ? { ...p, default: values[p.id] } : p)),
  };
}

/**
 * Structural fingerprint (layers + expressions, ignoring ids/labels/param
 * defaults). "Create something new" must not return a fingerprint already in
 * the library.
 */
export function fingerprint(program: EffectProgram): string {
  const shape = program.layers.map((l) =>
    [l.shape, l.count ?? 1, l.blend ?? "normal", l.x, l.y, l.r, l.w, l.h, l.x2, l.y2, l.width, l.alpha, l.glow].map((v) => String(v ?? "")).join("|")
  );
  return hash(shape.join("¦"));
}
