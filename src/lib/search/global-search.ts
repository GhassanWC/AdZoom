/**
 * Pure global-search helper consumed by the navbar's `NavbarSearch`
 * component. Takes a query string + the live arrays of projects /
 * presets / exports and returns a flat, scored, grouped result list.
 *
 * Pure function: no React, no Firestore, no DOM. The navbar owns the
 * subscriptions; this module owns the matching + ranking. Easy to
 * unit-test.
 */

import type { Preset, ProjectDoc, ExportDoc } from "@/lib/firebase/schema";

export type SearchResultKind = "project" | "preset" | "export";

export interface SearchResult {
  kind: SearchResultKind;
  id: string;
  /** Primary text shown in the row. */
  title: string;
  /** Secondary text shown under the title. Optional. */
  subtitle?: string;
  /** Where clicking the row navigates. */
  href: string;
  /** 0..1, higher = better match. Used for sorting within a kind. */
  score: number;
}

export interface SearchSources {
  projects: ProjectDoc[];
  builtinPresets: Preset[];
  customPresets: Preset[];
  exports: ExportDoc[];
}

/** Per-kind row cap so the dropdown stays scannable. */
const PER_KIND_CAP = 5;

/**
 * Run the search against all sources. Empty query returns an empty
 * array (the caller decides whether to surface "recent" entries
 * instead — search-helper stays a pure matcher).
 */
export function runGlobalSearch(
  rawQuery: string,
  sources: SearchSources
): SearchResult[] {
  const q = rawQuery.trim().toLowerCase();
  if (q.length === 0) return [];

  const projects = sources.projects
    .map((p) => matchProject(p, q))
    .filter((r): r is SearchResult => r !== null)
    .sort(byScoreThenTitle)
    .slice(0, PER_KIND_CAP);

  const presets = mergePresets(sources.builtinPresets, sources.customPresets)
    .map((p) => matchPreset(p, q))
    .filter((r): r is SearchResult => r !== null)
    .sort(byScoreThenTitle)
    .slice(0, PER_KIND_CAP);

  const exports = sources.exports
    .map((e) => matchExport(e, q))
    .filter((r): r is SearchResult => r !== null)
    .sort(byScoreThenTitle)
    .slice(0, PER_KIND_CAP);

  return [...projects, ...presets, ...exports];
}

/**
 * Group a flat list back into kinds for the dropdown. The component
 * needs the original flat list (for arrow-key focus index) AND the
 * grouped breakdown (for section headers); both are derived here.
 */
export function groupResults(
  results: SearchResult[]
): { kind: SearchResultKind; rows: SearchResult[] }[] {
  const groups: Record<SearchResultKind, SearchResult[]> = {
    project: [],
    preset: [],
    export: [],
  };
  for (const r of results) groups[r.kind].push(r);
  const order: SearchResultKind[] = ["project", "preset", "export"];
  return order
    .map((kind) => ({ kind, rows: groups[kind] }))
    .filter((g) => g.rows.length > 0);
}

// ── Matching helpers ────────────────────────────────────────────────────

function matchProject(p: ProjectDoc, q: string): SearchResult | null {
  const title = (p.title ?? "Untitled").trim() || "Untitled";
  const score = scoreText(title, q);
  if (score === 0) return null;
  return {
    kind: "project",
    id: p.id,
    title,
    subtitle: p.status ? `Status: ${p.status}` : undefined,
    href: `/dashboard/projects/${p.id}`,
    score,
  };
}

function matchPreset(p: Preset, q: string): SearchResult | null {
  const titleScore = scoreText(p.name, q);
  const categoryScore = scoreText(p.category, q) * 0.6;
  const descriptionScore = scoreText(p.description, q) * 0.5;
  const useCaseScore = scoreText(p.useCase ?? "", q) * 0.5;
  const score = Math.max(titleScore, categoryScore, descriptionScore, useCaseScore);
  if (score === 0) return null;
  const subtitle = [
    p.category,
    p.isCustom ? "Custom" : "Built-in",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    kind: "preset",
    id: p.id,
    title: p.name,
    subtitle,
    href: `/dashboard/presets?focus=${encodeURIComponent(p.id)}`,
    score,
  };
}

function matchExport(e: ExportDoc, q: string): SearchResult | null {
  const titleScore = scoreText(e.projectTitle ?? "Untitled", q);
  const formatScore = scoreText(e.format, q) * 0.5;
  const resolutionScore = scoreText(e.resolution, q) * 0.5;
  const score = Math.max(titleScore, formatScore, resolutionScore);
  if (score === 0) return null;
  return {
    kind: "export",
    id: e.id,
    title: e.projectTitle || "Untitled",
    subtitle: `${e.format} · ${e.resolution} · ${e.status}`,
    href: "/dashboard/exports",
    score,
  };
}

/**
 * Substring match with a positional bonus. Returns:
 *   1.0 — query is a prefix of the field
 *   0.7 — query is a substring elsewhere in the field
 *   0   — no match
 *
 * Case-insensitive. Empty fields never match.
 */
function scoreText(text: string, q: string): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return 0;
  return idx === 0 ? 1.0 : 0.7;
}

function byScoreThenTitle(a: SearchResult, b: SearchResult): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.title.localeCompare(b.title);
}

/**
 * De-dupe presets when a custom override shares the id with a built-in.
 * Custom wins so the user sees their tweaked version.
 */
function mergePresets(builtin: Preset[], custom: Preset[]): Preset[] {
  const seen = new Set<string>();
  const out: Preset[] = [];
  for (const p of custom) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  for (const p of builtin) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}
